/** Apply only the additive lease migration to the project's local databases. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";

if (process.env.APPLY_LOCAL_JOB_LEASE_MIGRATION !== "1") throw new Error("Explicit local migration switch required");
const source = process.env.DATABASE_URL_MIGRATOR;
if (!source) throw new Error("Migrator configuration required");
const path = new URL("../src/db/migrations/0394_job_lease_heartbeat.sql", import.meta.url);
const migration = readFileSync(path, "utf8");
const journal = JSON.parse(readFileSync(new URL("../src/db/migrations/meta/_journal.json", import.meta.url), "utf8"));
const entry = journal.entries.find((row: { tag: string }) => row.tag === "0394_job_lease_heartbeat");
const hash = createHash("sha256").update(migration).digest("hex");
for (const name of ["astella_maketest", "astella", "astella_companion_live_20261007"]) {
  const url = new URL(source);
  url.hostname = "127.0.0.1";
  url.pathname = `/${name}`;
  const db = postgres(url.href, { max: 1, connect_timeout: 5 });
  try {
    await db.begin(async tx => {
      const applied = await tx`SELECT id FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      if (applied.length) return;
      for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
        await tx.unsafe(statement);
      }
      await tx`INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES(${hash},${entry.when})`;
    });
    console.log(JSON.stringify({ database: name, migration: entry.tag, applied: true }));
  } finally { await db.end(); }
}
