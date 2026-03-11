import { fetch, Agent } from "undici";

/**
 * A single shared undici Agent for the whole worker process.
 *
 * Undici manages a connection pool per origin internally. One Agent shared
 * across all jobs means TCP connections to the same host are reused across
 * jobs (HTTP keep-alive), which is dramatically faster than opening a new
 * TCP+TLS handshake for every request.
 *
 * pipelining: 1  — one request in flight per connection (safe default).
 * maxRedirections: 5 — follow up to 5 redirects automatically.
 * headersTimeout / bodyTimeout — hard wall-clock limits so a slow/stalled
 *   server never blocks a worker slot indefinitely.
 */
export const httpAgent = new Agent({
  pipelining: 1,
  maxRedirections: 5,
  headersTimeout: 15_000,
  bodyTimeout: 20_000,
  connectTimeout: 10_000,
});

export const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};
