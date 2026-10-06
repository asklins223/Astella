import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0382_summary_coverage_chain.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §5：摘要必须能说清「接在谁后面」「盖住了哪些来源区间」「谁可以覆盖我」。
// 没有这三样，新摘要会默认代表全部更早历史，迟到的结果会覆盖新指针。
test("0382 gives every summary a continuation chain, a revision fence and a coverage manifest", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 378 && entry.tag === "0382_summary_coverage_chain"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS parent_summary_id uuid/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS coverage_manifest jsonb/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS compaction_policy_version text/);
});

test("0382 refuses a self-parenting or revision-0 summary", () => {
  assert.match(migration, /parent_summary_id IS NULL OR parent_summary_id <> id/);
  assert.match(migration, /CHECK \(revision >= 1\)/);
});

test("0382 indexes the continuation chain and the coverage manifest lookup", () => {
  assert.match(migration, /conversation_summaries_parent_idx/);
  assert.match(migration, /parent_summary_id\)/);
  assert.match(migration, /conversation_summaries_manifest_idx/);
  assert.match(migration, /WHERE coverage_manifest IS NOT NULL/);
});
