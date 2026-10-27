import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { judgeCompanionStepClosing, waitingConfirmationReceipts } from "../turn/companion-step-closing.ts";
import { judgeCompanionUnavailableTool } from "../tools/companion-unavailable-tool.ts";
import { companionProviderFitsRequest } from "../agent/companion-provider-fit.ts";
import { companionNamedNoteReadTitle, companionMentionedNoteTargetRequest, companionSemanticNoteReadTarget, namesCurrentNoteRead } from "../note/companion-note-prefetch.ts";
import { companionRequestsAction } from '../turn/companion-step-plan.ts';
import { companionExecutionBlocks } from "../agent/companion-tool-output.ts";

test("工具结果恢复后仍按相同顺序交付跳转和正文，非法跳转不影响已保存内容", () => {
  const source = { runId: "1e6bed47-2d3c-4d43-9601-398aa529fb8e", fallbackLabel: "打开手记" };
  const text = { type: "text" as const, text: "已保存" };
  const route = { kind: "note", noteId: "489ebdab-41b8-492b-a292-76c4ed4b9102" };
  const receipt = { route, blocks: [text] };
  const expected = [{ type: "nav", label: "打开手记", route }, text];
  assert.deepEqual(companionExecutionBlocks(receipt, source), expected);
  assert.deepEqual(companionExecutionBlocks(JSON.parse(JSON.stringify(receipt)), source), expected);
  assert.deepEqual(companionExecutionBlocks({ ...receipt, route: { kind: "external", url: "https://example.com" } }, source), [text]);
});

test("明确修改的目标尚待定位时仍须执行核验，不能按无操作聊天交付", () => {
  const definitions = [{ name: 'companion_search_notes', riskClass: 'read' }, { name: 'companion_edit_note', riskClass: 'write' }];
  const attention = { intent: 'task', toolUse: 'uncertain', candidateOperations: ['companion_search_notes', 'companion_edit_note'] };
  assert.equal(companionRequestsAction(attention, definitions), true);
  assert.equal(companionRequestsAction({ ...attention, intent: 'conversation', toolUse: 'none' }, definitions), false);
  assert.equal(companionRequestsAction({ ...attention, candidateOperations: ['companion_search_notes'] }, definitions), false);
  assert.equal(companionRequestsAction(attention, definitions.slice(0, 1)), false);
});

test("named-note prefetch only chooses a single explicitly named reading subject", () => {
  assert.equal(companionNamedNoteReadTitle("请根据《秦朝》这篇已保存笔记解释制度。"), "秦朝");
  assert.equal(companionNamedNoteReadTitle("请比较《秦朝》和《唐朝》两篇笔记。"), null);
  assert.equal(companionNamedNoteReadTitle("讲个《秦朝》的故事。"), null);
  assert.equal(companionNamedNoteReadTitle("新建一篇《秦朝》笔记。"), null);
  assert.equal(companionMentionedNoteTargetRequest("周一安排里，中午改成去散步，其他不用动。"), true);
  assert.equal(companionMentionedNoteTargetRequest("帮我把拉伸改成十分钟。"), true,
    "这是一句编辑请求；没有标题命中时数据库查询会返回空，仍交给模型搜索");
  assert.equal(companionMentionedNoteTargetRequest("新建一篇周一安排。"), false);
  assert.equal(companionMentionedNoteTargetRequest("今天有点累。"), false);
});

test("semantic note subjects resolve a follow-up without requiring reading keywords in the user prompt", () => {
  assert.deepEqual(companionSemanticNoteReadTarget([{ description: "《周三散步》这篇手记", reference: null }]),
    { title: "周三散步" });
  const id = "32f4172b-aa2d-42d7-b366-865be3fe758e", versionId = "7dc7734b-844f-4c03-8caa-0e019d9a488c";
  assert.deepEqual(companionSemanticNoteReadTarget([{ description: "刚才这篇", reference: { kind: "note_version", id, versionId } }]),
    { noteId: id, noteVersionId: versionId });
  assert.equal(companionSemanticNoteReadTarget([{ description: "刚才那篇", reference: null }]), null);
  assert.equal(companionSemanticNoteReadTarget([{ description: `noteId=${id}`, reference: null }]), null,
    "model prose cannot supply an object identity");
  assert.equal(companionSemanticNoteReadTarget([{ description: "《周一》和《周三》", reference: null }]), null);
  assert.equal(companionSemanticNoteReadTarget([{ description: "《周一》", reference: null },
    { description: "《周三》", reference: null }]), null, "several targets stay with the normal multi-note tool flow");
});

