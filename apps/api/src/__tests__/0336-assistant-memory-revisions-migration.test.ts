import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0336_assistant_memory_revisions.sql", import.meta.url),
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

test("0336 captures immutable prior memory versions and keeps their evidence private", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 335 && entry.tag === "0336_assistant_memory_revisions"));
  assert.match(migration, /ADD COLUMN revision integer NOT NULL DEFAULT 1/);
  assert.match(migration, /ADD COLUMN author_type text NOT NULL/);
  assert.match(migration, /ADD COLUMN epistemic_status text NOT NULL/);
  assert.match(migration, /CREATE TABLE public\.assistant_memory_item_revisions/);
  assert.match(migration, /PRIMARY KEY \(memory_id, revision\)/);
  assert.match(migration, /NEW\.revision := OLD\.revision \+ 1/);
  assert.match(migration, /OLD\.source_event_id/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON public\.assistant_memory_item_revisions/);
});

test("role bootstrap preserves append-only ACLs for memory history", () => {
  assert.match(roleGrants, /assistant_memory_item_revisions/);
  assert.match(roleGrants, /assistant memory revisions must be append-only for API/);
  assert.match(roleGrants, /\('assistant_memory_item_revisions', true, true, false, false\)/);
});
