import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0470_companion_self_note_usage.sql", import.meta.url), "utf8");
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string }>;
  };

test("0470 records note usage without turning it into a content revision", () => {
  assert.match(migration,
    /ALTER TABLE public\.companion_self_notes ADD COLUMN last_used_at timestamptz/);
  assert.doesNotMatch(migration, /SET\s+revision\s*=/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.companion_self_notes/i);
  assert.ok(journal.entries.some((entry) => entry.tag === "0470_companion_self_note_usage"));
});
