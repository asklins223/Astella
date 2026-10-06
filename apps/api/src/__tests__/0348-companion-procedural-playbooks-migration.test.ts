import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0348_companion_procedural_playbooks.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string }> };

test("0348 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0348_companion_procedural_playbooks"));
});

test("手册有 §4.6.10 点名的七个字段", () => {
  for (const column of [
    "playbook_key", "title", "trigger_condition", "steps", "exceptions", "evidence", "version",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`), `缺 ${column}`);
  }
  // 稳定 ID：同一触发条件只能有一条
  assert.match(migration, /UNIQUE \(workspace_id, user_id, playbook_key\)/);
});

test("手册**不能**授权、排程或假装是用户说的——结构上就做不到", () => {
  // §4.6.10：「手册不能保存未经核实的事实、扩大工具范围或自动启动复习」
  //
  // ⚠️ 必须**先剥掉 SQL 注释**再扫：本迁移的注释里为了说明「刻意没有这几列」，
  // 正当正事写着 tool_scope / schedule / user_stated 这三个词。不剥的话这条判据
  // 会读到自己的说明文字，然后把正确的迁移判红——这正是 AGENTS.md 记的
  // 「扫源码的守卫会撞上注释」。
  const statements = migration.replace(/--[^\n]*/g, "");
  for (const forbidden of ["tool_scope", "toolScope", "schedule", "reminder", "user_stated"]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(statements),
      `表里不该出现 ${forbidden}——手册有了它就可能越权`,
    );
  }
  // 作者枚举里没有 user：手册永远是她或抽取器写的，不是用户说的
  assert.match(migration, /author text NOT NULL DEFAULT 'companion'\s+CHECK \(author IN \('companion', 'extractor', 'maintenance'\)\)/);
  // 【自证】剥注释这一步本身不是空转：注释里确实写过这些名字，
  // 正因为如此建表语句里的同名检查才有意义。
  assert.match(migration, /--[^\n]*table structure|不能授权任何动作|\btool_scope\b/,
    "自证样本没造好：本迁移至少在注释里提到过这个概念");
  assert.ok(!/\btool_scope\b/.test(statements), "自证：建表语句里确实没有它");
});

test("步骤与例外是**有序数组**，不是拼接文本", () => {
  assert.match(migration, /steps jsonb NOT NULL DEFAULT '\[\]'::jsonb CHECK \(jsonb_typeof\(steps\) = 'array'\)/);
  assert.match(migration, /exceptions jsonb NOT NULL DEFAULT '\[\]'::jsonb CHECK \(jsonb_typeof\(exceptions\) = 'array'\)/);
});

test("纠正与遗忘会**传播到手册**——用触发器，不靠每个删除路径记得调用", () => {
  // 删除有四条入口（API delete / worker forget / 纠正 / 离开空间），
  // 手写传播漏一条就意味着"她忘掉的东西还在手册里当依据"。
  assert.match(migration, /CREATE TRIGGER assistant_memory_playbook_evidence_guard/);
  assert.match(migration, /AFTER UPDATE ON public\.assistant_memory_items/);
  const fn = migration.slice(migration.indexOf("astella_propagate_playbook_evidence_change"));
  assert.match(fn, /NEW\.deleted_at IS NOT NULL/);
  assert.match(fn, /NEW\.revision <> OLD\.revision/);
  assert.match(fn, /epistemic_status = 'disputed'/);
  // 已经是 disputed 的不要再被反复更新（无意义的写放大）
  assert.match(fn, /epistemic_status <> 'disputed'/);
});

test("手册是本人私有、按 (workspace,user) 隔离", () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /user_id = NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/);
});

test("【自证】判据认得出「靠应用层记得传播」这个真实退化", () => {
  // 退化形状：没有触发器，靠删除路径里手写 UPDATE。
  const appLayerOnly = "UPDATE companion_procedural_playbooks SET epistemic_status='disputed' WHERE ...";
  assert.ok(!/TRIGGER/.test(appLayerOnly), "自证样本没造好");
  assert.match(migration, /CREATE TRIGGER/, "自证：本迁移确实用了触发器");
});