import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const directory = new URL("../apps/api/migrations/", import.meta.url);
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("migrate: DATABASE_URL is not set");
  console.error("  local:      node --env-file=apps/api/.env scripts/migrate.mjs");
  console.error("  deployment: set DATABASE_URL in the service environment");
  process.exit(2);
}

const caCertificate = process.env.DATABASE_CA_CERT;

const client = new pg.Client({
  connectionString,
  ssl: caCertificate ? { ca: caCertificate, rejectUnauthorized: true } : { rejectUnauthorized: false },
});
await client.connect();

if (!caCertificate) {
  console.warn("migrate: connected over TLS without verifying the server certificate");
  console.warn("  set DATABASE_CA_CERT to the provider CA to enable full verification");
}

try {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const applied = new Set(
    (await client.query("select name from schema_migrations")).rows.map((row) => row.name),
  );

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = await readFile(new URL(file, directory), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`  applied ${file}`);
      ran += 1;
    } catch (error) {
      await client.query("rollback");
      console.error(`  FAILED  ${file}: ${error.message}`);
      throw error;
    }
  }

  console.log(ran === 0 ? "database already up to date" : `applied ${ran} migration(s)`);
} finally {
  await client.end();
}
