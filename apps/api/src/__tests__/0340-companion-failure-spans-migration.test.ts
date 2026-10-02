import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0340_companion_failure_spans.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const roleGrants = readFileSync(
  new URL("../../../../infra/postgres/roles.sql", import.meta.url),
  "utf8",
);

test("0340 stores one bounded, owner-scoped failure span per class without private text", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 339 && entry.tag === "0340_companion_failure_spans"));
  assert.match(migration, /PRIMARY KEY \(workspace_id, user_id, failure_class\)/);
  assert.match(migration, /failure_class IN \('transport', 'output', 'tool', 'delivery', 'tts', 'execution', 'state'\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /current_setting\('app\.workspace_id', true\)/);
  assert.match(migration, /current_setting\('app\.user_id', true\)/);
  assert.doesNotMatch(migration, /^\s*(?:prompt|message_body|error_text|arguments|reasoning)\s+\w+/im);
});

test("0340 exposes read-only scoped diagnostics and applies a retention ceiling to spans", () => {
  assert.match(migration, /GRANT SELECT ON public\.companion_run_failure_spans TO ailearn_api/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON public\.companion_run_failure_spans TO ailearn_worker/);
  assert.match(roleGrants, /companion failure spans must be read-only for API/);
  assert.match(roleGrants, /ailearn_read_companion_turn_handoff_snapshot_v1\(uuid\)/);
  assert.match(roleGrants, /ailearn_purge_companion_audit_ttl\(integer,integer\)/);
  assert.match(migration, /last_failure_at < now\(\) - make_interval\(days => p_retention_days\)[\s\S]*?DELETE FROM public\.companion_run_failure_spans/);
});
