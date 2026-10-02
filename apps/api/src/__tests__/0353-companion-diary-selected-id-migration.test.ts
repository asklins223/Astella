import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0353_companion_diary_selected_id.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const dbSchema = readFileSync(
  new URL("../../../../packages/shared/src/db-schema/companion-memory.ts", import.meta.url),
  "utf8",
);
const desktopContracts = readFileSync(
  new URL("../../../../packages/shared/src/contracts/companion-memory-desktop-contracts.ts", import.meta.url),
  "utf8",
);

test("0353 records which moment a published diary was written from", () => {
  // 按 tag 断言而不是按 idx：idx 必须等于它在清单里的位置（由
  // `migration-journal-coverage.test.ts` 把关），这里钉的是"它被登记了"这件事。
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0353_companion_diary_selected_id"),
    "迁移必须登记进 journal：migrate.ts 以 journal 为唯一清单来源",
  );
  assert.match(migration, /ALTER TABLE public\.companion_daily_summaries/);
  assert.match(migration, /ADD COLUMN selected_id text/);
  // 可空是合同的一部分：§5.7.5 允许 selected_id 为 null，老行为行也全是 NULL。
  assert.doesNotMatch(migration, /selected_id text NOT NULL/);
  // 长度与 companionDiarySelectionSchema.selected_id 同宽（max 80）。
  assert.match(migration, /char_length\(selected_id\) <= 80/);
  // 只加列，不动 0335 的 selection_reason。
  assert.doesNotMatch(migration, /DROP COLUMN/);
});

test("0353 documents what a null selected id means", () => {
  assert.match(migration, /COMMENT ON COLUMN public\.companion_daily_summaries\.selected_id/);
  assert.match(migration, /selected_id IS NULL = 她没有选出片段/);
});

test("the diary row and the desktop contract mirror the new column", () => {
  assert.match(dbSchema, /selectedId: text\("selected_id"\)/);
  assert.match(desktopContracts, /selectedId: z\.string\(\)\.max\(80\)\.nullable\(\)/);
});