/**
 * Extractor Worker — Embedding generation pipeline
 *
 * Picks up chunks that have no embedding_vector yet and calls
 * OpenAI / compatible embedding API to fill them in.
 *
 * Architecture:
 * - Polls for un-embedded chunks in batches (configurable batch size)
 * - Calls embedding API in parallel with concurrency cap
 * - Stores vectors back to Postgres (as TEXT JSON when pgvector not installed,
 *   as vector(1536) after migration 003 upgrades the column)
 * - Exponential backoff on API rate limits
 * - Clean shutdown on SIGTERM/SIGINT
 *
 * To use a different provider, set EMBEDDING_PROVIDER env var:
 *  - "openai"  (default) — requires OPENAI_API_KEY
 *  - "cohere"            — requires COHERE_API_KEY
 *  - "local"             — calls LOCAL_EMBEDDING_URL (Ollama, etc.)
 */

import chalk from "chalk";
import { db } from "@storage/db";

const PROVIDER = (process.env.EMBEDDING_PROVIDER ?? "cohere") as "openai" | "cohere" | "local";
const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE ?? "50", 10);
const CONCURRENCY = parseInt(process.env.EMBEDDING_CONCURRENCY ?? "5", 10);
const POLL_INTERVAL_MS = parseInt(process.env.EMBEDDING_POLL_MS ?? "5000", 10);
const MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

console.log(chalk.cyan(` Extractor Worker | provider=${PROVIDER} | model=${MODEL} | batch=${BATCH_SIZE}`));
// Cache the result — the column type won't change while the worker is running.
let _pgVectorEnabled: boolean | null = null;

async function isPgVectorEnabled(): Promise<boolean> {
  if (_pgVectorEnabled !== null) return _pgVectorEnabled;
  try {
    const [row] = await db`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'chunks' AND column_name = 'embedding_vector'
    ` as [{ data_type: string }?];
    // pgvector reports data_type as 'USER-DEFINED'
    _pgVectorEnabled = row?.data_type === "USER-DEFINED";
  } catch {
    _pgVectorEnabled = false;
  }
  console.log(
    _pgVectorEnabled
      ? chalk.bgGreen.black(" pgvector enabled — using vector(1536) column ")
      : chalk.bgYellow.black(" pgvector not installed — storing embeddings as TEXT (run migration 003 to upgrade) ")
  );
  return _pgVectorEnabled;
}

// ── Embedding API adapters ─────────────────────────────────────────────────────
async function embedOpenAI(inputs: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "10", 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return embedOpenAI(inputs); // retry once
  }

  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);

  const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function embedCohere(inputs: string[]): Promise<number[][]> {
  const res = await fetch("https://api.cohere.com/v1/embed", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.COHERE_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, texts: inputs, input_type: "search_document" }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "10", 10);
    console.warn(`[Cohere] Rate limited (429), retrying in ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return embedCohere(inputs);
  }

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`Cohere API error: ${res.status}`, errorBody);
    throw new Error(`Cohere API error: ${res.status}`);
  }
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

async function embedLocal(inputs: string[]): Promise<number[][]> {
  const url = process.env.LOCAL_EMBEDDING_URL ?? "http://localhost:11434/api/embed";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!res.ok) throw new Error(`Local embedding error: ${res.status}`);
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

async function embed(inputs: string[]): Promise<number[][]> {
  switch (PROVIDER) {
    case "openai": return embedOpenAI(inputs);
    case "cohere": return embedCohere(inputs);
    case "local":  return embedLocal(inputs);
    default: throw new Error(`Unknown provider: ${PROVIDER}`);
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────
let running = true;

async function processChunks(): Promise<void> {
  // Fetch un-embedded chunks
  const rows = await db`
    SELECT id, text, url_id,
           (SELECT url FROM urls WHERE id = chunks.url_id) AS url,
           section_heading
    FROM chunks
    WHERE embedding_vector IS NULL
      AND embedding_model IS NULL
    ORDER BY id ASC
    LIMIT ${BATCH_SIZE}
  ` as Array<{ id: number; text: string; url: string; section_heading: string | null }>;

  if (rows.length === 0) return;

  console.log(chalk.dim(`Processing ${rows.length} chunks for embedding...`));

  // Build embedding inputs with context prefix
  const inputs = rows.map(r => {
    const parts: string[] = [];
    if (r.section_heading) parts.push(`Section: ${r.section_heading}`);
    parts.push(r.text);
    return parts.join("\n\n");
  });

  try {
    const vectors = await embed(inputs);

    // Detect once whether pgvector column type is available
    const usePgVector = await isPgVectorEnabled();

    // Update in parallel with concurrency cap
    const tasks = rows.map((row, i) => async () => {
  const vec = vectors[i];
  if (!vec) return;

  if (vec.length !== 1024) {
    console.error("Embedding dimension mismatch:", vec.length);
    return;
  }

  const vecStr = `[${vec.join(",")}]`;

  if (usePgVector) {
    await db`
      UPDATE chunks
      SET embedding_vector = ${vecStr}::vector,
          embedding_model  = ${MODEL}
      WHERE id = ${row.id}
    `;
  } else {
    await db`
      UPDATE chunks
      SET embedding_vector = ${vecStr},
          embedding_model  = ${MODEL}
      WHERE id = ${row.id}
    `;
  }
});

    // Run with concurrency limit
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      await Promise.all(tasks.slice(i, i + CONCURRENCY).map(t => t()));
    }

    console.log(chalk.bgGreen.black(` Embedded ${rows.length} chunks `));
  } catch (err) {
    console.error(chalk.bgRed.white(" Embedding error: "), err);
  }
}

async function runLoop(): Promise<void> {
  while (running) {
    try {
      await processChunks();
    } catch (err) {
      console.error("Extractor loop error:", err);
    }
    if (running) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

runLoop();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(chalk.bgYellow.black(` ${signal} — extractor stopping `));
  running = false;
  await db.end();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
