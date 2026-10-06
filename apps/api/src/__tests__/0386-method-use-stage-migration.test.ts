import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0386_method_use_stage.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 方案 44 §6.3：「阅读次数不能直接记成采用或有帮助」。
// 这张表原先只有一种行、统计口径是 count(*)，所以恰好不出错；加上「目录被提供」
// 之后就会把 offer 一起算成阅读——先给记录一个阶段，再把口径按阶段收紧。
test("0386 splits offered / read / adopted on every method-use row", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 382 && entry.tag === "0386_method_use_stage"));
  assert.match(migration, /ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'read'/);
  assert.match(migration, /CHECK \(stage IN \('offered', 'read', 'adopted'\)\)/);
});

test("0386 keeps existing rows meaning what they meant", () => {
  // 存量行都是 readAgentMethod 插的阅读记录；默认值取 'read' 才不会改写历史语义。
  assert.match(migration, /DEFAULT 'read'/);
  assert.ok(!/DEFAULT 'offered'/.test(migration));
});

test("0386 refuses quality feedback on methods that were never read", () => {
  assert.match(migration, /CHECK \(feedback IS NULL OR stage IN \('read', 'adopted'\)\)/);
});
