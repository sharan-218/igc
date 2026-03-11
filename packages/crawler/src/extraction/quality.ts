/**
 * Content quality scoring for AI/RAG/LLM pipelines.
 *
 * Produces a normalized 0–100 score across 6 dimensions:
 *  1. Length      — penalize stubs, reward substantive content
 *  2. Density     — text-to-markup ratio, with a floor for JS-rendered pages
 *  3. Readability — Automated Readability Index (ARI) approximation
 *  4. Structure   — heading hierarchy, paragraphs, lists
 *  5. Uniqueness  — rough n-gram duplicate/boilerplate signal
 *  6. Freshness   — presence of dated metadata
 *
 * Density scoring is JS-render aware: Playwright output includes a large
 * HTML boilerplate frame (head, scripts, styles) that inflates htmlLen and
 * makes the ratio look deceptively low. We use the extracted text length
 * relative to an estimated "content HTML" size rather than total HTML.
 *
 * Content type classification:
 *  "article" | "product" | "navigation" | "error" | "thin" | "rich" | "docs"
 */

export interface QualityScore {
  total: number;
  lengthScore: number;
  densityScore: number;
  readabilityScore: number;
  structureScore: number;
  uniquenessScore: number;
  freshnessScore: number;
  contentType: ContentType;
  wordCount: number;
  sentenceCount: number;
  avgWordsPerSentence: number;
  flags: QualityFlag[];
}

export type ContentType = "article" | "product" | "navigation" | "error" | "thin" | "rich" | "docs";
export type QualityFlag =
  | "STUB_CONTENT"
  | "BOILERPLATE_HEAVY"
  | "NAVIGATION_PAGE"
  | "ERROR_PAGE"
  | "NO_HEADINGS"
  | "WALL_OF_TEXT"
  | "LOW_TEXT_DENSITY"
  | "MACHINE_GENERATED_SUSPECT"
  | "DUPLICATE_HEAVY";

