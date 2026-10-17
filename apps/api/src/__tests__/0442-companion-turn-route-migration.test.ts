import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0442_companion_turn_route.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };

// 2026-10-17：首字的账 = 网关首 token + 路由/放行增量，而这两个数的比例每轮都在变。
// 只写日志时"这轮慢是分类器超时还是模型慢"要人去对两条日志；落成一列之后，
// `route.classifier.elapsedMs` 可以直接和首字事件时间相减。
test("0442 registers the per-turn routing record on turn runs", () => {
  assert.ok(journal.entries.some((entry) => entry.idx === 438 && entry.tag === "0442_companion_turn_route"));
  assert.match(migration, /ALTER TABLE public\.companion_turn_runs/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS route jsonb/);
});

test("0442 documents that the column carries routing readings, not conversation text", () => {
  assert.match(migration, /COMMENT ON COLUMN public\.companion_turn_runs\.route/);
  assert.match(migration, /no conversation text/i);
});
