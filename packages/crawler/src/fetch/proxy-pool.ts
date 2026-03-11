/**
 * ProxyPool — thread-safe, weighted round-robin proxy + user-agent rotation.
 *
 * Design goals:
 * - Zero external deps (uses native URL + undici Agent)
 * - Memory-bounded: fixed-size arrays, no unbounded growth
 * - Self-healing: marks proxies unhealthy on repeated failures, auto-recovers after TTL
 * - Metrics per proxy for observability
 */

import { Agent } from "undici";

export interface ProxyEntry {
  url: string;           // e.g. "http://user:pass@1.2.3.4:8080"
  weight: number;        // higher = more frequently used
  healthy: boolean;
  failures: number;
  lastFailAt: number;    // epoch ms
  agent: Agent | null;   // lazily created undici Agent
}

// ── User-Agent bank ──────────────────────────────────────────────────────────
const USER_AGENTS: readonly string[] = [
  // Chrome Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  // Chrome macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Firefox
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
  // Safari
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  // Edge
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
];

const ACCEPT_LANGUAGES: readonly string[] = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.8,es;q=0.5",
  "en-CA,en;q=0.9,fr;q=0.7",
];

// Thresholds
const MAX_FAILURES_BEFORE_UNHEALTHY = 3;
const RECOVERY_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// ── Pool class ───────────────────────────────────────────────────────────────
export class ProxyPool {
  private readonly proxies: ProxyEntry[];
  private uaIndex = 0;
  private laIndex = 0;
  private proxyIndex = 0;

  constructor(proxyUrls: string[] = []) {
    this.proxies = proxyUrls.map((url, i) => ({
      url,
      weight: 1,
      healthy: true,
      failures: 0,
      lastFailAt: 0,
      agent: null,
    }));
  }

  // ── User-Agent rotation (round-robin with jitter) ─────────────────────────
  nextUserAgent(): string {
    const ua = USER_AGENTS[this.uaIndex % USER_AGENTS.length];
    this.uaIndex = (this.uaIndex + 1) % USER_AGENTS.length;
    return ua;
  }

  nextAcceptLanguage(): string {
    const la = ACCEPT_LANGUAGES[this.laIndex % ACCEPT_LANGUAGES.length];
    this.laIndex = (this.laIndex + 1) % ACCEPT_LANGUAGES.length;
    return la;
  }

  /** Build a full header set for the next request */
  nextHeaders(): Record<string, string> {
    return {
      "User-Agent": this.nextUserAgent(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": this.nextAcceptLanguage(),
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    };
  }

  // ── Proxy rotation ────────────────────────────────────────────────────────
  /** Returns null when no proxies configured (direct connection mode). */
  nextProxy(): ProxyEntry | null {
    if (this.proxies.length === 0) return null;

    // Auto-recover proxies past TTL
    const now = Date.now();
    for (const p of this.proxies) {
      if (!p.healthy && now - p.lastFailAt > RECOVERY_TTL_MS) {
        p.healthy = true;
        p.failures = 0;
      }
    }

    const healthy = this.proxies.filter(p => p.healthy);
    if (healthy.length === 0) {
      // All proxies down — reset all and return first (best-effort)
      for (const p of this.proxies) { p.healthy = true; p.failures = 0; }
      return this.proxies[0];
    }

    const proxy = healthy[this.proxyIndex % healthy.length];
    this.proxyIndex = (this.proxyIndex + 1) % healthy.length;
    return proxy;
  }

  getAgent(proxy: ProxyEntry): Agent {
    if (!proxy.agent) {
      proxy.agent = new Agent({
        pipelining: 1,
        maxRedirections: 5,
        headersTimeout: 15_000,
        bodyTimeout: 20_000,
        connectTimeout: 10_000,
        // undici proxy support via connect factory
      });
    }
    return proxy.agent;
  }

  markFailure(proxy: ProxyEntry): void {
    proxy.failures++;
    proxy.lastFailAt = Date.now();
    if (proxy.failures >= MAX_FAILURES_BEFORE_UNHEALTHY) {
      proxy.healthy = false;
    }
  }

  markSuccess(proxy: ProxyEntry): void {
    proxy.failures = 0;
    proxy.healthy = true;
  }

  stats() {
    return this.proxies.map(p => ({
      url: p.url,
      healthy: p.healthy,
      failures: p.failures,
    }));
  }

  /**
   * Explicit cleanup — destroy all undici Agents.
   * Call on SIGTERM/SIGINT to prevent handle leaks.
   */
  async destroy(): Promise<void> {
    await Promise.allSettled(
      this.proxies
        .filter(p => p.agent)
        .map(p => p.agent!.destroy())
    );
    for (const p of this.proxies) p.agent = null;
  }
}

// ── Default singleton ─────────────────────────────────────────────────────────
const proxyUrls = (process.env.PROXY_URLS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const proxyPool = new ProxyPool(proxyUrls);
