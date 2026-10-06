import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0383_context_assembly_receipt.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §3.3：这次调用**实际**纳入与排除了哪些条目。
// 此前 composeAgentContext 的回执只 `logger.info`，于是「窗口放大后触发变少」与
// 「预算从来没接上」在数据上完全分不开——这正是本列存在的理由。
test("0383 persists the context assembly and pressure receipts on the run", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 379 && entry.tag === "0383_context_assembly_receipt"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS context_assembly_receipt jsonb/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS context_pressure jsonb/);
});

test("0383 indexes runs that actually recorded a pressure read", () => {
  assert.match(migration, /companion_turn_runs_context_pressure_idx/);
  assert.match(migration, /WHERE context_pressure IS NOT NULL/);
});
