import chalk from "chalk";

import { crawlQueue } from "../packages/core/src/queue/crawl-queue";
import { normalizeUrl, fingerprintUrl } from "../packages/core/src/url";
import { createCrawlJob } from "../packages/core/src/job";

const RAW_URL = process.argv[2]!;
async function seed() {
  const normalized = normalizeUrl(RAW_URL);
  if (!normalized) {
    console.error(chalk.bgRed.white.bold(` Invalid URL provided: ${RAW_URL} `));
    process.exit(1);
  }

  const hash = await fingerprintUrl(normalized);
  const domain = new URL(normalized).hostname;

  const crawlJob = createCrawlJob({
    url: normalized,
    urlHash: hash,
    sessionId: "seed",
    domain,
    depth: 0,
    maxDepth: 3,
  });

  console.log(chalk.greenBright.bold("\n Seeding job: "));
  console.log(`${chalk.dim("url    :")} ${chalk.cyan(` ${normalized} `)}`);
  console.log(`${chalk.dim("domain :")} ${chalk.yellow(` ${domain} `)}`);
  console.log(`${chalk.dim("jobId  :")} ${chalk.magenta(` ${crawlJob.jobId} `)}`);

  await crawlQueue.add("crawl", crawlJob, { jobId: crawlJob.jobId });
  
  console.log(chalk.greenBright.bold("\n Done. Start the worker to process it: "));
  console.log(chalk.whiteBright.bold(` bun run dev:crawler `) + "\n");

  await crawlQueue.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error(chalk.bgRed.white.bold("\n Seed failed: "), err);
  process.exit(1);
});
