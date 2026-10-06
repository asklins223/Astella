import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0335_companion_diary_selection_checkpoint.sql", import.meta.url),
  "utf8",
);
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

test("0335 keeps diary selection checkpoints private, scoped, and versioned", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 334 && entry.tag === "0335_companion_diary_selection_checkpoint"));
  assert.match(migration, /CREATE TABLE public\.companion_diary_generation_checkpoints/);
  assert.match(migration, /ADD COLUMN selection_reason text/);
  assert.match(migration, /char_length\(selection_reason\) <= 240/);
  assert.match(migration, /UNIQUE \(job_id, task_id, task_version, input_snapshot_hash\)/);
  assert.match(migration, /FOREIGN KEY \(job_id, workspace_id\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /TO astella_worker/);
  assert.match(migration, /REVOKE ALL PRIVILEGES[\s\S]*FROM PUBLIC, astella_api/);
  assert.doesNotMatch(migration, /GRANT SELECT[\s\S]*TO astella_api/);
});

test("worker-only diary checkpoints stay private after role bootstrap", () => {
  assert.match(roleGrants, /'companion_diary_generation_checkpoints'/);
  assert.match(roleGrants, /REVOKE ALL PRIVILEGES ON TABLE public\.companion_diary_generation_checkpoints FROM astella_api/);
  assert.match(roleGrants, /API unexpectedly has access to worker-only diary checkpoints/);
  assert.match(roleGrants, /\('companion_diary_generation_checkpoints', true, true, true, true\)/);
});
