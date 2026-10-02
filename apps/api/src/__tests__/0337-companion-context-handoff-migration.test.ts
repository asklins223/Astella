import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0337_companion_context_handoff_snapshot.sql", import.meta.url),
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

test("0337 stores one immutable worker-only, content-verified handoff snapshot per companion run", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 336 && entry.tag === "0337_companion_context_handoff_snapshot"));
  assert.match(migration, /CREATE TABLE public\.companion_context_handoff_snapshots/);
  assert.match(migration, /snapshot_sha256 char\(64\) NOT NULL/);
  assert.match(migration, /snapshot_version integer NOT NULL CHECK \(snapshot_version = 1\)/);
  assert.match(migration, /REFERENCES public\.companion_turn_runs\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /FOR ALL TO ailearn_worker/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON public\.companion_context_handoff_snapshots FROM PUBLIC, ailearn_api/);
  assert.match(migration, /GRANT SELECT, INSERT ON public\.companion_context_handoff_snapshots TO ailearn_worker/);
  assert.match(migration, /snapshot_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /snapshot->>'runId' = run_id::text/);
  assert.match(migration, /snapshot->>'conversationId' = conversation_id::text/);
});

test("worker-only handoff snapshots stay private and append-only after role bootstrap", () => {
  assert.match(roleGrants, /'companion_context_handoff_snapshots'/);
  assert.match(roleGrants, /REVOKE ALL PRIVILEGES ON TABLE public\.companion_context_handoff_snapshots FROM ailearn_api/);
  assert.match(roleGrants, /API unexpectedly has access to worker-only companion handoff snapshots/);
  assert.match(roleGrants, /\('companion_context_handoff_snapshots', true, true, false, false\)/);
});
