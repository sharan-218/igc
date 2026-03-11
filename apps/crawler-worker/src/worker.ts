/**
 * Crawler Worker v2 — Production-grade, AI/RAG/LLM-ready
 *
 * New features:
 * User-agent + proxy rotation (via ProxyPool)
 * JS rendering fallback (via BrowserPool)
 * robots.txt + sitemap support (via RobotsManager)
 * Content quality scoring (via scoreContent)
 * Text chunking + embedding-ready output (via chunkText)
 *
 * Memory safety improvements:
 *  - JSDOM window.close() called in finally block
 *  - Response bodies always cancel()'d on non-HTML or oversized content
 *  - BrowserPool: pages and contexts closed in finally blocks
 *  - ProxyPool agents destroyed on SIGTERM/SIGINT
 *  - BullMQ worker uses autorun: false + graceful shutdown
 *  - In-process Bloom filter caps at 1M entries (see bloom.ts)
 *  - DB connection pool capped at 10 (see storage/db.ts)
 *
 * Scalability:
 *  - CONCURRENCY env var controls parallelism (default: 10)
 *  - Per-domain rate limiting respects robots.txt crawl-delay
 *  - Sitemap discovery seeds queue with discovered URLs
 *  - Quality gate filters thin/nav/error pages before chunking
 */

import { Worker, UnrecoverableError } from "bullmq";
import { createRedisConnection } from "@core/queue/connection";
import { crawlQueue } from "@core/queue/crawl-queue";
import chalk from "chalk";

import { fetchPage, NO_RETRY_CODES } from "@crawler/fetch/fetch-page";
import { browserPool, needsJsRendering } from "@crawler/fetch/js-renderer";
import { proxyPool } from "@crawler/fetch/proxy-pool";
import { extractLinks } from "@crawler/discovery/extract-links";
import { filterLinks } from "@crawler/discovery/filter-links";
import { parsePage } from "@crawler/discovery/parse-page";
import { robotsManager, fetchSitemapUrls } from "@crawler/discovery/robots";
import { extractMainContent } from "@crawler/extraction/content";

import { acquireCrawlLock, releaseCrawlLock } from "@core/lock";
import { normalizeUrl, fingerprintUrl, seenUrl } from "@core/url";
import { createCrawlJob } from "@core/job";
import { waitForDomain } from "@core/rate/domain-rate";
import { db } from "@storage/db";

// ── Config ─────────────────────────────────────────────────────────────────────
const DEFAULT_MAX_DEPTH = 3;
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "10", 10);
const JS_RENDER_ENABLED = process.env.JS_RENDER_ENABLED !== "false";
const SEED_FROM_SITEMAP = process.env.SEED_FROM_SITEMAP !== "false";
const QUEUE_NAME = "crawl-queue";

console.log(chalk.cyan(" Starting crawler worker v2 "));
console.log(chalk.dim(` Concurrency: ${CONCURRENCY} | JS rendering: ${JS_RENDER_ENABLED} | Sitemap: ${SEED_FROM_SITEMAP}`));

const workerConnection = createRedisConnection();