/**
 * Behaviour of the decision helpers extracted out of the agent loop on
 * 2026-10-17. Each one answers a question the loop used to ask inline, so the
 * tests assert the answers rather than the shape of the loop.
 */

test("收尾判定：明确发布或静默决定都直接结算，失败调用不结算", () => {
  const message = (id: string, ok: boolean) => ({ role: "tool", toolCallId: id, content: JSON.stringify({ ok }) });
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

  const published = judgeCompanionStepClosing({
    calls: [call("a", "companion_say", { action: "publish" })],
    messages: [message("a", true)], initiative: false, writingAnnotation: false,
  });
  assert.equal(published.settleAs, "silent", "发布即结果，不必再问模型一轮");

  // 2026-10-26 实测：用户要“明天九点提醒我”，她只发了一句闲聊就收尾，
  // 收尾判定把 `say.publish` 当成结果，提醒回执的闸再也没被走到。
  const publishedWithPendingAction = judgeCompanionStepClosing({
    calls: [call("a", "companion_say", { action: "publish" })],
    messages: [message("a", true)], initiative: false, writingAnnotation: false,
    actionReceiptMissing: true,
  });
  assert.equal(publishedWithPendingAction.settleAs, "none", "动作还欠回执时，发言不能算收尾");

  const publishedWithAnnotation = judgeCompanionStepClosing({
    calls: [call("a", "companion_notes_write", { action: "annotate" }), call("b", "companion_say", { action: "publish" })],
    messages: [message("a", true), message("b", true)], initiative: false, writingAnnotation: true,
  });
  assert.equal(publishedWithAnnotation.settleAs, "annotation", "批注已落地时语音失败不能重开生成");

  const failedSpeech = judgeCompanionStepClosing({
    calls: [call("a", "companion_say", { action: "publish" })],
    messages: [message("a", false)], initiative: false, writingAnnotation: false,
  });
  assert.equal(failedSpeech.settleAs, "none", "回执失败不能当成已结算");
  assert.equal(failedSpeech.allSucceeded, false);

  const silentInitiative = judgeCompanionStepClosing({
    calls: [call("a", "companion_say", { action: "finish_participation" })],
    messages: [message("a", true)], initiative: true, writingAnnotation: false,
  });
  assert.equal(silentInitiative.settleAs, "silent");

  const toolThenAnswer = judgeCompanionStepClosing({
    calls: [call("a", "companion_notes_read", { action: "read" })],
    messages: [message("a", true)], initiative: false, writingAnnotation: false,
  });
  assert.equal(toolThenAnswer.settleAs, "none", "普通工具步必须继续，不能就此交卷");
});

test("等待确认：第一个调用标等待，后面的调用如实标未执行", () => {
  const receipts = waitingConfirmationReceipts("77c1b0d4-3f0e-4c55-9a1a-0d1e3c5b0a11", [
    { id: "first", name: "companion_notes_write", arguments: { action: "edit" } },
    { id: "second", name: "companion_notes_write", arguments: { action: "share" } },
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
    toolName: "visual.read_image", constraints: { visionEnabled: false }, searchLimitReached: false,
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
    toolName: "notes.read.read", constraints: {}, searchLimitReached: false,
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
  assert.equal(namesCurrentNoteRead(["notes.read.read"]), true);
  assert.equal(namesCurrentNoteRead(["observe.current_page"]), true,
    "分类器对「这一页」选的是 current_page，不认它会用上一轮读过的笔记作答");
  assert.equal(namesCurrentNoteRead(["companion_notes_read"]), true, "域工具名（不带 action）也必须算");
  assert.equal(namesCurrentNoteRead(["notes.read.search"]), false);
  assert.equal(namesCurrentNoteRead([]), false);
});
