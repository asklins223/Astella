import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0344_companion_memory_budget_tiers.sql", import.meta.url),
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

test("0344 adds separately auditable resident, active, and archived memory tiers", () => {
  assert.ok(journal.entries.some((entry) =>
    entry.idx === 343 && entry.tag === "0344_companion_memory_budget_tiers"));
  assert.match(migration, /ADD COLUMN budget_tier text NOT NULL DEFAULT 'active'/);
  assert.match(migration, /CHECK \(budget_tier IN \('resident', 'active', 'archived'\)\)/);
  assert.match(migration, /CREATE TABLE public\.assistant_memory_budget_events/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON public\.assistant_memory_budget_events/);
});

test("resident promotion is serialized, scoped, bounded, and suggests reversible downgrades", () => {
  assert.match(migration, /astella_move_companion_memory_budget_tier_v1/);
  assert.match(migration, /current_setting\('app\.workspace_id', true\)[\s\S]*?current_setting\('app\.user_id', true\)/);
  assert.match(migration, /pg_advisory_xact_lock\([\s\S]*?companion-memory-budget:/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /resident_items \+ 1 > 6/);
  assert.match(migration, /resident_tokens \+ requested_tokens > 320/);
  assert.match(migration, /resident_bytes \+ requested_bytes > 1000/);
  assert.match(migration, /'suggestedDowngrades', suggestions/);
  assert.match(migration, /actor_type, actor_id/);
  assert.match(migration, /CURRENT_USER = 'astella_api'[\s\S]*?p_actor_type <> 'user'/);
  assert.match(migration, /CURRENT_USER = 'astella_worker'[\s\S]*?p_actor_type = 'user'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_move_companion_memory_budget_tier_v1[\s\S]*?FROM PUBLIC/);
});

test("role bootstrap keeps memory budget events append-only and restores the exact move function grants", () => {
  assert.match(roleGrants, /assistant_memory_budget_events/);
  assert.match(roleGrants, /astella_move_companion_memory_budget_tier_v1\(uuid,uuid,uuid,text,text,uuid\)/);
  const apiExecuteAllowlist = roleGrants
    .split("AND has_function_privilege('astella_api'")[1]
    ?.split("RAISE EXCEPTION 'API has unexpected function EXECUTE privileges:")[0] ?? "";
  assert.match(apiExecuteAllowlist, /astella_move_companion_memory_budget_tier_v1/);
  assert.match(roleGrants, /Worker has unexpected function EXECUTE privileges/);
  assert.match(roleGrants, /Required function EXECUTE grants are missing/);
});