// ── Helpers ───────────────────────────────────────────────────────────────────
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  return (text.match(/[.!?]+[\s"')]+|[.!?]+$/g) ?? []).length || 1;
}

function automatedReadabilityIndex(text: string): number {
  const words = countWords(text);
  const sentences = countSentences(text);
  const chars = text.replace(/\s/g, "").length;
  if (words === 0 || sentences === 0) return 0;
  return 4.71 * (chars / words) + 0.5 * (words / sentences) - 21.43;
}

const BOILERPLATE_PHRASES = [
  "cookie policy", "privacy policy", "terms of service", "all rights reserved",
  "subscribe to our newsletter", "follow us on", "share this", "read more",
  "click here", "learn more", "contact us", "about us", "home page",
  "skip to content", "back to top", "copyright",
];

// ── Scoring ───────────────────────────────────────────────────────────────────
export function scoreContent(
  text: string,
  html: string,
  meta: { title?: string; description?: string; publishedAt?: string | null }
): QualityScore {
  const flags: QualityFlag[] = [];
  const wordCount = countWords(text);
  const sentenceCount = countSentences(text);
  const avgWordsPerSentence = wordCount / sentenceCount;

  // ── 1. Length score (0–20) ────────────────────────────────────────────────
  let lengthScore: number;
  if (wordCount < 50) {
    lengthScore = 2;
    flags.push("STUB_CONTENT");
  } else if (wordCount < 150) {
    lengthScore = 8;
  } else if (wordCount < 500) {
    lengthScore = 14;
  } else if (wordCount < 2000) {
    lengthScore = 18;
  } else {
    lengthScore = 20;
  }

  // ── 2. Density score — text-to-content ratio (0–20) ──────────────────────
  //
  // Problem: JS-rendered HTML from Playwright contains the entire browser
  // DOM including <head>, injected <script> and <style> blocks, and framework
  // boilerplate. This inflates htmlLen, making densityRatio look artificially
  // low (often < 0.02) and incorrectly flagging rich pages as LOW_TEXT_DENSITY.
  //
  // Fix: estimate "content HTML size" as the size of just the <body> content
  // by stripping <head> and all <script>/<style> blocks before computing the
  // ratio. This gives a faithful signal regardless of rendering method.
  const bodyHtml = html
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const htmlLen = bodyHtml.length || html.length;
  const textLen = text.length;
  const densityRatio = htmlLen > 0 ? textLen / htmlLen : 0;

  let densityScore: number;
  if (densityRatio < 0.03) {
    // Only flag if word count is also low — rich docs pages can have
    // many list items and code blocks that dilute the ratio legitimately
    if (wordCount < 200) {
      densityScore = 2;
      flags.push("LOW_TEXT_DENSITY");
    } else {
      densityScore = 8; // content-rich but markup-heavy (docs, code)
    }
  } else if (densityRatio < 0.15) {
    densityScore = 10;
  } else if (densityRatio < 0.30) {
    densityScore = 15;
  } else {
    densityScore = 20;
  }

  // ── 3. Readability score (0–20) ───────────────────────────────────────────
  const ari = automatedReadabilityIndex(text);
  let readabilityScore: number;
  if (ari < 1) readabilityScore = 4;
  else if (ari <= 6) readabilityScore = 12;
  else if (ari <= 14) readabilityScore = 20;
  else if (ari <= 18) readabilityScore = 15;
  else readabilityScore = 8;

  if (avgWordsPerSentence > 40) {
    flags.push("WALL_OF_TEXT");
    readabilityScore = Math.max(0, readabilityScore - 5);
  }

  // ── 4. Structure score — headings, paragraphs, lists (0–20) ──────────────
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  const h3Count = (html.match(/<h3[\s>]/gi) ?? []).length;
  const pCount  = (html.match(/<p[\s>]/gi) ?? []).length;
  const liCount = (html.match(/<li[\s>]/gi) ?? []).length;

  let structureScore = 0;
  if (h1Count >= 1) {
    structureScore += 6;
  } else {
    flags.push("NO_HEADINGS");
  }
  if (h2Count >= 2) structureScore += 6;
  else if (h2Count === 1) structureScore += 3;
  if (h3Count >= 1) structureScore += 3;
  if (pCount >= 3) structureScore += 3;
  else if (pCount >= 1) structureScore += 1;
  if (liCount >= 3) structureScore += 2;
  structureScore = Math.min(20, structureScore);

  // ── 5. Uniqueness / boilerplate (0–10) ────────────────────────────────────
  const lowerText = text.toLowerCase();
  const boilerplateHits = BOILERPLATE_PHRASES.filter(p => lowerText.includes(p)).length;
  let uniquenessScore: number;
  if (boilerplateHits >= 5) {
    uniquenessScore = 2;
    flags.push("BOILERPLATE_HEAVY");
  } else if (boilerplateHits >= 3) {
    uniquenessScore = 5;
  } else {
    uniquenessScore = 10;
  }

  // ── 6. Freshness (0–10) ───────────────────────────────────────────────────
  const hasOgDate =
    html.includes('property="article:published_time"') ||
    html.includes("datePublished");
  const hasAnyDate =
    !!meta.publishedAt || /20\d{2}[-/]\d{2}[-/]\d{2}/.test(html);

  let freshnessScore: number;
  if (hasOgDate) freshnessScore = 10;
  else if (hasAnyDate) freshnessScore = 6;
  else freshnessScore = 2;

  // ── Composite ─────────────────────────────────────────────────────────────
  const total = Math.round(
    lengthScore + densityScore + readabilityScore +
    structureScore + uniquenessScore + freshnessScore
  );

  // ── Content type classification ───────────────────────────────────────────
  const hasPrice = /\$[\d,]+|€[\d,]+|£[\d,]+|add to cart|buy now/i.test(html);
  const isError  = /404|page not found|error 5\d\d/i.test(text) && wordCount < 100;
  // Navigation: mostly list items, few paragraphs, low word count
  const isNav    = pCount < 2 && liCount > 10 && wordCount < 300;
  // Documentation: many headings + list items, substantial word count
  const isDocs   = (h2Count + h3Count) >= 3 && liCount >= 5 && wordCount >= 200;

  let contentType: ContentType;
  if (isError) {
    contentType = "error";
    flags.push("ERROR_PAGE");
  } else if (hasPrice) {
    contentType = "product";
  } else if (isNav) {
    contentType = "navigation";
    flags.push("NAVIGATION_PAGE");
  } else if (isDocs) {
    contentType = "docs";
  } else if (total < 30) {
    contentType = "thin";
  } else if (total >= 70) {
    contentType = "rich";
  } else {
    contentType = "article";
  }

  return {
    total,
    lengthScore,
    densityScore,
    readabilityScore,
    structureScore,
    uniquenessScore,
    freshnessScore,
    contentType,
    wordCount,
    sentenceCount,
    avgWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
    flags,
  };
}

/** Minimum score required to emit content downstream (configurable via env). */
export const QUALITY_THRESHOLD = parseInt(process.env.QUALITY_THRESHOLD ?? "25", 10);

export function passesQualityGate(score: QualityScore): boolean {
  return (
    score.total >= QUALITY_THRESHOLD &&
    !score.flags.includes("ERROR_PAGE") &&
    score.contentType !== "navigation"
  );
}
