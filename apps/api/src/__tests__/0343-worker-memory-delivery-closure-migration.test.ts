import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0343_worker_memory_delivery_closure.sql", import.meta.url),
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

test("0343 closes only the scoped memory delivery through a worker-only function", () => {
  assert.ok(journal.entries.some((entry) =>
    entry.idx === 342 && entry.tag === "0343_worker_memory_delivery_closure"));
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /p_transition NOT IN \('acted', 'dismissed'\)/);
  assert.match(migration, /m\.id = p_memory_item_id[\s\S]*?m\.workspace_id = p_workspace_id[\s\S]*?m\.user_id = p_user_id/);
  assert.match(migration, /payload_ref ->> 'memoryItemId' = p_memory_item_id::text/);
  assert.match(migration, /state IN \('queued', 'delivered', 'displayed', 'snoozed'\)/);
  assert.match(migration, /pg_notify\([\s\S]*?ailearn_companion_inbox_v1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.ailearn_close_companion_memory_delivery[\s\S]*?FROM PUBLIC, ailearn_api, ailearn_worker/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.ailearn_close_companion_memory_delivery[\s\S]*?TO ailearn_worker/);
});

test("role bootstrap restores and verifies the exact worker function grant", () => {
  assert.match(roleGrants, /to_regprocedure\('public\.ailearn_close_companion_memory_delivery\(uuid,uuid,uuid,text\)'\)/);
  assert.match(roleGrants, /ALTER FUNCTION public\.ailearn_close_companion_memory_delivery[\s\S]{0,160}OWNER TO ailearn_migrator[\s\S]{0,160}SET search_path = pg_catalog, public/);
  assert.match(roleGrants, /GRANT EXECUTE ON FUNCTION public\.ailearn_close_companion_memory_delivery[\s\S]{0,160}TO ailearn_worker/);
  assert.match(roleGrants, /'ailearn_worker', 'ailearn_close_companion_memory_delivery\(uuid,uuid,uuid,text\)'/);
  assert.match(roleGrants, /Worker has unexpected function EXECUTE privileges/);
  assert.match(roleGrants, /Required function EXECUTE grants are missing/);
});
