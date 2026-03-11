import { redis } from "../queue/connection";

const DEFAULT_DOMAIN_DELAY_MS = 1_000;

/**
 * Per-domain rate limiter with configurable delay.
 *
 * Respects crawl-delay from robots.txt when provided.
 * Falls back to DEFAULT_DOMAIN_DELAY_MS.
 *
 * Uses Redis SET NX with a TTL equal to the delay so concurrent workers
 * across multiple processes all respect the same rate limit.
 */
export async function waitForDomain(
  domain: string,
  delayMs: number = DEFAULT_DOMAIN_DELAY_MS
): Promise<void> {
  const key = `domain:last:${domain}`;
  const effectiveDelay = Math.max(delayMs, DEFAULT_DOMAIN_DELAY_MS);

  while (true) {
    const last = await redis.get(key);
    const now = Date.now();

    if (!last || now - Number(last) >= effectiveDelay) {
      // Atomic SET with expiry so the key auto-cleans on redis restart
      await redis.set(key, now, "EX", Math.ceil(effectiveDelay / 1000) + 5);
      return;
    }

    const waitMs = effectiveDelay - (now - Number(last));
    await new Promise(r => setTimeout(r, Math.min(waitMs, 200)));
  }
}
