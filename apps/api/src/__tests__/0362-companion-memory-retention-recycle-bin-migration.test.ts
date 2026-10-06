/**
 * 0362：归档保留上限**走回收区**，不再硬删（40 §4.6.4 / §4.6.6）。
 *
 * ## 为什么有这条迁移
 *
 * 0346 用两条硬 DELETE 做归档保留上限。它绕过了整条删除边界：
 *
 * - 不写 `deleted_at` / `purge_after` ⇒ 用户无法恢复；
 * - 不写抑制墓碑 ⇒ 同源抽取把同一条记忆又记一遍；
 * - 版本捕获触发器是 `BEFORE INSERT OR UPDATE`，DELETE 根本不经它 ⇒ **没有版本快照**。
 *
 * §4.6.4 的原话是「来源与版本记录是业务合同，**不能静默丢失**」。那条硬删路径
 * 是唯一一条会静默丢版本的路径——所以 0362 把它换成软删。
 *
 * ## 为什么容量语义没有因此变松
 *
 * 容量统计的分母是 `budget_tier='archived' AND deleted_at IS NULL`。
 * 软删之后这些行立刻不再计入，所以「腾出了空间」这件事仍然成立，
 * 只是腾出来的方式从"消失"变成"可以捞回来"。
 *
 * ## 这份测试是对 .sql 文本的断言，不是数据库集成测试
 *
 * 真跑一次保留上限需要 Postgres + 向量列。那一层由
 * `companion-memory-budget-postgres.integration.ts` 负责（它跑的是 0344 的移动）；
 * 这里守的是「淘汰路径不再出现 DELETE」这条**合同**，它在 SQL 文本里就能判。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0362_companion_memory_retention_recycle_bin.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

const fn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.astella_enforce_companion_memory_retention"));

test("0362 已登记进 journal（清单是唯一迁移列表）", () => {
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0362_companion_memory_retention_recycle_bin"),
    "0362 没进 _journal.json：迁移存在但不会被执行",
  );
});

test("淘汰路径里不再有 DELETE —— 容量压力不该比用户自己的删除更不可逆", () => {
  assert.doesNotMatch(fn, /DELETE\s+FROM\s+public\.assistant_memory_items/,
    "保留上限又出现硬删：绕过了回收区、抑制墓碑与版本快照三条（40 §4.6.4）");
  assert.match(fn, /UPDATE public\.assistant_memory_items/,
    "两条淘汰路径都应该是软删而不是硬删");
});

test("软删带 purge_after = +30 天 ⇒ 进回收区、可恢复", () => {
  // §4.6.4：「普通删除即时抑制召回并进入可恢复回收区」。
  // 没有 purge_after 就等于"标记删除但永远不清理"或"到期就消失"——都不是。
  assert.match(fn, /purge_after = now\(\) \+ interval '30 days'/);
});

test("两条淘汰路径都写抑制墓碑 ⇒ 同源抽取不会把它重新记一遍", () => {
  // 这是硬删路径第二个静默失败：删了，但下一轮抽取又记回来。
  const suppressions = fn.match(/INSERT INTO public\.assistant_memory_source_suppressions/g) ?? [];
  assert.equal(suppressions.length, 2,
    "两条淘汰路径（过期清理、容量淘汰）都必须各写一次抑制墓碑");
  assert.match(fn, /ON CONFLICT \(user_id, kind, source_event_id\) DO NOTHING/);
});

test("淘汰顺序仍然是机械的，不是「新写入驱逐有效记录」（§4.6.6 明令禁止）", () => {
  assert.match(fn, /ORDER BY importance ASC, last_used_at ASC NULLS FIRST, updated_at ASC, id ASC/);
  assert.doesNotMatch(fn, /ORDER BY[\s\S]{0,120}created_at DESC/);
});

test("固定（pinned）不参与容量淘汰（§4.6.6「固定表达重要性」）", () => {
  assert.match(fn, /AND pinned = false/);
});

test("清扫函数仍然不给客户端直接调用", () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.astella_enforce_companion_memory_retention\(\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.astella_enforce_companion_memory_retention\(\) TO astella_worker/);
});

test("【自证】判据认得出「退回硬删」这个真实退化", () => {
  // 把 0362 的函数体换成 0346 那条硬删，判据必须变红——
  // 否则上面几条只是对着一个空壳文件点头。
  const hardDelete = `
    CREATE OR REPLACE FUNCTION public.astella_enforce_companion_memory_retention()
    RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE n integer;
    BEGIN
      WITH gone AS (
        DELETE FROM public.assistant_memory_items
         WHERE budget_tier = 'archived' AND deleted_at IS NULL AND pinned = false
        RETURNING 1
      ) SELECT count(*)::integer INTO n FROM gone;
      RETURN n;
    END $$;`;
  assert.doesNotMatch(hardDelete, /UPDATE public\.assistant_memory_items/,
    "自证样本没造好：它应当不含软删");
  assert.match(hardDelete, /DELETE\s+FROM\s+public\.assistant_memory_items/,
    "自证样本没造好：它应当含硬删");
});