import assert from "node:assert/strict";
import test from "node:test";

import { getCompanionAgentTool, proposedLearningActionPayloadV1Schema } from "@astella/shared";
import { describeAgentProposal } from "../companion-proposal-copy.ts";

/**
 * 提案卡三行文案的判据（2026-10-05）。
 *
 * 改动的起因：那张卡原本直接印工具描述。用户看到的是「执行 仅保存用户本轮明确要求
 * 记住或以后遵循的新内容；遵循已有偏好、」——一屏写给模型的行为约束，而他要判断的
 * 只是「这次到底要不要按下去」。
 *
 * 所以这里锁三件事：**说的是不是那件事**、**有没有把模型的规则漏给用户**、
 * **截断后是否还像一句人话**。
 */

const SAVE_MEMORY_DESCRIPTION =
  getCompanionAgentTool("companion_save_memory")?.description ?? "";

/** 描述里有没有哪一段（≥12 字）原样出现在用户看得到的文案里。 */
function leakedFromDescription(text: string): string | null {
  for (let at = 0; at + 12 <= SAVE_MEMORY_DESCRIPTION.length; at += 1) {
    const window = SAVE_MEMORY_DESCRIPTION.slice(at, at + 12);
    if (text.includes(window)) return window;
  }
  return null;
}

function payload(value: unknown) {
  const parsed = proposedLearningActionPayloadV1Schema.safeParse(value);
  assert.ok(parsed.success, `测试样例没过 payload schema：${JSON.stringify(parsed.error?.issues)}`);
  return parsed.data;
}

test("保存记忆：目标那行指名要记的内容，不印工具描述", () => {
  const copy = describeAgentProposal(payload({
    kind: "save_memory",
    memoryKind: "preference",
    content: "我更喜欢先看结论再推导",
    sourceQuote: "我更喜欢先看结论再推导",
    appliesWhen: null,
    validUntil: null,
  }), "companion_save_memory");

  assert.match(copy.title, /偏好/);
  assert.ok(copy.targetSummary.includes("我更喜欢先看结论再推导"), "目标那行没有指名要记的内容");
  for (const [field, text] of Object.entries(copy)) {
    const leak = leakedFromDescription(text);
    assert.equal(leak, null, `${field} 漏出了工具描述里的「${leak}」`);
  }
});

test("保存记忆：适用条件逐字保留，期限不落成一个服务端算的日期", () => {
  const copy = describeAgentProposal(payload({
    kind: "save_memory",
    memoryKind: "goal",
    content: "年底前把证书考下来",
    sourceQuote: "年底前把证书考下来",
    appliesWhen: "复习安排时",
    validUntil: "2026-12-31T23:59:00+08:00",
  }), "companion_save_memory");

  assert.ok(copy.targetSummary.includes("复习安排时"), "适用条件被改写了——它必须逐字来自用户原话");
  assert.ok(
    !/2026-12-31|2026\/12\/31|12 月 31/.test(copy.targetSummary),
    "服务端把 UTC 时刻印成了日期：同一时刻在客户端本地时区渲染会差一天",
  );
  assert.match(copy.targetSummary, /到期/);
});

test("保存记忆：200 字的长内容截断后仍在合同上限内，且不以悬空标点收尾", () => {
  const copy = describeAgentProposal(payload({
    kind: "save_memory",
    memoryKind: "learning_context",
    content: "我正在跟一门叫分布式系统的课，".repeat(8).slice(0, 200),
    sourceQuote: null,
    appliesWhen: null,
    validUntil: null,
  }), "companion_save_memory");

  assert.ok(copy.title.length <= 80, `标题 ${copy.title.length} 字，超了合同上限`);
  assert.ok(copy.targetSummary.length <= 160, `目标 ${copy.targetSummary.length} 字，超了合同上限`);
  assert.ok(copy.impactSummary.length <= 240, `影响 ${copy.impactSummary.length} 字，超了合同上限`);
  assert.doesNotMatch(copy.targetSummary, /[、，；：。\s]$/, "目标那行以悬空的标点收尾");
});

test("换题用模型写的理由，不用用户读不出来的 alternativeId", () => {
  const copy = describeAgentProposal(payload({
    kind: "switch_task_variant",
    runId: "3f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60",
    taskId: "4f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60",
    alternativeId: "variant-7f3a",
    reason: "这道题的图看不清",
  }), "companion_switch_task_variant");

  assert.ok(copy.targetSummary.includes("这道题的图看不清"));
  assert.ok(!copy.targetSummary.includes("variant-7f3a"), "alternativeId 是内部 id，用户读不出来");
});

