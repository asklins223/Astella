import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 0358 发现簿迁移的**约束**判据。
 *
 * 这些不是"写法偏好"，每一条都对应 §7 里一句可静默违反的要求：
 * 共用身份、取消收藏不删原始内容、私人内容默认不跨空间、书房只放少量。
 */
const migration = readFileSync(
  new URL("../db/migrations/0358_companion_discovery_entries.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string; idx: number }> };

test("0358 已登记，且 idx 紧跟上一条", () => {
  const at = journal.entries.findIndex((e) => e.tag === "0358_companion_discovery_entries");
  assert.ok(at >= 0, "0358 没有登记进 journal —— migrate 不会跑它");
  assert.equal(journal.entries[at].idx, journal.entries[at - 1].idx + 1, "idx 不连号");
});

test("共用收藏身份：同一份内容只能有一行", () => {
  // §7：「同一条内容在笔记旁和发现簿里出现时共用收藏身份，编辑批注或取消收藏
  // **同步生效**。」靠的是这个唯一索引。
  assert.match(migration, /CREATE UNIQUE INDEX companion_discovery_entries_identity_key\s+ON public\.companion_discovery_entries \(workspace_id, user_id, kind, source, source_id\)/,
    "没有 (workspace,user,kind,source,source_id) 唯一索引 —— 同一份内容会长出两行，两处的批注与取消就不再同步");
});

test("取消收藏是 `visible=false`，**没有删除路径**", () => {
  // §7：「取消收藏不删除原始回答或日记。」表里没有 deleted_at，也没有触发器
  // 去级联；被误写成级联时，界面上看不出来，只在某一天用户发现日记没了。
  assert.ok(!/deleted_at/i.test(migration), "表里出现了 deleted_at —— 那是删除路径，§7 不允许");
  assert.ok(!/\bON DELETE CASCADE\b/i.test(migration), "出现了 ON DELETE CASCADE —— 来源一删，收藏就跟着没了");
  assert.match(migration, /visible boolean NOT NULL DEFAULT true/);
});

test("正文快照与批注**分两列** —— 编辑批注不改写原文", () => {
  assert.match(migration, /body text NOT NULL/);
  assert.match(migration, /annotation text/);
});

test("作者只有 user / assistant，且 AI 建议不许标成 user", () => {
  assert.match(migration, /CHECK \(author IN \('user', 'assistant'\)\)/,
    "作者没有取值域 —— 「标清作者」就落空了");
  // §7「各自标清作者和来源」：用户保留的 AI 建议若标成 user，在簿子里读起来
  // 就成了用户自己写的。
  assert.match(migration, /CONSTRAINT companion_discovery_entries_kind_author_check\s+CHECK \(author <> 'user' OR kind <> 'kept_ai_suggestion'\)/,
    "AI 建议可以标成 user —— 那冒充了用户自己的话");
});

test("日记摘录必须带日记来源（A18「标伴星与日记来源」）", () => {
  assert.match(migration, /CHECK \(kind <> 'diary_excerpt' OR source = 'diary'\)/);
});

test("可见性**默认 private** —— §7「私人内容默认不跨空间、跨成员展示」", () => {
  assert.match(migration, /visibility text NOT NULL DEFAULT 'private'/,
    "默认不是 private —— 那等于默认跨空间");
  assert.match(migration, /CHECK \(visibility IN \('private', 'space', 'study'\)\)/);
});

test("书房只放少量：由**数据库**守住，第六条插不进来", () => {
  // §7「书房仅展示用户愿意放出的少量痕迹」。只靠上层算的话，一次并发就能
  // 插出第七条——所以这个数字要落在触发器里。
  assert.match(migration, /ailearn_discovery_study_trace_limit/);
  assert.match(migration, /existing_count >= 6/);
  assert.match(migration, /CREATE TRIGGER companion_discovery_study_trace_guard/);
});

test("表约束名不与内联 CHECK 的自动命名撞车", () => {
  // Postgres 把 `author text NOT NULL CHECK (...)` 自动命名成
  // `{table}_author_check`。若表约束也叫那个名，一建表就报
  // "check constraint already exists" —— 迁移在真实库上直接失败。
  assert.ok(!/CONSTRAINT companion_discovery_entries_author_check/.test(migration),
    "这条表约束与内联 CHECK 的自动名撞了");
  assert.match(migration, /CONSTRAINT companion_discovery_entries_kind_author_check/);
});

test("来源撤权/删除后**遮蔽**而不是删行", () => {
  assert.match(migration, /masked boolean NOT NULL DEFAULT false/,
    "没有 masked 列 —— 撤权之后只能删行，而删掉就看不出「这里曾经有过」");
});

test("簿子与空间绑死：不能跨空间搬、不能换主人", () => {
  assert.match(migration, /ailearn_discovery_visibility_guard/);
  assert.match(migration, /discovery entries do not move across workspaces/);
  assert.match(migration, /discovery entries do not change owner/);
});

test("RLS 打开且 FORCE —— 用户之间隔离", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /app\.user_id/);
});

test("没有「成长里程碑」这类自动产物（§7 明令不自动生产）", () => {
  // §7：「不按正确率或事件数量自动生产『成长里程碑』。」表里不该有分数、
  // 计数或里程碑一类可由它们长出来的列。
  for (const forbidden of ["milestone", "score", "accuracy", "streak", "growth"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`, "i").test(migration),
      `表里出现了 ${forbidden} —— 那正是「自动里程碑」需要的原料`);
  }
});


// ── ACL ────────────────────────────────────────────────────────────────
//
// 这一段是**真跑真库**才补上的：迁移与当时全部静态测试都通过，
// `GET /companion/discovery` 却稳定 500（`permission denied for table`）。
// 原因是 RLS 只管「能看哪些行」，**ACL 才管「能不能碰这张表」**——两者独立，
// 而当时的迁移测试只断言了约束与触发器。
//
// 所以这一条不是"顺手加的"：它记的是一条**只会在真库上暴露**的判据。

test("发现簿表把权限给了 api 与 worker 角色", () => {
  // 与 0350 那条对照：companion_daily_summaries 的 ACL 里有 ailearn_api=arwd。
    for (const role of ["ailearn_api", "ailearn_worker"]) {
    assert.match(
      migration,
      new RegExp(`GRANT[^;]*ON public\\.companion_discovery_entries TO ${role}`),
      `没有 GRANT 给 ${role} —— 真库上会是 permission denied，而静态测试全绿`,
    );
  }
});
