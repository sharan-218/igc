import { randomUUID } from "crypto";
import { CrawlJobSchema } from "./crawl-job";
import { CrawlJobState } from "./job-state";

export function createCrawlJob(input: {
  url: string;
  urlHash: string;
  sessionId: string;
  domain: string;
  depth?: number;
  maxDepth?: number;
  priority?: number;
}) {
  return CrawlJobSchema.parse({
    jobId:randomUUID(),
    url:input.url,
    urlHash:input.urlHash,
    domain:input.domain,
    sessionId:input.sessionId,
    depth:input.depth ?? 0,
    maxDepth:input.maxDepth ?? 3,
    priority:input.priority ?? 0,
    retryCount:0,
    maxRetries:3,
    state:CrawlJobState.DISCOVERED,
    createdAt:new Date(),
    updatedAt:new Date(),
  });
}
