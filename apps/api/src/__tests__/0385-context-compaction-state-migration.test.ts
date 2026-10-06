import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0385_context_compaction_state.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §5.4 后半：压缩是一次**有界**尝试。失败以后不记，下一轮同一个请求会
// 原样再触发一次——每轮白折一次、白等一次，而情况一点没变。
test("0385 keys compaction failure memory on conversation, source version and model route", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 381 && entry.tag === "0385_context_compaction_state"));
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.agent_context_compaction_state/);
  assert.match(migration, /conversation_id uuid NOT NULL/);
  assert.match(migration, /source_hash char\(64\) NOT NULL/);
  assert.match(migration, /provider_id text NOT NULL/);
  assert.match(migration, /model_id text NOT NULL/);
  assert.match(migration, /\(workspace_id, user_id, conversation_id, source_hash, provider_id, model_id\)/);
});

test("0385 keeps the failure state bounded and content-free", () => {
  assert.match(migration, /CHECK \(attempts >= 0\)/);
  assert.match(migration, /CHECK \(no_progress_streak >= 0\)/);
  // 只记计数、原因、时间与输入 token 数——不记原文，也不记内容摘要。
  assert.ok(!/summary|content|text_content/i.test(migration.replace(/--.*$/gm, "")),
    "这张表里不该出现任何承载正文的列");
});

test("0385 isolates the state by workspace and user like every other private table", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /app\.workspace_id/);
  assert.match(migration, /app\.user_id/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.agent_context_compaction_state TO astella_worker/);
});
