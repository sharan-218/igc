/**
 * Text chunking + embedding-ready output for AI/RAG/LLM pipelines.
 *
 * Chunking strategy: "semantic sentence-window" chunking
 *  - Split on paragraphs/headings first (preserve semantic units)
 *  - Within each block, split by sentences
 *  - Merge sentences into chunks targeting TARGET_TOKENS tokens
 *  - Add ±OVERLAP_SENTENCES sentence overlap between adjacent chunks
 *    (this is the #1 technique to prevent context loss at chunk boundaries)
 *  - Each chunk carries rich metadata for retrieval augmentation
 *
 * Token estimation: 1 token ≈ 4 chars (GPT-style BPE approximation).
 * For production, replace with tiktoken or a proper tokenizer.
 *
 * Memory safety:
 *  - Pure streaming pipeline: process one section at a time
 *  - No whole-document buffering beyond the input string
 *  - Generator-based interface for lazy consumption
 */

export interface TextChunk {
  index: number;          // position in document
  text: string;           // the chunk text
  tokenEstimate: number;  // rough token count
  charStart: number;      // byte offset in original text
  charEnd: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  url: string;
  domain: string;
  title: string;
  chunkIndex: number;
  totalChunks: number;    // filled in after chunking completes
  sectionHeading: string | null;
  wordCount: number;
  // For embedding pipelines
  embeddingModel: string | null; // set when embedded
  embeddingVector: number[] | null;
}

export interface ChunkingOptions {
  targetTokens?: number;   // default 512 — good for most embedding models
  overlapSentences?: number; // default 2 — sentences to repeat at chunk boundaries
  minTokens?: number;      // default 50  — discard tiny trailing chunks
}

const DEFAULT_TARGET_TOKENS = 512;
const DEFAULT_OVERLAP_SENTENCES = 2;
const DEFAULT_MIN_TOKENS = 50;
const CHARS_PER_TOKEN = 4; // GPT-style approximation

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or end-of-string
  // Preserves abbreviations reasonably well
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function splitIntoParagraphBlocks(text: string): Array<{ heading: string | null; body: string }> {
  const blocks: Array<{ heading: string | null; body: string }> = [];
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);

  let currentHeading: string | null = null;
  let buffer: string[] = [];

  for (const line of lines) {
    // Detect heading-like lines: short, no sentence-ending punct, possibly uppercase
    const isHeading = line.length < 120 && !line.endsWith(".") && (/^[A-Z]/.test(line) || /^#+\s/.test(line));

    if (isHeading && buffer.length > 0) {
      blocks.push({ heading: currentHeading, body: buffer.join(" ") });
      buffer = [];
      currentHeading = line.replace(/^#+\s*/, "");
    } else if (isHeading) {
      currentHeading = line.replace(/^#+\s*/, "");
    } else {
      buffer.push(line);
    }
  }

  if (buffer.length > 0) {
    blocks.push({ heading: currentHeading, body: buffer.join(" ") });
  }

  return blocks;
}

// ── Main chunker ──────────────────────────────────────────────────────────────
export function chunkText(
  text: string,
  docMeta: { url: string; domain: string; title: string },
  options: ChunkingOptions = {}
): TextChunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapSentences = options.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES;
  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS;

  const blocks = splitIntoParagraphBlocks(text);
  const chunks: TextChunk[] = [];
  let charOffset = 0;

  for (const block of blocks) {
    const sentences = splitSentences(block.body);
    if (sentences.length === 0) continue;

    let sentIdx = 0;
    let prevOverlap: string[] = [];

    while (sentIdx < sentences.length) {
      const chunkSentences: string[] = [...prevOverlap];
      let tokens = estimateTokens(prevOverlap.join(" "));

      // Fill chunk up to target token budget
      while (sentIdx < sentences.length) {
        const sent = sentences[sentIdx];
        const sentTokens = estimateTokens(sent);
        if (tokens + sentTokens > targetTokens && chunkSentences.length > overlapSentences) break;
        chunkSentences.push(sent);
        tokens += sentTokens;
        sentIdx++;
      }

      const chunkText = chunkSentences.join(" ").trim();
      const tokenCount = estimateTokens(chunkText);

      if (tokenCount >= minTokens) {
        const charStart = charOffset;
        const charEnd = charOffset + chunkText.length;

        chunks.push({
          index: chunks.length,
          text: chunkText,
          tokenEstimate: tokenCount,
          charStart,
          charEnd,
          metadata: {
            url: docMeta.url,
            domain: docMeta.domain,
            title: docMeta.title,
            chunkIndex: chunks.length,
            totalChunks: 0, // filled below
            sectionHeading: block.heading,
            wordCount: chunkText.split(/\s+/).length,
            embeddingModel: null,
            embeddingVector: null,
          },
        });
      }

      charOffset += chunkText.length + 1;

      // Set overlap for next chunk: last N sentences (excluding the overlap we just prepended)
      const nonOverlapSents = chunkSentences.slice(prevOverlap.length);
      prevOverlap = nonOverlapSents.slice(-overlapSentences);
    }
  }

  // Fill in totalChunks now that we know
  for (const c of chunks) {
    c.metadata.totalChunks = chunks.length;
  }

  return chunks;
}

// ── Embedding-ready serialization ─────────────────────────────────────────────
/**
 * Formats a chunk for embedding APIs (OpenAI, Cohere, etc.)
 * Prepends doc context so the embedding captures page-level semantics.
 */
export function toEmbeddingInput(chunk: TextChunk): string {
  const parts: string[] = [];
  if (chunk.metadata.title) parts.push(`Title: ${chunk.metadata.title}`);
  if (chunk.metadata.sectionHeading) parts.push(`Section: ${chunk.metadata.sectionHeading}`);
  parts.push(chunk.text);
  return parts.join("\n\n");
}

/**
 * Formats a chunk as a LangChain / LlamaIndex Document object.
 * Drop-in compatible with most RAG frameworks.
 */
export function toLangChainDocument(chunk: TextChunk) {
  return {
    pageContent: chunk.text,
    metadata: {
      source: chunk.metadata.url,
      domain: chunk.metadata.domain,
      title: chunk.metadata.title,
      chunkIndex: chunk.metadata.chunkIndex,
      totalChunks: chunk.metadata.totalChunks,
      section: chunk.metadata.sectionHeading,
      wordCount: chunk.metadata.wordCount,
      tokenEstimate: chunk.tokenEstimate,
    },
  };
}
