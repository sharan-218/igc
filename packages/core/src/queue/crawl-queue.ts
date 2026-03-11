import { Queue } from "bullmq";
import { createRedisConnection } from "./connection";
import type { CrawlJob } from "../job";

/**
 * Queue uses its own dedicated Redis connection.
 * Never reuse the `redis` singleton for BullMQ primitives.
 */
export const crawlQueue = new Queue<CrawlJob>("crawl-queue", {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