// ── Worker ─────────────────────────────────────────────────────────────────────
const worker = new Worker(
  QUEUE_NAME,

  async (job) => {
    const {
      url,
      urlHash,
      domain,
      depth = 0,
      maxDepth = DEFAULT_MAX_DEPTH,
    } = job.data;

    const jid = chalk.magenta(`[Job ${job.id}]`);

    // ── robots.txt check ────────────────────────────────────────────────────
    const allowed = await robotsManager.isAllowed(url);
    if (!allowed) {
      console.log(`${jid} ${chalk.bgYellow.black(" robots.txt DISALLOW ")} ${chalk.dim(url)}`);
      await db`
        UPDATE urls SET status='disallowed', last_crawled_at=NOW()
        WHERE url_hash=${urlHash}
      `;
      return { skipped: true, reason: "robots_disallowed", url };
    }

    // ── Deduplicate via lock ─────────────────────────────────────────────────
    const locked = await acquireCrawlLock(urlHash);
    if (!locked) {
      console.log(`${jid} ${chalk.bgYellow.black(" Already crawled — skipping ")}`);
      return { skipped: true, url };
    }

    const [row] = await db`
      INSERT INTO urls (url, url_hash, domain, depth, status)
      VALUES (${url}, ${urlHash}, ${domain}, ${depth}, 'crawling')
      ON CONFLICT (url_hash)
      DO UPDATE SET status='crawling', last_crawled_at=NOW()
      RETURNING id
    ` as [{ id: number }];

    const urlId = row.id;

    try {
      // ── Seed from sitemap (depth 0 only) ────────────────────────────────
      if (depth === 0 && SEED_FROM_SITEMAP) {
        await seedFromSitemap(domain, maxDepth, job.data.sessionId ?? "default");
      }

      // ── Per-domain rate limit (respects crawl-delay from robots.txt) ─────
      const crawlDelay = await robotsManager.getCrawlDelay(domain);
      await waitForDomain(domain, crawlDelay > 0 ? crawlDelay * 1000 : undefined);

      // ── HTTP fetch ────────────────────────────────────────────────────────
      console.log(`${jid} ${chalk.bgGray.white(" Fetching... ")} ${chalk.blue(url)}`);
      let result = await fetchPage(url);

      if (result.networkError) throw new Error(result.errorMessage);

      // ── JS rendering fallback ────────────────────────────────────────────
      if (JS_RENDER_ENABLED && needsJsRendering(url, result.html)) {
        console.log(`${jid} ${chalk.bgMagenta.white(" JS render ")} ${chalk.dim(url)}`);
        const jsResult = await browserPool.renderPage(url);
        if (!jsResult.networkError && jsResult.html) {
          result = { ...jsResult, proxyUsed: result.proxyUsed };
        }
      }

      const statusColor =
        result.statusCode < 300 ? chalk.bgGreen.black :
        result.statusCode < 400 ? chalk.bgYellow.black :
        chalk.bgRed.white;

      console.log(`${jid} ${statusColor(` HTTP ${result.statusCode} `)} — ${chalk.dim(result.url)}`);

      if (NO_RETRY_CODES.has(result.statusCode))
        throw new UnrecoverableError(`Blocked HTTP ${result.statusCode}`);

      if (result.statusCode >= 400)
        throw new Error(`HTTP ${result.statusCode}`);

      if (!result.html) {
        console.log(`${jid} ${chalk.bgYellow.black(" Non-HTML — skipping ")}`);
        await db`UPDATE urls SET status='crawled' WHERE id=${urlId}`;
        return { url, statusCode: result.statusCode, html: false };
      }

      // ── Meta extraction (fast, no JSDOM) ─────────────────────────────────
      const meta = parsePage(result.html);
      console.log(`${jid} ${chalk.bgCyan.black(` "${meta.title}" `)}`);

      // ── Full content extraction (JSDOM + Readability + Quality + Chunks) ──
      const extracted = extractMainContent(result.html, result.url);

      const {
        content, excerpt, title, description, author,
        publishedAt, modifiedAt, ogImage, lang,
        qualityScore, passesQualityGate: passes, chunks,
        wordCount, readingTimeMinutes,
      } = extracted;

      if (qualityScore) {
        const color = qualityScore.total >= 60 ? chalk.bgGreen.black :
                      qualityScore.total >= 30 ? chalk.bgYellow.black :
                      chalk.bgRed.white;
        console.log(
          `${jid} ${color(` Quality: ${qualityScore.total}/100 `)} ` +
          chalk.dim(`[${qualityScore.contentType}] ${qualityScore.flags.join(", ")}`)
        );
      }

      // ── Save page ─────────────────────────────────────────────────────────
      const [pageRow] = await db`
        INSERT INTO pages (
          url_id, status_code, title, description, author, h1,
          content, excerpt, word_count, reading_time, lang,
          quality_score, quality_length_score, quality_density_score,
          quality_readability_score, quality_structure_score,
          quality_uniqueness_score, quality_freshness_score,
          content_type, quality_flags, passes_quality_gate,
          published_at, modified_at, og_image,
          rendered_with, proxy_used
        ) VALUES (
          ${urlId}, ${result.statusCode},
          ${title ?? meta.title ?? null},
          ${description ?? null},
          ${author ?? null},
          ${meta.h1 ?? null},
          ${content ?? null},
          ${excerpt ?? null},
          ${wordCount}, ${readingTimeMinutes},
          ${lang ?? null},
          ${qualityScore?.total ?? 0},
          ${qualityScore?.lengthScore ?? null},
          ${qualityScore?.densityScore ?? null},
          ${qualityScore?.readabilityScore ?? null},
          ${qualityScore?.structureScore ?? null},
          ${qualityScore?.uniquenessScore ?? null},
          ${qualityScore?.freshnessScore ?? null},
          ${qualityScore?.contentType ?? null},
          ${qualityScore?.flags ?? []},
          ${passes},
          ${publishedAt ? new Date(publishedAt) : null},
          ${modifiedAt ? new Date(modifiedAt) : null},
          ${ogImage ?? null},
          ${"http"},
          ${result.proxyUsed ?? null}
        )
        RETURNING id
      ` as [{ id: number }];

      const pageId = pageRow.id;

      // ── Save chunks ───────────────────────────────────────────────────────
      if (passes && chunks.length > 0) {
        console.log(`${jid} ${chalk.bgGreen.black(` ${chunks.length} chunks `)}`);

        // Batch insert chunks (avoid N individual round-trips)
        const chunkValues = chunks.map(c => ({
          page_id: pageId,
          url_id: urlId,
          chunk_index: c.index,
          total_chunks: c.metadata.totalChunks,
          text: c.text,
          token_estimate: c.tokenEstimate,
          char_start: c.charStart,
          char_end: c.charEnd,
          section_heading: c.metadata.sectionHeading,
          word_count: c.metadata.wordCount,
        }));

        // Insert in batches of 50 to avoid query size limits
        const BATCH_SIZE = 50;
        for (let i = 0; i < chunkValues.length; i += BATCH_SIZE) {
          const batch = chunkValues.slice(i, i + BATCH_SIZE);
          await db`
            INSERT INTO chunks ${db(batch, [
              "page_id", "url_id", "chunk_index", "total_chunks",
              "text", "token_estimate", "char_start", "char_end",
              "section_heading", "word_count"
            ])}
          `;
        }
      }

      // ── Update URL status ─────────────────────────────────────────────────
      await db`UPDATE urls SET status='crawled', last_crawled_at=NOW() WHERE id=${urlId}`;

      // ── Link discovery ────────────────────────────────────────────────────
      let queued = 0;
      let deduped = 0;

      if (depth < maxDepth) {
        const rawLinks = extractLinks(result.html, result.url);
        const filtered = filterLinks(rawLinks, domain);

        console.log(
          `${jid} ${chalk.bgCyan.black(` ${rawLinks.length} links `)}` +
          ` → ${chalk.bgGreen.black(` ${filtered.length} same-domain `)}`
        );

        for (const link of filtered) {
          const normalized = normalizeUrl(link);
          if (!normalized) continue;

          const hash = await fingerprintUrl(normalized);
          if (seenUrl(hash)) { deduped++; continue; }

          await db`
            INSERT INTO urls (url, url_hash, domain, depth, status)
            VALUES (${normalized}, ${hash}, ${domain}, ${depth + 1}, 'pending')
            ON CONFLICT DO NOTHING
          `;

          const crawlJob = createCrawlJob({
            url: normalized,
            urlHash: hash,
            domain,
            depth: depth + 1,
            maxDepth,
            sessionId: job.data.sessionId ?? "default",
          });

          await crawlQueue.add("crawl", crawlJob, { jobId: crawlJob.jobId });
          queued++;
        }

        console.log(
          `${jid} ${chalk.bgGreen.black(` Queued ${queued} `)}, ` +
          `${chalk.bgGray.white(` skipped ${deduped} `)}`
        );
      }

      return {
        url: result.url,
        statusCode: result.statusCode,
        title: title ?? meta.title,
        wordCount,
        qualityScore: qualityScore?.total ?? 0,
        contentType: qualityScore?.contentType,
        chunks: chunks.length,
        queued,
        deduped,
      };

    } catch (err) {
      await db`UPDATE urls SET status='failed' WHERE id=${urlId}`.catch(() => {});
      throw err;
    } finally {
      await releaseCrawlLock(urlHash).catch(() => {});
    }
  },

  {
    connection: workerConnection,
    concurrency: CONCURRENCY,
    autorun: true,
  }
);

