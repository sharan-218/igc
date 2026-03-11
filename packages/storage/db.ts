import postgres from "postgres";
import chalk from "chalk";

/**
 * Shared postgres connection pool.
 *
 * max: 10  — caps simultaneous DB connections per process.
 * idle_timeout: 30s — releases idle connections to avoid exhausting
 *   Postgres max_connections on a multi-worker deployment.
 * connect_timeout: 10s — fail fast if the DB is unreachable.
 * onnotice: suppressed — avoids noisy NOTICE logs from migrations.
 */
export const db = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
  onclose(connId) {
    // Intentionally silent — connection churn is expected under load
  },
});

// Surface connection errors immediately (do not swallow them)
db`SELECT 1`.catch((err: Error) => {
  console.error(
    chalk.bgRed.white.bold(" DB connection failed: "),
    err.message
  );
});
