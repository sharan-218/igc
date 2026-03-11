import {
  normalizeUrl,
  fingerprintUrl
} from "@core/url";

import { createCrawlJob } from "@core/job";
import { dispatchJob } from "./dispatch";

async function start() {

  const raw =
    "https://coinmarketcap.com/currencies/bitcoin/";

  const normalized = normalizeUrl(raw)!;
  const hash = await fingerprintUrl(normalized);

  const job = createCrawlJob({
    url: normalized,
    urlHash: hash,
    sessionId: "batch-test",
    domain: "coinmarketcap.com"
  });

  await dispatchJob(job);
}

start();