/**
 * Content extraction v2 — AI/RAG/LLM ready output.
 *
 * Extracts:
 *  - Main article text (via Readability)
 *  - Quality score (our scoring module)
 *  - Text chunks with metadata (for vector DBs)
 *  - Structured metadata (title, description, OG tags, schema.org dates)
 *  - Language detection hint
 *
 * Memory safety:
 *  - JSDOM is constructed with { runScripts: "outside-only" } = no script exec
 *  - dom.window is explicitly set to null after use to release the JSDOM heap
 *  - Large HTML is truncated before JSDOM parsing (5 MB cap inherited from fetcher)
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { scoreContent, passesQualityGate, type QualityScore } from "./quality";
import { chunkText, type TextChunk, type ChunkingOptions } from "./chunker";

export interface ExtractedContent {
  // Core text
  title: string | null;
  content: string | null;
  excerpt: string | null;
  length: number;

  // Metadata
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  lang: string | null;
  ogImage: string | null;

  // AI pipeline outputs
  qualityScore: QualityScore | null;
  passesQualityGate: boolean;
  chunks: TextChunk[];          // empty if passesQualityGate is false
  wordCount: number;
  readingTimeMinutes: number;
}

function extractMeta(document: Document) {
  const getMeta = (selectors: string[]): string | null => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const val = el?.getAttribute("content") ?? el?.getAttribute("datetime") ?? el?.textContent;
      if (val?.trim()) return val.trim();
    }
    return null;
  };

  return {
    description: getMeta(['meta[name="description"]', 'meta[property="og:description"]']),
    author: getMeta(['meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]']),
    publishedAt: getMeta([
      'meta[property="article:published_time"]',
      'time[itemprop="datePublished"]',
      '[itemprop="datePublished"]',
      'time[pubdate]',
    ]),
    modifiedAt: getMeta([
      'meta[property="article:modified_time"]',
      'time[itemprop="dateModified"]',
    ]),
    ogImage: getMeta(['meta[property="og:image"]']),
    lang: document.documentElement.getAttribute("lang"),
  };
}

export function extractMainContent(
  html: string,
  pageUrl: string,
  chunkingOptions?: ChunkingOptions
): ExtractedContent {

  // ── JSDOM parse ────────────────────────────────────────────────────────────
  let dom: JSDOM | null = null;

  try {
    dom = new JSDOM(html, {
      url: pageUrl,
      // Never execute scripts — critical for memory + security
      runScripts: "outside-only",
      pretendToBeVisual: false,
      resources: "usable",
    });

    const document = dom.window.document;
    const meta = extractMeta(document);

    // ── Readability ────────────────────────────────────────────────────────
    const reader = new Readability(document, {
      charThreshold: 100,
      keepClasses: false,
    });

    const article = reader.parse();

    const content = article?.textContent?.trim() ?? null;
    const title = article?.title?.trim() ?? null;
    const excerpt = article?.excerpt?.trim() ?? null;
    const length = article?.length ?? 0;

    const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    // ── Quality scoring ────────────────────────────────────────────────────
    let qualityScore: QualityScore | null = null;
    let passes = false;
    let chunks: TextChunk[] = [];

    if (content && content.length > 0) {
      qualityScore = scoreContent(content, html, {
        title: title ?? undefined,
        description: meta.description ?? undefined,
        publishedAt: meta.publishedAt,
      });
      passes = passesQualityGate(qualityScore);

      // ── Chunking (only for content that passes quality gate) ────────────
      if (passes) {
        const domain = new URL(pageUrl).hostname;
        chunks = chunkText(
          content,
          { url: pageUrl, domain, title: title ?? "" },
          chunkingOptions
        );
      }
    }

    return {
      title,
      content,
      excerpt,
      length,
      description: meta.description,
      author: meta.author,
      publishedAt: meta.publishedAt,
      modifiedAt: meta.modifiedAt,
      lang: meta.lang,
      ogImage: meta.ogImage,
      qualityScore,
      passesQualityGate: passes,
      chunks,
      wordCount,
      readingTimeMinutes,
    };

  } finally {
    // Explicitly release JSDOM memory
    if (dom) {
      try {
        // Close the window to release event listeners and DOM nodes
        dom.window.close();
      } catch {}
      dom = null;
    }
  }
}
