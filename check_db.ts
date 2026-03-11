import { db } from "@storage";
try {
  const [row] = await db`
    SELECT column_name, data_type, udt_name, character_maximum_length,
           (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding_vector') as type_format
    FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'embedding_vector';
  `;
  console.log("DB_CHECK_OUTPUT:", JSON.stringify(row, null, 2));
} catch (e) {
  console.error("DB_CHECK_ERROR:", e.message);
}
await db.end();
process.exit(0);
