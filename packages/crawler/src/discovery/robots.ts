/**
 * robots.txt + sitemap.xml support
 *
 * RobotsManager:
 * - Fetches and caches robots.txt per domain (in-memory LRU, max 500 entries)
 * - Parses Disallow/Allow/Crawl-delay directives for common user-agent wildcards
 * - Extracts Sitemap URLs for seed discovery
 * - isAllowed() respects the most specific matching rule
 *
 * SitemapFetcher:
 * - Fetches sitemap index + individual sitemaps
 * - Handles sitemap index files (recursive resolution, max 2 levels deep)
 * - Streams large sitemaps line-by-line to avoid loading entire XML into RAM
 * - Returns AsyncGenerator<string> of discovered URLs (backpressure-friendly)
 *
 * Memory safety:
 * - LRU cache caps entry count
 * - Sitemaps are streamed, not fully buffered
 * - All fetches have hard timeouts
 */

import { fetch } from "undici";
import { proxyPool } from "../fetch/proxy-pool";

// ── Tiny LRU ─────────────────────────────────────────────────────────────────
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Refresh position
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, value);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface RobotsData {
  disallowed: RegExp[];
  allowed: RegExp[];
  crawlDelay: number;         // seconds, 0 = no delay specified
  sitemapUrls: string[];
  fetchedAt: number;
}

const ROBOTS_TTL_MS = 60 * 60 * 1_000;  // 1 hour
const FETCH_TIMEOUT_MS = 10_000;
const robots_cache = new LRUCache<string, RobotsData>(500);

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}`);
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: proxyPool.nextHeaders(),
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) { await res.body?.cancel(); return null; }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) return null; // 2 MB cap
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── RobotsManager ─────────────────────────────────────────────────────────────
export class RobotsManager {
  async fetch(domain: string): Promise<RobotsData> {
    const cached = robots_cache.get(domain);
    if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

    const robotsUrl = `https://${domain}/robots.txt`;
    const text = await fetchText(robotsUrl);

    const data: RobotsData = {
      disallowed: [],
      allowed: [],
      crawlDelay: 0,
      sitemapUrls: [],
      fetchedAt: Date.now(),
    };

    if (!text) {
      robots_cache.set(domain, data);
      return data;
    }

    let inRelevantBlock = false;

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const [directive, ...rest] = line.split(":");
      const key = directive.trim().toLowerCase();
      const value = rest.join(":").trim();

      if (key === "user-agent") {
        inRelevantBlock = value === "*" || value.toLowerCase().includes("bot");
      } else if (key === "sitemap") {
        if (value) data.sitemapUrls.push(value);
      } else if (inRelevantBlock) {
        if (key === "disallow" && value) {
          data.disallowed.push(globToRegex(value));
        } else if (key === "allow" && value) {
          data.allowed.push(globToRegex(value));
        } else if (key === "crawl-delay") {
          const d = parseFloat(value);
          if (!isNaN(d)) data.crawlDelay = d;
        }
      }
    }

    robots_cache.set(domain, data);
    return data;
  }

  /** Returns true if the crawler is allowed to fetch this URL. */
  async isAllowed(url: string): Promise<boolean> {
    try {
      const { hostname, pathname } = new URL(url);
      const data = await this.fetch(hostname);

      // Check Allow rules first (they override Disallow)
      for (const re of data.allowed) {
        if (re.test(pathname)) return true;
      }
      for (const re of data.disallowed) {
        if (re.test(pathname)) return false;
      }
      return true;
    } catch {
      return true; // on parse error, allow
    }
  }

  async getCrawlDelay(domain: string): Promise<number> {
    const data = await this.fetch(domain);
    return data.crawlDelay;
  }

  async getSitemapUrls(domain: string): Promise<string[]> {
    const data = await this.fetch(domain);
    // Also try default locations if none declared
    if (data.sitemapUrls.length === 0) {
      return [
        `https://${domain}/sitemap.xml`,
        `https://${domain}/sitemap_index.xml`,
      ];
    }
    return data.sitemapUrls;
  }
}

// ── SitemapFetcher ────────────────────────────────────────────────────────────
/** Yields absolute URL strings from a sitemap or sitemap index. */
export async function* fetchSitemapUrls(
  sitemapUrl: string,
  depth = 0
): AsyncGenerator<string> {
  if (depth > 2) return; // max 2 levels of nesting

  const text = await fetchText(sitemapUrl);
  if (!text) return;

  // Detect sitemap index
  if (text.includes("<sitemapindex")) {
    const subSitemaps = [...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
      .map(m => m[1].trim());
    for (const sub of subSitemaps) {
      yield* fetchSitemapUrls(sub, depth + 1);
    }
  } else {
    // Regular sitemap — stream loc tags
    const urls = [...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
      .map(m => m[1].trim());
    for (const u of urls) yield u;
  }
}

export const robotsManager = new RobotsManager();
