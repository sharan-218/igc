export enum CrawlJobState {
  DISCOVERED = "discovered",
  QUEUED = "queued",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  RETRYING = "retrying",
  SKIPPED = "skipped"
}