import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0338_companion_agent_model_step_checkpoints.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0338 adds a private model-step checkpoint column to the existing scoped ledger", () => {
  assert.match(journal, /"idx": 337/);
  assert.match(journal, /"tag": "0338_companion_agent_model_step_checkpoints"/);
  assert.match(migration, /ALTER TABLE public\.companion_agent_steps/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS checkpoint jsonb/);
  assert.match(migration, /Cleared when the step leaves running/);
});
