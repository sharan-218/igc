import { crawlQueue } from "@core/queue";
import { CrawlJobState } from "@core/job";
import type { CrawlJob } from "@core/job";
import chalk from "chalk";

export async function dispatchJob(
  job: CrawlJob
) {

  await crawlQueue.add(
    job.jobId,
    job,
    {
      priority: job.priority,
      attempts: job.maxRetries,
    //   removeOnComplete: true,
      removeOnFail: false
    }
  );

  job.state = CrawlJobState.QUEUED;

  console.log(
    `${chalk.bgBlue.white.bold(" Dispatched job ")} → ${chalk.bgCyan.black(` ${job.url} `)}`
  );
}