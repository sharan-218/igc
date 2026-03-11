/**
 * Database migration runner
 *
 * Applies SQL migration files in order, skipping already-applied ones.
 * Each migration runs inside a transaction.
 *
 * Usage:
 *   bun run scripts/migrate.ts
 *   bun run scripts/migrate.ts --dry
 *
 * Env:
 *   DATABASE_URL=postgresql://...
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import postgres from "postgres";

// ── Config ─────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry");

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL environment variable not set.");
  console.error("   Example: postgresql://postgres:pass@localhost:5432/db");
  process.exit(1);
}

const db = postgres(DATABASE_URL, {
  max: 2,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {}
});

const migrationsDir = join(import.meta.dir, "../infrastructure/db/migrations");

function pad(s: string, n: number) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── Parse extension directives ─────────────────────────
function parseRequiredExtensions(sql: string): string[] {
  const required: string[] = [];

  const lines = sql.split("\n").slice(0, 20);

  for (const line of lines) {
    const match = line.match(/^\s*--\s*@requires-extension\s+(\S+)/);
    if (match?.[1]) required.push(match[1]);
  }

  return required;
}

// ── Runner ─────────────────────────────────────────────
async function run() {

  try {
    await db`SELECT 1`;
  } catch (err: any) {
    console.error("❌ Cannot connect to database:", err.message);
    process.exit(1);
  }

  // Prevent concurrent migrations
  await db`SELECT pg_advisory_lock(987654321)`;

  // migrations table
  await db`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // cache installed extensions
  const installedExtensions = new Set(
    (await db`SELECT extname FROM pg_extension`).map((r: any) => r.extname)
  );

  let files: string[];

  try {
    files = (await readdir(migrationsDir))
      .filter(f => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    console.error(`❌ Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("ℹ️ No migration files found.");
    await db.end();
    return;
  }

  const applied = await db`SELECT filename FROM _migrations` as { filename: string }[];

  const appliedSet = new Set(applied.map(r => r.filename));

  const pending = files.filter(f => !appliedSet.has(f));
  const already = files.filter(f => appliedSet.has(f));

  console.log(`\nMigrations directory: ${migrationsDir}`);
  console.log(`Total: ${files.length} | Applied: ${already.length} | Pending: ${pending.length}\n`);

  for (const f of already) {
    console.log(`✓ ${pad(f, 40)} (already applied)`);
  }

  if (pending.length === 0) {
    console.log("\n✅ Database is up to date.\n");
    await db.end();
    return;
  }

  if (DRY_RUN) {
    console.log("\nPending migrations (--dry):\n");
    for (const f of pending) {
      console.log(`→ ${f}`);
    }
    console.log();
    await db.end();
    return;
  }

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of pending) {

    const sqlPath = join(migrationsDir, file);

    let sql: string;

    try {
      sql = await readFile(sqlPath, "utf-8");
    } catch {
      console.error(`❌ Cannot read migration file: ${sqlPath}`);
      await db.end();
      process.exit(1);
    }

    // extension guards
    const requiredExtensions = parseRequiredExtensions(sql);

    let blocked = false;

    for (const ext of requiredExtensions) {

      if (!installedExtensions.has(ext)) {

        console.log(`⏭ ${pad(file, 40)} skipped (requires extension: ${ext})`);

        if (ext === "vector") {
          console.log("   Install pgvector then re-run migrate.");
          console.log("   Docker: pgvector/pgvector:pg15");
          console.log("   Ubuntu: apt install postgresql-15-pgvector");
          console.log("   macOS : brew install pgvector");
        }

        skippedCount++;
        blocked = true;
        break;
      }
    }

    if (blocked) continue;

    console.log(`→ Applying ${file} ...`);

    try {

      await db.begin(async tx => {

        await tx.unsafe(sql);

        await tx`
          INSERT INTO _migrations (filename)
          VALUES (${file})
        `;
      });

      console.log(`✓ ${file} applied`);
      appliedCount++;

    } catch (err: any) {

      console.error(`\n❌ Migration ${file} FAILED\n`);

      if (err.message) console.error(" ", err.message);
      if (err.detail) console.error(" Detail:", err.detail);
      if (err.hint) console.error(" Hint:", err.hint);

      console.error("\nMigration rolled back. Database unchanged.");

      await db.end();
      process.exit(1);
    }
  }

  const summary: string[] = [];

  if (appliedCount > 0) summary.push(`${appliedCount} applied`);
  if (skippedCount > 0) summary.push(`${skippedCount} skipped`);

  console.log(`\n✅ Done — ${summary.join(", ") || "nothing to do"}.\n`);

  await db`SELECT pg_advisory_unlock(987654321)`;

  await db.end();
}

run().catch(async err => {

  console.error("❌ Unexpected error:", err);

  await db.end().catch(() => {});

  process.exit(1);
});