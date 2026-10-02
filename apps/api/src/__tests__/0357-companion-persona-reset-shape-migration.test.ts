import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0357_companion_persona_reset_shape.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string }> };
const service = readFileSync(
  new URL("../modules/companion-conversation/pet-profile-service.ts", import.meta.url),
  "utf8",
);

test("0357 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0357_companion_persona_reset_shape"));
});

test("reset 快照允许**非空** profile —— 名字与开关必须留得住", () => {
  // 0341 那条 `action<>'reset' OR profile IS NULL` 编码的是**旧**语义：
  // reset ⇒ 整份回到默认。而 A51 明令那不该发生。
  assert.match(migration, /DROP CONSTRAINT companion_persona_profile_versions_action_shape_check/);
  const check = migration.slice(migration.lastIndexOf("ADD CONSTRAINT companion_persona_profile_versions_action_shape_check"));
  assert.ok(!/action <> 'reset' OR profile IS NULL/.test(check),
    "旧约束还在 —— reset 带非空 profile 仍会在真库上失败");
});

test("但「空文本不是有效覆盖」这条要留下（40b §5.2）", () => {
  const check = migration.slice(migration.lastIndexOf("ADD CONSTRAINT companion_persona_profile_versions_action_shape_check"));
  assert.match(check, /action <> 'reset' OR COALESCE\(profile->>'speakingStyle', ''\) <> ''/,
    "放宽不能顺带把『空表达也算覆盖』也放进来");
  // 原来那条有价值的部分保留：非 reset 行的 profile 必须存在。
  assert.match(check, /profile IS NOT NULL OR action IN \('reset', 'restore'\)/);
});

test("服务层确实会写非空 reset 行 —— 否则这条迁移是在放一个用不到的约束", () => {
  // resetPetProfile 现在写 `next`（保留身份后的档案），而不是恒为 null。
  assert.match(service, /expressionResetProfile/);
  const reset = service.slice(service.indexOf("export async function resetPetProfile"));
  assert.match(reset, /const next = current \? expressionResetProfile\(current\) : null;/);
  assert.match(reset, /profile: next/);
});

test("【自证】判据认得出「把 reset 快照改回写 null」这个取巧形状", () => {
  // 取巧做法能让约束通过，但版本历史会开始说谎：
  // 那一行声称"整份回到默认"，而实际发生的是"表达回到默认、身份保留"。
  const sneaky = "await writeCurrentProfile(executor, scope, revision, null, now);";
  assert.ok(!/purge_after|expressionResetProfile/.test(sneaky), "自证样本没造好");
  assert.match(service, /expressionResetProfile/,
    "自证：服务层确实走的是「只重置表达」那条路，所以约束必须放宽");
});