import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0333_companion_diary_pause_cutoff.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0333 adds an independent diary switch and gates activity by its current enabled period", () => {
  assert.match(journal, /"idx": 332/);
  assert.match(journal, /"tag": "0333_companion_diary_pause_cutoff"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS diary_enabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS diary_enabled_since timestamptz/);
  assert.match(migration, /SET diary_enabled_since = date_trunc\('milliseconds', now\(\)\)/);
  assert.match(migration, /WHERE global_enabled = true\s+AND diary_enabled = true/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /OWNER TO ailearn_migrator/);
  assert.match(migration, /material_start := GREATEST\(day_start, v_pair\.diary_enabled_since\)/);
  assert.match(migration, /AND diary_enabled = true/);
  assert.match(migration, /created_at >= material_start AND created_at < day_end/);
});
