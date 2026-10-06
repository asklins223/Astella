/**
 * 模型自改**表达层**的边界（40 §4.8.4）。
 *
 * ## 为什么这条要单独钉
 *
 * 合同给模型的自由是**有边界的**：
 *
 * > 「模型可在已允许的范围内修订自己的表达方式与角色偏好，**遵守用户显式设定，
 * >   不擅自改用户指定名字**；**不把本地关系/材料、用户推断或权限写进账号人格**。」
 *
 * 这些边界里有三条是**结构性**的——工具的参数里根本没有对应的字段，所以
 * 不可能写进去。剩下的（生效时点、版本留痕）由执行体保证。
 *
 * 曾经这条完全缺失：模型能改的只有活跃度与行为边界两个**开关**，
 * 「修订自己的表达方式」没有任何入口。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";

const definition = COMPANION_AGENT_TOOL_DEFINITIONS.find((d) => d.name === "companion_revise_own_style");

test("工具存在，且只需要「新的说法」与「为什么改」", () => {
  assert.ok(definition, "companion_revise_own_style 没注册");
  const props = definition!.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ["reason", "speakingStyle"]);
});

test("**没有** name 参数 —— 她改不了用户指定的名字", () => {
  // §4.8.4：「不擅自改用户指定名字」。这一条靠"参数里没有它"成立，
  // 而不是靠描述文案里那句叮嘱——文案会被改，结构不会。
  const props = definition!.parameters.properties as Record<string, unknown>;
  assert.ok(!("name" in props), "给了 name 参数就等于给了改名字的入口");
  assert.ok(!JSON.stringify(definition!.parameters).includes('"displayName"'));
});

test("**没有** 空间/材料/权限相关参数 —— 本地关系与用户推断进不来", () => {
  const props = definition!.parameters.properties as Record<string, unknown>;
  for (const forbidden of ["workspaceId", "noteId", "userId", "memoryId", "permissionLevel", "tools"]) {
    assert.ok(!(forbidden in props), `出现了 ${forbidden} —— 它不该在这个工具里`);
  }
  assert.equal(definition!.riskClass, "reversible_low", "改自己的表达是可逆的");
});

test("必须给出**理由** —— §4.8.4「记录作者、范围和依据」，用户能看到她为什么改", () => {
  const props = definition!.parameters.properties as Record<string, { minLength?: number }>;
  assert.ok(props.reason?.minLength, "reason 是可选的 —— 那就等于没有依据");
  assert.ok(((definition!.parameters.required ?? []) as string[]).includes("reason"));
});

test("说明里写清生效时点：下一次会话，不是这一轮", () => {
  // §4.8.4：「模型自改在下一次会话建立时生效；一次调用使用固定版本。」
  assert.match(definition!.description, /下一次/);
  assert.match(definition!.description, /下一次尚未开始的会话才生效/);
});

test("【自证】判据认得出「把 name 顺手加进去」这个真实退化", () => {
  // 退化形状：加了 name，于是"改说话方式"顺带变成"改名"。
  const degraded = { type: "object", properties: { speakingStyle: {}, name: { type: "string" } } };
  assert.ok("name" in degraded.properties, "自证样本没造好");
  // 正控制：真的那个没有。
  const props = definition!.parameters.properties as Record<string, unknown>;
  assert.ok(!("name" in props), "自证：注册表里确实没有 name");
});

test("【自证】判据认得出「reason 变成可选」这个半截退化", () => {
  const optionalReason = { type: "object", properties: { speakingStyle: {}, reason: { type: "string", minLength: undefined as number | undefined } } };
  assert.ok(!optionalReason.properties.reason.minLength, "自证样本没造好");
  const props = definition!.parameters.properties as Record<string, { minLength?: number }>;
  assert.ok(props.reason?.minLength, "自证：真的那个 reason 有长度下限");
});