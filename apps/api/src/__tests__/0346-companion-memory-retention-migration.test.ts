import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0346_companion_memory_retention.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ idx: number; tag: string }> };
const service = readFileSync(
  new URL("../modules/companion-conversation/memory/memory-service.ts", import.meta.url),
  "utf8",
);

test("0346 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0346_companion_memory_retention"));
});

test("归档上限是**双预算**：条数 + 字节，不是只数条数", () => {
  assert.match(migration, /ailearn_companion_memory_retention_limits/);
  // 只看条数会让一条超长记忆占满整层；只看字节会让几千条短记忆挤进来。
  assert.match(migration, /items integer, byte_count bigint/);
  assert.match(migration, /archived_items <= limit_items AND archived_bytes <= limit_bytes/,
    "两项都要判，只判一项等于没上限");
});

test("上限由**淘汰**执行，不是在移入时拒绝——否则归档满了连删记忆都做不到", () => {
  // 0344 的 resident 是"拒绝移入 + 给出可下沉建议"，那条对 resident 成立
  //（常驻上下文满了就不要再加新的）；对 archived 不成立。
  //
  // ⚠️ 这条断言读的是**本文件**（0346）。0362 把同一个函数换成了软删版，
  // 所以这里的 DELETE 断言守的是 0346 当初写下的形状，**不是现行行为**。
  // 现行形状由 `0362-companion-memory-retention-recycle-bin-migration.test.ts`
  // 守住（那里断言淘汰路径里**没有** DELETE）。
  const sweep = migration.slice(migration.indexOf("ailearn_enforce_companion_memory_retention"));
  assert.match(sweep, /DELETE FROM public\.assistant_memory_items/,
    "0346 当初就是硬删；0362 才换成软删——这条断言现在只描述历史形状");
  assert.match(sweep, /budget_tier = 'archived'/);
  assert.ok(!/status[\s\S]{0,40}capacity/.test(sweep),
    "归档这一层不该返回 resident 那套 capacity 拒绝");
});

test("淘汰顺序是机械的，不是「最新写入驱逐有效记录」", () => {
  const sweep = migration.slice(migration.indexOf("ailearn_enforce_companion_memory_retention"));
  // 第一步清已过声明期限的 —— 那是本来就该过期的，不是被容量挤掉的。
  assert.match(sweep, /valid_until IS NOT NULL[\s\S]*?valid_until <= now\(\)/);
  // 第二步才是容量淘汰，且顺序确定：最不重要 → 最久没用 → 最早更新 → id 兜底。
  assert.match(
    sweep,
    /ORDER BY importance ASC, last_used_at ASC NULLS FIRST, updated_at ASC, id ASC/,
  );
  assert.ok(!/ORDER BY[\s\S]{0,120}created_at DESC/.test(sweep),
    "出现 created_at DESC 就变成「新写入的留下、旧的挤掉」，那是 §4.6.6 明令禁止的");
});

test("固定（pinned）不参与容量淘汰", () => {
  const sweep = migration.slice(migration.indexOf("ailearn_enforce_companion_memory_retention"));
  assert.match(sweep, /AND pinned = false/,
    "用户固定的记忆不该被容量压力悄悄淘汰");
});

test("清扫走受控函数，不给客户端直接 DELETE", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.ailearn_enforce_companion_memory_retention\(\) FROM PUBLIC/);
});

test("服务层与迁移的归档上限一致——两处各写一个数就会漂移", () => {
  assert.match(service, /COMPANION_MEMORY_ARCHIVED_BUDGET_V1 = \{\s*items: 500,\s*byteCount: 400_000,/);
  assert.match(migration, /SELECT 500::integer, 400000::bigint/);
});

test("A74 的另一半：归档上限在读侧看得见", () => {
  // 只在迁移里设上限而读侧看不到，"还剩多少"就永远答不出来。
  assert.match(service, /archived: \{\s*used: MemoryBudgetUsageV1;\s*limits: typeof COMPANION_MEMORY_ARCHIVED_BUDGET_V1;/s);
});

test("【自证】判据认得出「只判条数」这个真实退化", () => {
  const halfGuard = "IF archived_items <= limit_items THEN RETURN 0; END IF;";
  assert.ok(!/byte_count/.test(halfGuard), "自证样本没造好");
  assert.ok(/archived_bytes/.test(migration), "自证：本迁移确实也判了字节");
});