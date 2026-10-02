import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0334_companion_summary_watermark.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0334 stores an exact, content-verified message range for each conversation summary", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 333 && entry.tag === "0334_companion_summary_watermark"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS coverage_from_seq bigint/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS coverage_through_seq bigint/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS coverage_source_hash text/);
  assert.match(migration, /coverage_from_seq <= coverage_through_seq/);
  assert.match(migration, /coverage_source_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /conversation_summaries_watermark_idx/);
});
