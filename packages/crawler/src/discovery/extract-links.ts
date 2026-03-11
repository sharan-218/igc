import * as cheerio from "cheerio";

/**
 * Extract all crawlable href values from an HTML string.
 *
 * Handles three link sources:
 *  1. Standard <a href="..."> tags (works for most sites)
 *  2. Docsify sidebar nav — links hidden inside <li><a> inside .sidebar-nav
 *     which are only present after JS rendering
 *  3. Hash-route deduplication — for SPA sites, /#/foo and /#/foo?id=bar
 *     are treated as the same route (query params stripped from hash routes)
 *
 * All relative hrefs are resolved against baseUrl.
 * Returns absolute URL strings; failed resolutions are silently dropped.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const links: string[] = [];

  function addLink(href: string | undefined) {
    if (!href) return;
    if (
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) return;

    try {
      const resolved = new URL(href, base);

      // For SPA hash-routes (/#/section), strip query params from the hash
      // part to avoid crawling the same section with different anchors
      if (resolved.hash.startsWith("#/")) {
        // Normalise: keep only the hash path, drop ?id=... within hash
        const hashPath = resolved.hash.split("?")[0];
        resolved.hash = hashPath ?? resolved.hash;
        resolved.search = "";
      }

      const key = resolved.href;
      if (!seen.has(key)) {
        seen.add(key);
        links.push(key);
      }
    } catch {
      // Invalid URL — skip silently
    }
  }

  // ── 1. All <a href> tags (covers normal sites + JS-rendered SPAs) ─────────
  $("a[href]").each((_i, el) => {
    addLink($(el).attr("href"));
  });

  // ── 2. Docsify-specific: sidebar nav links in <ul class="...app-nav..."> ──
  // After JS rendering Docsify populates .sidebar-nav and .app-nav
  $(".sidebar-nav a[href], .app-nav a[href], nav a[href]").each((_i, el) => {
    addLink($(el).attr("href"));
  });

  // ── 3. Docsify route discovery from window.__data__ / script tags ──────────
  // Docsify embeds the sidebar as a _sidebar.md fetch; we can also scrape
  // any href="#/..." patterns from inline script text as a fallback
  $("script:not([src])").each((_i, el) => {
    const text = $(el).html() ?? "";
    // Match patterns like: href="#/cloud" or path: '#/databases'
    const hashRoutes = text.matchAll(/["'](#\/[a-zA-Z0-9/_-]+)["']/g);
    for (const match of hashRoutes) {
      addLink(match[1]);
    }
  });

  return links;
}
