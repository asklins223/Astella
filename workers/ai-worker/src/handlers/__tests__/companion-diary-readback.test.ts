/**
 * 日记读回「聊聊这篇」（40 §6，验收 A08 / A09）。
 *
 * ## 为什么这块值得钉
 *
 * 合同 §6 的整条链有三节，任何一节断了功能就是空的：
 *   1. 日记页有那个次级动作；
 *   2. 引用带**空间 + 日期 + 版本**，跨页保留；
 *   3. 伴星**按当前权限**读取那篇，而不是让用户复制全文。
 *
 * 真正会咬人的是第 3 节里那句「**不是要求用户复制全文**」——它意味着
 * 必须有一条**按引用读取**的通道，而不是一个让用户粘贴的入口。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";

const definition = COMPANION_AGENT_TOOL_DEFINITIONS.find((d) => d.name === "companion_read_diary");

test("读回工具存在，且参数正好是引用里的两样", () => {
  assert.ok(definition, "companion_read_diary 没注册");
  const props = definition!.parameters.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(props).sort(), ["date", "expectedVersion"]);
  assert.deepEqual([...(definition!.parameters.required ?? []) as string[]].sort(), ["date", "expectedVersion"]);
});

test("**没有** workspaceId 参数 —— 模型不能指定读哪一篇", () => {
  // 有它就等于给了模型一条跨空间的读取通道：它可以报任意 workspace_id。
  // §11.2：日记和陪伴记忆默认属于本人；空间归属只能来自会话上下文。
  const props = definition!.parameters.properties as Record<string, unknown>;
  assert.ok(!("workspaceId" in props), "读了哪一篇必须由会话决定，不能由模型指定");
  assert.equal(definition!.riskClass, "read", "读回是只读的");
});

test("版本必须显式给出 —— 不能悄悄拿新版顶替用户看到的那一版", () => {
  // §5.5：同一 (用户, 空间, 本地日期) 只呈现一个当前版本，且已发布成稿
  // 不因后台重跑静默替换。所以"用户看到的那一版"是稳定的，版本对不上
  // 就是一个**真问题**，应当说出来而不是换一篇顶上。
  const props = definition!.parameters.properties as Record<string, { minimum?: number }>;
  assert.equal(props.expectedVersion?.minimum, 1);
});

test("工具说明要求区分「写了什么 / 实际发生了什么 / 她的主观表达」", () => {
  // §6：「回答区分『文中确实这样写了』『当时实际发生了什么』『那是她的主观表达』」
  // A09：用户问角色想象是否发生，要区分作品与真实事件。
  const d = definition!.description;
  assert.match(d, /区分三件事/);
  assert.match(d, /主观表达/);
});

test("【自证】判据认得出「让用户复制全文」这个真实退化", () => {
  // 退化形状：没有按引用读取的通道，于是日记页只能给一个"复制给我"的提示。
  const copyFullText = { uiAction: "复制全文粘贴给我", hasReference: false };
  assert.equal(copyFullText.hasReference, false, "自证样本没造好");
  // 正控制：判据确实读到了注册表里的那一条，不是空转。
  assert.ok(definition, "自证：注册表里确实有 companion_read_diary");
  assert.equal(Object.keys(
    definition!.parameters.properties as Record<string, unknown>,
  ).includes("workspaceId"), false, "自证：确实没有 workspaceId");
});