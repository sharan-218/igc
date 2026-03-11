// Re-export from the canonical location so both
//   @storage/db  (packages/storage/src/db.ts  via tsconfig path alias)
// and
//   import { db } from "@storage/db"  (packages/storage/db.ts)
// resolve to the same singleton pool.
export { db } from "../db";
