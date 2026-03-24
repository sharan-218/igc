/**
 * JS Rendering Worker — Playwright-based headless browser pool.
 *
 * Architecture:
 * - BrowserPool manages N Chromium instances (default: 2)
 * - Each browser has its own context + page per job (no state leakage)
 * - Hard per-page timeout + explicit page.close() in finally = zero handle leaks
 * - Automatic browser restart on crash (respawn logic)
 * - Response size guard (same MAX_BODY_BYTES as HTTP fetcher)
 *
 * Memory safety:
 * - Pages and contexts are ALWAYS closed in finally blocks
 * - Browser instances are recycled (not recreated per-request) to save RAM
 * - Images/fonts/media are blocked (~40% memory + speed saving)
 * - Stylesheets are NOT blocked — some SPAs (Docsify, VuePress) need CSS
 *   to trigger rendering and populate navigation links
 *
 * SPA support:
 * - Waits for networkidle + a content-present heuristic before extracting HTML
 * - For hash-route URLs (/#/section), navigates to the full URL so the SPA
 *   router renders the correct section content
 */

import type { FetchResult } from "./fetch-page";
import { proxyPool } from "./proxy-pool";
import type { ProxyEntry } from "./proxy-pool";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 30_000;
const CONTENT_WAIT_MS = 3_000;   // extra settle time for slow SPAs
const BROWSER_POOL_SIZE = parseInt(process.env.JS_BROWSER_POOL_SIZE ?? "2", 10);

// ── Lazy playwright import (optional dep) ─────────────────────────────────────
async function getPlaywright() {
  try {
    const pw = await import("playwright");
    return pw.default ?? pw;
  } catch {
    return null;
  }
}

interface BrowserSlot {
  browser: import("playwright").Browser | null;
  inUse: boolean;
  crashCount: number;
  proxy: ProxyEntry | null;
}

// ── Browser Pool ──────────────────────────────────────────────────────────────
class BrowserPool {
  private slots: BrowserSlot[] = [];
  private initialized = false;
  private pw: Awaited<ReturnType<typeof getPlaywright>> = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.pw = await getPlaywright();
      if (!this.pw) {
        console.warn("[JSWorker] playwright not installed — JS rendering disabled");
        return;
      }

      this.slots = Array.from({ length: BROWSER_POOL_SIZE }, () => ({
        browser: null,
        inUse: false,
        crashCount: 0,
        proxy: null,
      }));

      await Promise.all(this.slots.map(slot => this.spawnBrowser(slot)));
      this.initialized = true;
    })();

    return this.initPromise;
  }

  private async spawnBrowser(slot: BrowserSlot): Promise<void> {
    if (!this.pw) return;
    try {
      slot.proxy = proxyPool.nextProxy();
      slot.browser = await this.pw.chromium.launch({
        headless: true,
        ...(slot.proxy ? { proxy: proxyPool.getPlaywrightProxy(slot.proxy) } : {}),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-extensions",
        ],
      });
    } catch (e) {
      console.error("[JSWorker] Failed to spawn browser:", e);
    }
  }

  private async acquireSlot(): Promise<BrowserSlot | null> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const free = this.slots.find(s => !s.inUse && s.browser);
      if (free) { free.inUse = true; return free; }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  private releaseSlot(slot: BrowserSlot): void {
    slot.inUse = false;
  }

  async renderPage(url: string): Promise<FetchResult> {
    await this.init();
    if (!this.pw || this.slots.length === 0) {
      return { url, statusCode: 0, html: null, networkError: true, errorMessage: "JS_RENDERING_UNAVAILABLE" };
    }

    const slot = await this.acquireSlot();
    if (!slot) {
      return { url, statusCode: 0, html: null, networkError: true, errorMessage: "JS_POOL_EXHAUSTED" };
    }

    let context: import("playwright").BrowserContext | null = null;
    let page: import("playwright").Page | null = null;

    try {
      const headers = proxyPool.nextHeaders();

      context = await slot.browser!.newContext({
        userAgent: headers["User-Agent"] ?? "Mozilla/5.0",
        extraHTTPHeaders: { "Accept-Language": headers["Accept-Language"] ?? "en-US,en;q=0.9" },
      });

      page = await context.newPage();

      // Block heavy resources but NOT stylesheets.
      // Docsify and similar SPAs require CSS to trigger rendering and
      // populate sidebar navigation links. Blocking it causes empty DOMs.
      await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "font", "media"].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      let statusCode = 200;
      page.on("response", (res) => {
        if (res.url() === url || res.url() === url + "/") statusCode = res.status();
      });

      // Navigate and wait for network to settle
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });

      // For SPAs: wait for a content container to appear in the DOM.
      // This handles frameworks that render after networkidle fires.
      try {
        await page.waitForFunction(
          () => {
            const body = document.body?.innerText?.trim() ?? "";
            return body.length > 200;
          },
          { timeout: CONTENT_WAIT_MS }
        );
      } catch {
        // Content didn't grow — proceed anyway with whatever rendered
      }

      const html = await page.content();

      if (Buffer.byteLength(html, "utf8") > MAX_BODY_BYTES) {
        return { url, statusCode, html: null, networkError: false, errorMessage: "BODY_TOO_LARGE" };
      }

      if (slot.proxy) proxyPool.markSuccess(slot.proxy);
      slot.crashCount = 0;
      return { url, statusCode, html, networkError: false, proxyUsed: slot.proxy?.url };

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (slot.proxy) proxyPool.markFailure(slot.proxy);
      slot.crashCount++;
      if (slot.crashCount >= 3) {
        try { await slot.browser?.close(); } catch {}
        slot.browser = null;
        slot.proxy = null;
        slot.crashCount = 0;
        this.spawnBrowser(slot).catch(() => {});
      }

      return { url, statusCode: 0, html: null, networkError: true, errorMessage: message };

    } finally {
      try { await page?.close(); } catch {}
      try { await context?.close(); } catch {}
      this.releaseSlot(slot);
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(
      this.slots.map(async s => {
        s.inUse = false;
        try { await s.browser?.close(); } catch {}
        s.browser = null;
        s.proxy = null;
      })
    );
  }
}

export const browserPool = new BrowserPool();

/**
 * Heuristics to decide if a URL likely needs JS rendering.
 *
 * Returns true when:
 *  - fetchPage returned no HTML at all
 *  - The HTML body has very little text (SPA shell)
 *  - The page contains an empty SPA root div
 *  - The URL is a known SPA hash-route (/#/...)
 *  - The URL matches common SPA framework patterns
 */
export function needsJsRendering(url: string, html: string | null): boolean {
  if (!html) return true;

  const textContent = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (textContent.length < 200) return true;

  // Empty SPA root containers
  if (/<div[^>]*id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;

  // Docsify signature: references docsify JS with little body content
  if (/docsify/i.test(html) && textContent.length < 2000) return true;

  // SPA hash-routes — always need JS to render the routed content
  if (/#\/[a-zA-Z]/.test(url)) return true;

  // Common SPA framework patterns in the URL
  const spaPatterns = [/\/app\//, /\/dashboard\//];
  return spaPatterns.some(p => p.test(url));
}
