import { z } from "zod";
import { CrawlJobState } from "./job-state";

export const CrawlJobSchema = z.object({
  jobId:z.string(),
  url:z.string().url(),
  urlHash:z.string(),
  domain:z.string(),
  sessionId:z.string(),
  depth:z.number().default(0),
  maxDepth:z.number().int().min(0).default(3),
  priority:z.number().default(0),
  retryCount:z.number().default(0),
  maxRetries:z.number().default(3),
  state:z.nativeEnum(CrawlJobState),
  createdAt:z.date(),
  updatedAt:z.date(),
});

export type CrawlJob = z.infer<typeof CrawlJobSchema>;
