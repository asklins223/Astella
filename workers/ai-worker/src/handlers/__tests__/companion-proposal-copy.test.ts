import assert from "node:assert/strict";
import test from "node:test";

import { getCompanionAgentTool, proposedLearningActionPayloadV1Schema } from "@astella/shared";
import { describeAgentProposal } from "../agent/companion-proposal-copy.ts";

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

test("新建与修改预览说明各自的保存结果，取消不声称发生回滚", () => {
  // 新建与修改现在共用一个工具面；区别在预览里有没有改前全文。
  const review = (preview: { markdown?: string; beforeMarkdown?: string }) => describeAgentProposal(payload({
    kind: "agent_tool_review", toolName: "companion_notes_write", arguments: {}, confirmationStage: "after_preview",
    preview: { title: "周三散步", ...preview },
  }), "companion_notes_write");
  const create = review({ markdown: "晚上散步二十分钟" });
  const edit = review({ markdown: "晚上散步三十分钟", beforeMarkdown: "晚上散步二十分钟" });
  assert.match(create.title, /这篇手记/);
  assert.match(create.impactSummary, /新手记/);
  assert.doesNotMatch(create.impactSummary, /恢复|原文/);
  assert.match(edit.impactSummary, /取消不会改变原文/);
});

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
