import {
  normalizeUrl,
  fingerprintUrl
} from "@core/url";

import { createCrawlJob } from "@core/job";

async function testJob() {

  const raw =
    "https://x.com/MaximeMB_/status/2025885106645393498?s=20";

  const normalized = normalizeUrl(raw)!;
  const hash = await fingerprintUrl(normalized);

  const job = createCrawlJob({
    url: normalized,
    urlHash: hash,
    sessionId: "batch-test",
    domain: "x.com"
  });

  console.log(job);
}

testJob();