test("提示层级沿用作答工位上的措辞，并说清这一轮只计练习分", () => {
  const base = { kind: "request_hint_level", runId: "3f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60", taskId: "4f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60" };
  assert.equal(describeAgentProposal(payload({ ...base, level: 1 }), "companion_request_hint").title, "给我一点提示");
  assert.equal(describeAgentProposal(payload({ ...base, level: 3 }), "companion_request_hint").title, "看第 3 级提示");
  assert.match(
    describeAgentProposal(payload({ ...base, level: 2 }), "companion_request_hint").impactSummary,
    /只计练习分/,
  );
});

test("活跃度与延期复习：说的是用户看得懂的那一档 / 那句话", () => {
  assert.equal(
    describeAgentProposal(payload({ kind: "set_pet_activeness", activeness: "quiet" }), "companion_set_activeness").title,
    "把活跃度调成安静",
  );
  const defer = describeAgentProposal(payload({
    kind: "defer_review",
    scheduleId: "5f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60",
    scheduleGeneration: 3,
    deferredUntil: "2026-10-12T09:00:00Z",
    reasonCode: "user_requested",
  }), "companion_defer_review");
  assert.equal(defer.targetSummary, "你说现在不方便");
  assert.ok(!defer.targetSummary.includes("2026-10-12"));
});

test("每一种 kind 都产出三行、都在合同上限内", () => {
  const uuid = "6f0d6a2c-1f0f-4a1e-9a6e-1b2c3d4e5f60";
  const samples: Record<string, unknown> = {
    resume_learning_run: { kind: "resume_learning_run", runId: uuid },
    start_learning_run_v2: { kind: "start_learning_run_v2", request: { originV2: { kind: "today", objectiveId: uuid }, goal: "stabilize", idempotencyKey: "k", requestedTimeBudgetSeconds: 180 } },
    save_memory: { kind: "save_memory", memoryKind: "goal", content: "先看完再动手" },
    revise_memory: { kind: "revise_memory", memoryId: uuid, expectedRevision: 2, content: "先动手再看" },
    set_pet_activeness: { kind: "set_pet_activeness", activeness: "moderate" },
    pause_learning_run: { kind: "pause_learning_run", runId: uuid },
    request_hint_level: { kind: "request_hint_level", runId: uuid, taskId: uuid, level: 2 },
    switch_task_variant: { kind: "switch_task_variant", runId: uuid, taskId: uuid, alternativeId: "a", reason: "换个说法" },
    defer_review: { kind: "defer_review", scheduleId: uuid, scheduleGeneration: 1, deferredUntil: "2026-10-12T09:00:00Z", reasonCode: "temporary_unavailable" },
    focus_graph_node: { kind: "focus_graph_node", keyPointId: uuid, lens: "evidence" },
    open_review: { kind: "open_review" },
    open_card: { kind: "open_card", cardId: uuid },
    open_star_map: { kind: "open_star_map" },
    restore_graph_viewport: { kind: "restore_graph_viewport", runId: uuid },
    open_conversation_history: { kind: "open_conversation_history" },
    confirm_or_reject_memory: { kind: "confirm_or_reject_memory", memoryId: uuid, revision: 1, decision: "confirm" },
    delete_assistant_memory: { kind: "delete_assistant_memory", memoryId: uuid, revision: 1 },
  };
  // 词表上挂了 `.superRefine()`（时间元数据那一条），所以 options 得从内层 union 取；
  // 这条断言的作用是「新加一种 kind 时这里会红」，逼着同时决定它的文案。
  const union = proposedLearningActionPayloadV1Schema as unknown as {
    _def: { schema: { options: ReadonlyArray<{ shape: { kind: { value: string } } }> } };
  };
  const knownKinds = union._def.schema.options.map((option) => option.shape.kind.value);
  assert.deepEqual(Object.keys(samples).sort(), [...knownKinds].sort(), "kind 词表与样例不同步");

  for (const [kind, sample] of Object.entries(samples)) {
    const copy = describeAgentProposal(payload(sample), "companion_open_note");
    for (const [field, text] of Object.entries(copy)) {
      assert.ok(text.length > 0, `${kind} 的 ${field} 是空的`);
      assert.doesNotMatch(text, /^执行/, `${kind} 的 ${field} 还带着旧的「执行…」前缀`);
    }
    assert.ok(copy.title.length <= 80, `${kind} 标题超限`);
    assert.ok(copy.targetSummary.length <= 160, `${kind} 目标超限`);
    assert.ok(copy.impactSummary.length <= 240, `${kind} 影响超限`);
  }
});

test("没有专门文案的 kind 退回注册表里的展示名，去掉进行时的「正在」", () => {
  const copy = describeAgentProposal(payload({ kind: "open_review" }), "companion_list_due_reviews");
  assert.equal(copy.title, "看到期复习");
  assert.equal(describeAgentProposal(payload({ kind: "open_review" }), "companion_unknown_tool").title, "要做一件事");
});