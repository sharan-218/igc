import postgres from "postgres";

const db = postgres(process.env.DATABASE_URL!);

const COHERE_API_KEY = process.env.COHERE_API_KEY!;
const COHEREMODEL_API_KEY = process.env.COHEREMODEL_API_KEY!;

// Ask question from CLI
const question = process.argv.slice(2).join(" ");

if (!question) {
  console.log("Usage:");
  console.log("bun run scripts/test-ai-search.ts \"your question\"");
  process.exit(0);
}

console.log("\nQuestion:", question);

// ─────────────────────────────────────────
// 1️⃣ Generate embedding for question
// ─────────────────────────────────────────

async function embedQuery(text: string): Promise<number[]> {
  const res = await fetch("https://api.cohere.com/v1/embed", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${COHERE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "embed-english-v3.0",
      texts: [text],
      input_type: "search_query"
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Cohere API error (${res.status}): ${errorBody}`);
  }

  const data = await res.json() as any;

  if (!data.embeddings || !Array.isArray(data.embeddings) || data.embeddings.length === 0) {
    throw new Error("No embeddings returned from Cohere API. Response structure may have changed.");
  }

  return data.embeddings[0];
}

// ─────────────────────────────────────────
// 2️⃣ Vector search in Postgres
// ─────────────────────────────────────────

async function searchChunks(vector: number[]) {

  const vecStr = `[${vector.join(",")}]`;

  const rows = await db`
    SELECT
      c.text,
      u.url,
      c.section_heading,
      c.embedding_vector <-> ${vecStr}::vector AS distance
    FROM chunks c
    JOIN urls u ON u.id = c.url_id
    WHERE c.embedding_vector IS NOT NULL
    ORDER BY c.embedding_vector <-> ${vecStr}::vector
    LIMIT 5
  `;

  return rows;
}

// ─────────────────────────────────────────
// 3️⃣ Ask LLM
// ─────────────────────────────────────────

async function askLLM(context: string, question: string) {

  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${COHEREMODEL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "c4ai-aya-vision-8b",
      messages: [
        {
          role: "system",
          content: "Answer the question using only the provided context."
        },
        {
          role: "user",
          content: `
            Context:
            ${context}

            Question:
            ${question}
            `
        }
      ]
    })
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Cohere Chat API error (${res.status}): ${errorBody}`);
  }

  const data = await res.json() as any;

  // Cohere V2 Response structure: data.message.content[0].text
  if (data.message && data.message.content && Array.isArray(data.message.content)) {
    return data.message.content[0].text;
  }

  // Fallback for OpenAI style if it was somehow compatible or if user switches back
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }

  throw new Error(`Unexpected AI response structure: ${JSON.stringify(data)}`);
}

// ─────────────────────────────────────────
// Run
// ─────────────────────────────────────────

async function run() {

  console.log("\nGenerating embedding...");

  const vector = await embedQuery(question);

  console.log("Searching database...");

  const chunks = await searchChunks(vector);

  console.log("\nTop Matches:\n");

  chunks.forEach((c: any, i: number) => {
    console.log(`${i+1}. ${c.url}`);
    console.log(c.text.slice(0, 120));
    console.log("");
  });

  const context = chunks.map((c: any) => c.text).join("\n\n");

  console.log("Asking AI...\n");

  const answer = await askLLM(context, question);

  console.log("AI Answer:\n");
  console.log(answer);

  await db.end();
}

run();