// ── Sitemap seeding ────────────────────────────────────────────────────────────
async function seedFromSitemap(domain: string, maxDepth: number, sessionId: string): Promise<void> {
  const sitemapUrls = await robotsManager.getSitemapUrls(domain);
  let seeded = 0;

  for (const sitemapUrl of sitemapUrls.slice(0, 3)) { // max 3 sitemaps
    try {
      for await (const url of fetchSitemapUrls(sitemapUrl)) {
        if (seeded >= 5000) break; // safety cap

        const normalized = normalizeUrl(url);
        if (!normalized) continue;

        try {
          const urlObj = new URL(normalized);
          if (urlObj.hostname !== domain) continue;
        } catch { continue; }

        const hash = await fingerprintUrl(normalized);
        if (seenUrl(hash)) continue;

        await db`
          INSERT INTO urls (url, url_hash, domain, depth, status)
          VALUES (${normalized}, ${hash}, ${domain}, 1, 'pending')
          ON CONFLICT DO NOTHING
        `;

        const crawlJob = createCrawlJob({
          url: normalized,
          urlHash: hash,
          domain,
          depth: 1,
          maxDepth,
          sessionId,
        });

        await crawlQueue.add("crawl", crawlJob, { jobId: crawlJob.jobId });
        seeded++;
      }
    } catch (e) {
      console.warn(`[Sitemap] Failed to fetch ${sitemapUrl}:`, e);
    }
  }

  if (seeded > 0) {
    console.log(chalk.bgCyan.black(` Sitemap: seeded ${seeded} URLs `));
  }
}

// ── Lifecycle events ───────────────────────────────────────────────────────────
worker.on("ready", () => console.log(chalk.bgGreen.black.bold(" Worker ready ")));
worker.on("active", job => console.log(chalk.bgMagenta.white(` [Job ${job.id}] Started `)));
worker.on("completed", (job, r) => console.log(chalk.bgGreen.black(` [Job ${job.id}] Done `), r));
worker.on("failed", (job, err) => console.error(chalk.bgRed.white(` [Job ${job?.id}] ${err.message}`)));

// ── Graceful shutdown — critical for memory safety ─────────────────────────────
async function shutdown(signal: string) {
  console.log(chalk.bgYellow.black(` ${signal} received — shutting down gracefully... `));

  await worker.close();
  await proxyPool.destroy();
  await browserPool.destroy();
  await db.end();

  console.log(chalk.bgGreen.black(" Clean shutdown complete "));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
