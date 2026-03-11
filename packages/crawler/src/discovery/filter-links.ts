/**
 * Filter a list of absolute URLs to only those that belong to the given
 * domain and are worth crawling.
 *
 * Rules:
 *  - Must be http or https
 *  - Hostname must exactly match baseDomain
 *  - SPA hash-routes (e.g. /#/cloud, /#getting-started) are KEPT as
 *    distinct crawlable pages — these are real content routes in Docsify,
 *    VuePress, React Router hash mode, etc.
 *  - Pure same-page fragment anchors (href="#", href="#top") with no
 *    meaningful path segment after # are dropped
 *  - Skip login / auth walls, non-HTML asset extensions
 */
export function filterLinks(links: string[], baseDomain: string): string[] {
  const SKIP_PATTERNS = [
    /\/login\b/i,
    /\/logout\b/i,
    /\/signin\b/i,
    /\/signup\b/i,
    /\/register\b/i,
    /\/auth\b/i,
    /\/account\b/i,
    /\/cart\b/i,
    /\/checkout\b/i,
  ];

  const SKIP_EXTENSIONS = new Set([
    ".pdf", ".zip", ".gz", ".tar", ".rar",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
    ".mp4", ".mp3", ".webm", ".ogg",
    ".css", ".js", ".json", ".xml",
    ".woff", ".woff2", ".ttf", ".eot",
  ]);

  return links.filter((link) => {
    try {
      const url = new URL(link);

      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (url.hostname !== baseDomain) return false;

      // Drop pure same-page anchor fragments: #, #top, #section-name
      // BUT keep SPA hash-routes that start with #/ (e.g. /#/cloud)
      if (url.hash && url.pathname === "/") {
        const fragment = url.hash.slice(1); // strip leading #
        if (!fragment || !fragment.startsWith("/")) {
          // "#" or "#some-anchor" — same page, no new content
          return false;
        }
        // "#/cloud" or "#/getting-started" — SPA route, keep it
      }

      // If there's no meaningful path AND no SPA hash-route, skip
      if (url.pathname === "/" && !url.search && !url.hash) {
        // root URL with no query/hash — allow (it's the home page)
        return true;
      }

      const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
      if (SKIP_EXTENSIONS.has(`.${ext}`)) return false;

      const fullPath = url.pathname + url.search;
      if (SKIP_PATTERNS.some((re) => re.test(fullPath))) return false;

      return true;
    } catch {
      return false;
    }
  });
}
