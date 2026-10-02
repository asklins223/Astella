import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0331_companion_agent_tool_outcome_unknown.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0331 persists outcome_unknown in the companion tool-call status contract", () => {
  assert.match(journal, /"idx": 330/);
  assert.match(journal, /"tag": "0331_companion_agent_tool_outcome_unknown"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS companion_agent_tool_calls_status_check/);
  assert.match(migration, /ADD CONSTRAINT companion_agent_tool_calls_status_check/);
  assert.match(migration, /'outcome_unknown'/);
  assert.match(migration, /'requested', 'executing', 'waiting_confirmation', 'succeeded'/);
  assert.match(migration, /'failed', 'blocked', 'expired'/);
});
