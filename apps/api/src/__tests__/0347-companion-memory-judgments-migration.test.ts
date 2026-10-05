import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0347_companion_memory_judgments.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string }> };
const registry = readFileSync(
  new URL("../../../../packages/shared/src/companion-capability-manifest.ts", import.meta.url),
  "utf8",
);

test("0347 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0347_companion_memory_judgments"));
});

test("判断的依据是**多条**事件——单值列表达不了", () => {
  assert.match(migration, /ADD COLUMN source_event_ids text\[\]/);
  // §4.5.4 把 source_event_ids（复数）列为判断记录的必备字段。
  assert.match(migration, /array_length\(source_event_ids, 1\) >= 1/);
});

test("无来源的判断**写不进去**——用 CHECK 钉在数据库里，不靠调用方自觉", () => {
  const check = migration.slice(
    migration.indexOf("assistant_memory_judgment_shape_check"),
  );
  assert.match(check, /source_event_ids IS NOT NULL/);
  assert.match(check, /array_length\(source_event_ids, 1\) >= 1/);
  assert.match(check, /kind <> 'judgment'\s+OR\s+\(/,
    "这一条约束必须只作用于 judgment，事实记忆不受影响");
});

test("判断永远不是「用户自述」，也永远不跨空间", () => {
  const check = migration.slice(migration.indexOf("assistant_memory_judgment_shape_check"));
  // §4.5.4：判断由她提出，不是用户说的。
  assert.match(check, /user_stated = false/);
  // §4.5.5：模型不通过判断接口绕过跨空间限制。
  assert.match(check, /scope <> 'global'/);
  // 触发器是第二道：万一有别的写路径绕过 CHECK，scope='global' 仍然被拒。
  assert.match(migration, /assistant_memory_judgment_scope_guard/);
  assert.match(migration, /RAISE EXCEPTION 'judgment memories must stay workspace-scoped/);
});

test("认识状态必须显式，且与 0336 同源", () => {
  assert.match(migration, /epistemic_status IN \('supported', 'tentative', 'disputed'\)/);
  // DROP ... IF EXISTS：0336 已经建过同名约束，重复迁移不能炸。
  assert.match(migration, /DROP CONSTRAINT IF EXISTS assistant_memory_items_epistemic_status_check/);
});

test("抑制表与 kind 枚举**一起放开**——否则「忘掉一条判断」会撞 CHECK", () => {
  assert.match(migration, /assistant_memory_source_suppressions[\s\S]*?judgment/,
    "0330 建的抑制表带 kind CHECK；不加 judgment 的话 A29 的删除会报错");
});

test("工具契约存在，且参数就是合同点名的三样", () => {
  assert.match(registry, /companion_remember_judgment/);
  assert.match(registry, /sourceEventIds[\s\S]*?min\(1\)\.max\(8\)/,
    "依据事件必填且有界（§4.5.5：无来源不能写成长期记录）");
  assert.match(registry, /epistopic|epistemicStatus: z\.enum\(\["supported", "tentative", "disputed"\]\)/);
  assert.match(registry, /text: z\.string\(\)\.min\(1\)\.max\(200\)/,
    "§4.5.5：单条 ≤200 字");
});

test("【自证】判据认得出「判断混进事实记忆」这个真实退化", () => {
  // 退化形状：复用 preference 这类事实 kind，靠 author_type 区分。
  const degenerate = "kind = 'preference' AND author_type = 'companion'";
  assert.ok(!/judgment/.test(degenerate), "自证样本没造好");
  assert.match(migration, /'judgment'/, "自证：本迁移确实新增了这个 kind");
  assert.match(migration, /user_stated = false/, "自证：本迁移确实禁止它标成用户自述");
});
