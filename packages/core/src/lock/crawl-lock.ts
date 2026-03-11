import { redis } from "../queue/connection";

const LOCK_TTL_SECONDS = 300;

export async function acquireCrawlLock(urlHash: string): Promise<boolean> {
  const key = `crawl:lock:${urlHash}`;
  const result = await redis.set(key, "locked", "NX", "EX", LOCK_TTL_SECONDS);
  return result === "OK";
}

export async function releaseCrawlLock(urlHash: string): Promise<void> {
  await redis.del(`crawl:lock:${urlHash}`);
}
