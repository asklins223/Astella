import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0387_method_evidence_origins.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §6.4：「**保存完整派生关系**，识别共同原始来源……只算同源依据」。
// 把去重做在存储上会把派生关系删掉，而 0374 的证据传播正是按 memoryId 找派生方法。
test("0387 stores the origin grouping separately from the full derivation graph", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 383 && entry.tag === "0387_method_evidence_origins"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS evidence_origins jsonb/);
  // 不能动 evidence：它要保完整。
  assert.ok(!/ALTER COLUMN evidence|ADD COLUMN IF NOT EXISTS evidence /.test(migration),
    "evidence 必须保持完整——折掉引用会让遗忘/纠正的传播断链");
});

test("0387 bounds the grouping receipt so it cannot claim more origins than refs", () => {
  assert.match(migration, /evidence_origins \? 'independentCount'/);
  assert.match(migration, /\(evidence_origins->>'independentCount'\)::integer >= 1/);
  assert.match(migration, /\(evidence_origins->>'independentCount'\)::integer\s*\n?\s*<= jsonb_array_length\(evidence\)/);
});
