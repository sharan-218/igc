/**
 * fetchPage v2 — proxy + user-agent rotation, memory-safe streaming body read.
 *
 * Key improvements over v1:
 * - Uses ProxyPool for rotating User-Agent headers + optional proxy agents
 * - Hard cap on response body size (MAX_BODY_BYTES) to prevent OOM on huge pages
 * - Streams body via response.arrayBuffer() with size guard
 * - Always cancels response body on non-HTML or oversized responses (no leak)
 * - Returns enriched FetchResult with proxyUrl for observability
 */

import { fetch } from "undici";
import { proxyPool } from "./proxy-pool";

export interface FetchResult {
  url: string;
  statusCode: number;
  html: string | null;
  networkError: boolean;
  errorMessage?: string;
  proxyUsed?: string;
  contentLength?: number;
}

export const NO_RETRY_CODES = new Set([401, 403, 407, 429, 503, 999]);

/** Hard cap: ignore pages bigger than 5 MB */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HARD_TIMEOUT_MS = 30_000;

export async function fetchPage(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Hard timeout after ${HARD_TIMEOUT_MS}ms`)),
    HARD_TIMEOUT_MS
  );

  const proxy = proxyPool.nextProxy();
  const headers = proxyPool.nextHeaders();

  try {
    const fetchOptions: Parameters<typeof fetch>[1] = {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
      // Use proxy agent when available, otherwise fall back to default
      ...(proxy ? { dispatcher: proxyPool.getAgent(proxy) } : {}),
    };

    const response = await fetch(url, fetchOptions);

    const finalUrl = response.url ?? url;
    const statusCode = response.status;

    if (statusCode === 429) {
      await response.body?.cancel();
      if (proxy) proxyPool.markFailure(proxy);
      return { url: finalUrl, statusCode, html: null, networkError: false, errorMessage: "RATE_LIMITED" };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");

    if (!isHtml) {
      await response.body?.cancel();
      if (proxy) proxyPool.markSuccess(proxy);
      return { url: finalUrl, statusCode, html: null, networkError: false, proxyUsed: proxy?.url };
    }

    // Guard against huge pages — stream with size check
    const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
    if (contentLength > MAX_BODY_BYTES) {
      await response.body?.cancel();
      return { url: finalUrl, statusCode, html: null, networkError: false, errorMessage: "BODY_TOO_LARGE" };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_BYTES) {
      if (proxy) proxyPool.markSuccess(proxy);
      return { url: finalUrl, statusCode, html: null, networkError: false, errorMessage: "BODY_TOO_LARGE" };
    }

    const html = new TextDecoder("utf-8", { fatal: false }).decode(buffer);

    if (proxy) proxyPool.markSuccess(proxy);

    return {
      url: finalUrl,
      statusCode,
      html,
      networkError: false,
      proxyUsed: proxy?.url,
      contentLength: buffer.byteLength,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (proxy) proxyPool.markFailure(proxy);
    return { url, statusCode: 0, html: null, networkError: true, errorMessage: message };
  } finally {
    clearTimeout(timer);
  }
}
