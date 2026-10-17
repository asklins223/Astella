import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { judgeCompanionStepClosing, waitingConfirmationReceipts } from "../turn/companion-step-closing.ts";
import { judgeCompanionUnavailableTool } from "../tools/companion-unavailable-tool.ts";
import { companionProviderFitsRequest } from "../agent/companion-provider-fit.ts";
import { namesCurrentNoteRead } from "../note/companion-note-prefetch.ts";

/**
 * Behaviour of the decision helpers extracted out of the agent loop on
 * 2026-10-17. Each one answers a question the loop used to ask inline, so the
 * tests assert the answers rather than the shape of the loop.
 */

test("收尾判定：明确发布或静默决定都直接结算，失败调用不结算", () => {
  const message = (id: string, ok: boolean) => ({ role: "tool", toolCallId: id, content: JSON.stringify({ ok }) });
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

  const published = judgeCompanionStepClosing({
    calls: [call("a", "companion_publish_utterance")],
    messages: [message("a", true)], initiative: false, writingAnnotation: false,
  });
  assert.equal(published.settleAs, "silent", "发布即结果，不必再问模型一轮");

  const publishedWithAnnotation = judgeCompanionStepClosing({
    calls: [call("a", "companion_write_annotation"), call("b", "companion_publish_utterance")],
    messages: [message("a", true), message("b", true)], initiative: false, writingAnnotation: true,
  });
  assert.equal(publishedWithAnnotation.settleAs, "annotation", "批注已落地时语音失败不能重开生成");

  const failedSpeech = judgeCompanionStepClosing({
    calls: [call("a", "companion_publish_utterance")],
    messages: [message("a", false)], initiative: false, writingAnnotation: false,
  });
  assert.equal(failedSpeech.settleAs, "none", "回执失败不能当成已结算");
  assert.equal(failedSpeech.allSucceeded, false);

  const silentInitiative = judgeCompanionStepClosing({
    calls: [call("a", "companion_finish_participation")],
    messages: [message("a", true)], initiative: true, writingAnnotation: false,
  });
  assert.equal(silentInitiative.settleAs, "silent");

  const toolThenAnswer = judgeCompanionStepClosing({
    calls: [call("a", "companion_read_note")],
    messages: [message("a", true)], initiative: false, writingAnnotation: false,
  });
  assert.equal(toolThenAnswer.settleAs, "none", "普通工具步必须继续，不能就此交卷");
});

test("等待确认：第一个调用标等待，后面的调用如实标未执行", () => {
  const receipts = waitingConfirmationReceipts("77c1b0d4-3f0e-4c55-9a1a-0d1e3c5b0a11", [
    { id: "first", name: "companion_edit_note", arguments: {} },
    { id: "second", name: "companion_share_note", arguments: {} },
  ], 0);
  assert.equal(receipts.length, 2);
  const first = JSON.parse(receipts[0]!.content);
  const second = JSON.parse(receipts[1]!.content);
  assert.equal(first.status, "waiting_confirmation");
  assert.equal(second.status, "not_executed");
  assert.equal(second.deferredByProposalId, "77c1b0d4-3f0e-4c55-9a1a-0d1e3c5b0a11");
  assert.ok(second.summary.includes("尚未执行"));
});

test("不可用工具：说清缺的是哪个开关，额度用尽与能力关闭分开记", () => {
  const visionOff = judgeCompanionUnavailableTool({
    toolName: "companion_read_image", constraints: { visionEnabled: false }, searchLimitReached: false,
  });
  assert.ok(visionOff);
  assert.equal(visionOff!.ledgerStatus, "unavailable");
  assert.match(visionOff!.safeSummary, /图片|开关|外发/);

  const quota = judgeCompanionUnavailableTool({
    toolName: "agent_web_search", constraints: { webSearchEnabled: true }, searchLimitReached: true,
  });
  assert.ok(quota);
  assert.equal(quota!.ledgerStatus, "not_executed", "额度用尽是执行问题，不是能力关闭");
  assert.equal(quota!.quotaReached, true);

  const available = judgeCompanionUnavailableTool({
    toolName: "companion_read_note", constraints: {}, searchLimitReached: false,
  });
  assert.equal(available, null, "能跑的工具不该被判成不可用");
});

test("兜底 provider 装不下时不出主槽：能装下才切，窗口未知则放行", async () => {
  const request = { role: "companion_agent", systemPrompt: "x".repeat(400), messages: [
    { role: "user", content: "y".repeat(400) },
  ], tools: [] } as unknown as AgentTurnRequest;
  // 与 config/ai-platforms.json 里 DeepSeek 槽的真实声明一致（64k 窗口、8k 输出）。
  const deepSeek = {
    getCapabilities: () => ({ contextWindowTokens: 65_536, maxOutputTokens: 8_192, outputLimitEnforced: true }),
    resolveOutputTokenLimit: () => 8_192,
  };
  assert.equal(await companionProviderFitsRequest(deepSeek, request), true, "小请求应当装得下 64k 窗口");
  // 同一个窗口塞进一个明显超长的历史时必须拒绝：整轮改判超预算比留在主槽更糟。
  const huge: AgentTurnRequest = { ...request, messages: [{ role: "user", content: "z".repeat(400_000) }] };
  assert.equal(await companionProviderFitsRequest(deepSeek, huge), false, "装不下时不能切过去");
  assert.equal(await companionProviderFitsRequest({
    getCapabilities: () => ({ contextWindowTokens: 0 }),
  }, request), true, "没声明窗口时保持旧行为，不拒绝");
  assert.equal(await companionProviderFitsRequest({}, request), true, "完全没能力声明时放行");
});

test("当前页读操作：两个读入口都算，其他动作不算", () => {
  assert.equal(namesCurrentNoteRead(["companion_read_note"]), true);
  assert.equal(namesCurrentNoteRead(["companion_read_current_page"]), true,
    "分类器对「这一页」选的是 read_current_page，不认它会用上一轮读过的笔记作答");
  assert.equal(namesCurrentNoteRead(["companion_search_notes"]), false);
  assert.equal(namesCurrentNoteRead([]), false);
});
