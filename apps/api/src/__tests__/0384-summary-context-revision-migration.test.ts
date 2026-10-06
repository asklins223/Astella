import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0384_summary_context_revision.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §3.3：「读取与提交均检查当前有效性」。
// 此前提交侧有 sourceHash 复核，读取侧只查列非空——`coverage_source_hash` 在读路径上
// 从未被复核过，于是消息被改写后旧摘要照样注入。
test("0384 gives every conversation a content revision and every summary a verified stamp", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 380 && entry.tag === "0384_summary_context_revision"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS context_revision bigint NOT NULL DEFAULT 1/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS verified_context_revision bigint/);
  assert.match(migration, /verified_context_revision IS NULL OR verified_context_revision >= 1/);
});

test("0384 invalidates coverage on rewrite and delete, but not on append", () => {
  // 追加若也 +1，所有摘要会在第一条新消息到达时全部失效，而摘要器是周期跑的——
  // 那是对现状的倒退，不是治理。
  assert.match(migration, /AFTER UPDATE OR DELETE ON public\.companion_messages/);
  assert.ok(!/AFTER INSERT ON public\.companion_messages/.test(migration),
    "追加不得让既有覆盖失效");
  assert.match(migration, /astella_bump_conversation_context_revision/);
});

test("0384 indexes the reads that filter on the verified revision", () => {
  assert.match(migration, /conversation_summaries_verified_idx/);
  assert.match(migration, /WHERE status IN \('candidate', 'confirmed'\)/);
  assert.match(migration, /verified_context_revision IS NOT NULL/);
});
