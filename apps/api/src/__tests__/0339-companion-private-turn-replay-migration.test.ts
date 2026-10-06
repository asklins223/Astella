import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0339_companion_private_turn_replay.sql", import.meta.url),
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

function hasOwnerScope(source: string): boolean {
  return source.includes("s.workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid")
    && source.includes("s.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid")
    && source.includes("r.workspace_id = s.workspace_id")
    && source.includes("r.user_id = s.user_id")
    && source.includes("r.conversation_id = s.conversation_id");
}

test("0339 exposes exact handoff inputs only through a workspace/user-bound run read function", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 338 && entry.tag === "0339_companion_private_turn_replay"));
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.astella_read_companion_turn_handoff_snapshot_v1\(\s*p_run_id uuid/);
  assert.match(migration, /STABLE\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
  assert.ok(hasOwnerScope(migration), "read function lost workspace/user/run identity checks");
  assert.match(migration, /pg_catalog\.pg_column_size\(s\.snapshot\) <= 524288/);
  assert.match(migration, /pg_catalog\.octet_length\(s\.snapshot::text\) <= 524288/);
  assert.match(migration, /LIMIT 1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_read_companion_turn_handoff_snapshot_v1\(uuid\)\s+FROM PUBLIC, astella_worker/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.astella_read_companion_turn_handoff_snapshot_v1\(uuid\)\s+TO astella_api/);
});

test("owner-scope guard is sensitive and bootstrap keeps direct table access closed", () => {
  assert.equal(
    hasOwnerScope(migration.replace("s.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid", "TRUE")),
    false,
    "removing the authenticated user predicate must invalidate the guard",
  );
  assert.match(roleGrants, /API unexpectedly has access to worker-only companion handoff snapshots/);
  assert.match(roleGrants, /private turn replay function privilege matrix mismatch/);
  assert.match(roleGrants, /\('astella_api', 'astella_read_companion_turn_handoff_snapshot_v1\(uuid\)'\)/);
});
