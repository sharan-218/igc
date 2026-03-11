import { Client } from "pg";

const client = new Client({
  host: "localhost",
  port: 5432,
  user: "postgres",
  database: "postgres",
});

async function main() {
  try {
    await client.connect();
    console.log("✅ Connected to Postgres\n");

    // -------------------
    // URLS
    // -------------------
    const urls = await client.query(`
      SELECT * FROM urls
      ORDER BY id
      LIMIT 10
    `);

    // console.log("🌐 URLS TABLE");
    // console.table(urls.rows);

    // -------------------
    // PAGES
    // -------------------
    const pages = await client.query(`
      SELECT * FROM pages
      ORDER BY id
      LIMIT 10
    `);

    console.log("\n📄 PAGES TABLE");
    console.table(pages.rows);

    // -------------------
    // LINKS
    // -------------------
    const links = await client.query(`
      SELECT * FROM links
      LIMIT 10
    `);

    // console.log("\n🔗 LINKS TABLE");
    // console.table(links.rows);

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.end();
    console.log("\n✅ Connection closed");
  }
}

main();