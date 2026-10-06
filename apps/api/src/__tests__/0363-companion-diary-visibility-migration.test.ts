/**
 * 0363：日记的可见性、删除与撤权遮蔽（40 §10 / §11.1）。
 *
 * ## 要修的三个洞
 *
 * 1. **隐藏与删除两种语义无处落地**（§10）。`companion_daily_summaries` 曾经
 *    没有任何可见性列，路由只有两个 GET，界面只有两个按钮。§11.1 的第 4 行
 *    「删除一篇日记」与第 6 行「撤销材料权限 → 日记正文同步遮蔽」整行没有落点。
 * 2. **删掉的日记能被后台重写回来**（A12）。唯一索引 `(ws,user,date)` 挡得住
 *    「新增」，挡不住 handler 里的 `ON CONFLICT ... DO UPDATE` 把日期写回
 *    generated。这里给删除留墓碑，由 `BEFORE UPDATE` 触发器强制不可复活。
 * 3. **撤权遮蔽没有任何触发点**（A13）。§11.1 要求「日记正文中的复述、图片、
 *    引文、摘录同步遮蔽」，而 `sourceRefs` 连一个可查的落点都没有。
 *    0363 加了 `source_event_ids` 并用触发器在材料软删时遮蔽。
 *
 * ## 为什么撤权遮蔽放在数据库
 *
 * 材料被收回访问有多个入口（笔记软删、来源删除、空间成员移除），而
 * `apps/api/src/modules/note/` 之类不允许反向 import 伴星模块——层边界守卫
 * （40b §6.2）正好把这条路堵住了。放应用层就只剩"每条删除路径都记得调一次"，
 * 那正是这条合同原来失败的样子。触发器让它变成数据不变量。
 *
 * ## 这份测试是对 .sql 文本的断言
 *
 * 真跑一遍遮蔽需要 Postgres + 一条真实的日记。真跑那层留给集成测试；
 * 这里守的是「这三种语义在数据模型上分得开」这条**合同**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0363_companion_diary_visibility.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ tag: string }> };

test("0363 已登记进 journal（清单是唯一迁移列表）", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0363_companion_diary_visibility"));
});

test("隐藏与删除是**两个列**，不是一个布尔（§10 给它们的语义不同）", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS hidden_at timestamptz/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
  // 隐藏**不等于遗忘原事件**，所以隐藏不能写来源抑制——那是删除才做的。
  const hideComment = migration.slice(
    migration.indexOf("COMMENT ON COLUMN public.companion_daily_summaries.hidden_at"),
    migration.indexOf("COMMENT ON COLUMN public.companion_daily_summaries.deleted_at"),
  );
  assert.match(hideComment, /不写来源抑制/,
    "隐藏的说明里必须写明它不写抑制表——否则实现会顺手把两者合并");
});

test("删除理由可查：用户主动删 vs 撤权遮蔽，界面上措辞不同", () => {
  assert.match(migration, /delete_reason text\s*\n?\s*CHECK \(delete_reason IS NULL OR delete_reason IN \('user_deleted', 'revoked_source'\)\)/);
});

test("删除过的日期不可被重新发布（A12「迟到任务不复活」）", () => {
  assert.match(migration, /CREATE TRIGGER companion_daily_summaries_no_republish/);
  assert.match(migration, /BEFORE UPDATE ON public\.companion_daily_summaries/);
  // 只拦"复活"：删除本身、隐藏、其它列的正常更新都不该被这条触发器挡。
  assert.match(migration, /IF NEW\.deleted_at IS NULL AND OLD\.deleted_at IS NOT NULL THEN/);
});

test("撤权遮蔽有数据级触发点，挂在材料软删上（A13）", () => {
  assert.match(migration, /CREATE TRIGGER companion_diary_mask_on_note_delete[\s\S]*?ON public\.notes/);
  assert.match(migration, /CREATE TRIGGER companion_diary_mask_on_source_delete[\s\S]*?ON public\.sources/);
  // 只在"刚变成已删除"时触发：反复更新一行不该重复遮蔽。
  assert.match(migration, /IF NEW\.deleted_at IS NULL OR OLD\.deleted_at IS NOT NULL THEN\s*\n\s*RETURN NULL/);
});

test("撤权遮蔽按 source_event_ids 匹配，而不是靠正文里猜来源", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS source_event_ids text\[\]/);
  assert.match(migration, /source_event_ids @> ARRAY\[NEW\.id::text\]/,
    "遮蔽匹配必须走 GIN 索引的那一列；靠 facts 里的计数列猜不出正文用了哪份材料");
});

test("撤权遮蔽**只遮蔽不物理删**摘录——材料可能重新可访问", () => {
  const fn = migration.slice(migration.indexOf("astella_mask_diaries_for_revoked_source()"));
  assert.match(fn, /SET masked = true/);
  assert.doesNotMatch(fn, /DELETE FROM public\.companion_discovery_entries/,
    "撤权遮蔽把摘录物理删掉了：材料重新可访问时那些内容就回不来了");
});

test("【自证】判据认得出「把隐藏和删除合并成一个布尔」这个真实退化", () => {
  // 退化形状：一列 `visible boolean default true`，隐藏与删除共用。
  // 后果是恢复时无法区分"我只是藏起来了"和"它已经被删掉了"。
  const degenerate = "ALTER TABLE companion_daily_summaries ADD COLUMN visible boolean NOT NULL DEFAULT true;";
  assert.doesNotMatch(degenerate, /hidden_at|deleted_at/,
    "自证样本没造好：它只有一个可见性布尔");
  assert.doesNotMatch(migration, /ADD COLUMN IF NOT EXISTS visible boolean/,
    "真的有人把两种语义合并成了一列");
});