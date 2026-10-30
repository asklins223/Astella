import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { assembleCompanionFinishText, assembleCompanionHostSettlement,
  settleCompanionLandedWritesOnFailure } from "../agent/companion-host-settlement.ts";

test("宿主如实收尾：已有正文 + 收尾说明都保留", () => {
  const result = assembleCompanionHostSettlement({
    visibleSegments: ["我查了一下。"], visibleSegmentDelivered: [true], richBlockCount: 0,
    said: "", includeSaid: false, note: "（宿主核对：这项动作没有执行。）",
    landedWrites: false,
  });
  assert.equal(result.empty, false);
  assert.match(result.text, /我查了一下/);
  assert.match(result.text, /没有执行/);
});

test("宿主如实收尾：只有收尾说明也算交付，不判空回复", () => {
  const result = assembleCompanionHostSettlement({
    visibleSegments: [], visibleSegmentDelivered: [], richBlockCount: 0,
    said: "", includeSaid: false, note: "（宿主核对：这项动作没有执行。）",
    landedWrites: false,
  });
  assert.equal(result.empty, false);
  assert.match(result.text, /没有执行/);
});

test("宿主如实收尾：无正文、无块、无写入、无说明才算空", () => {
  const result = assembleCompanionHostSettlement({
    visibleSegments: [], visibleSegmentDelivered: [], richBlockCount: 0,
    said: "   ", includeSaid: true, note: "", landedWrites: false,
  });
  assert.equal(result.empty, true);
});

test("终答去重：已发布过的同一句不再拼第二遍", () => {
  const text = assembleCompanionFinishText({
    visibleSegments: ["嗨，今天想从哪件事开始？"], visibleSegmentDelivered: [true],
    utterancePublished: true, finishText: "嗨，今天想从哪件事开始？",
  });
  assert.equal(text, "嗨，今天想从哪件事开始？");
});

test("独立消息已选择发布通道，终答不能追加额外确认气泡", () => {
  const text = assembleCompanionFinishText({
    visibleSegments: ["嗨。"], visibleSegmentDelivered: [true],
    utterancePublished: true, finishText: "今天想先做哪件事？",
  });
  assert.match(text, /嗨。/);
  assert.equal(text, "嗨。");
});

test("写已经落地、下一代模型失败时不把整轮变成错误卡", () => {
  const definitions = [{ name: "companion_notes_write", riskClass: "reversible_low" },
    { name: "companion_send_message", riskClass: "reversible_low" }];
  const receipt = (operation: string, summary: string, ok = true): AgentTurnRequest["messages"] => [
    { role: "user", content: "修改指定段落", requestBoundary: true },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: operation, arguments: {} }] },
    { role: "tool", toolCallId: "call-1", content: JSON.stringify({ ok, receiptId: "call-1", operation,
      data: { status: ok ? "succeeded" : "not_executed", summary } }) }];
  const settled = settleCompanionLandedWritesOnFailure({ messages: receipt("notes.write.edit", "已替换指定段落"),
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions });
  assert.ok(settled);
  assert.ok(settled!.text.includes("已替换指定段落"), "保存回执必须出现在交付正文里");
  assert.deepEqual(settled!.receiptIds, ["call-1"]);

  // 失败的回执、语音类回执和已下发过正文的步骤都不算。
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: receipt("notes.write.edit", "x", false),
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions }), null);
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: receipt("say.publish", "你好"),
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions }), null);
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: receipt("notes.write.edit", "x"),
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: true, definitions }), null);
});

const memoryCall = { id: "memory-save", name: "companion_memory_write", arguments: { action: "save" } };
const memoryDefinitions = [{ name: "companion_memory_write", riskClass: "reversible_low" }];
const memoryMessages: AgentTurnRequest["messages"] = [
  { role: "user", content: "把刚才的偏好记住", requestBoundary: true },
  { role: "assistant", content: "", toolCalls: [memoryCall] },
  { role: "tool", toolCallId: memoryCall.id, content: JSON.stringify({ ok: true, receiptId: "r1",
    operation: "memory.write.save", data: { saved: true }, summary: "已保存这条偏好" }) },
];
const settleMemory = (messages: AgentTurnRequest["messages"]) => settleCompanionLandedWritesOnFailure({
  messages, visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false,
  definitions: memoryDefinitions,
});

test("真实记忆回执的摘要在顶层，后续模型失败仍必须交付可见结果", () => {
  const settled = settleMemory(memoryMessages);
  assert.ok(settled);
  assert.match(settled.text, /已保存这条偏好/);
  assert.deepEqual(settled.receiptIds, [memoryCall.id]);
});

test("写入无摘要时给出有界结果说明，不能成功但正文为空或声称全部完成", () => {
  const messages = structuredClone(memoryMessages);
  messages[2]!.content = JSON.stringify({ ok: true, receiptId: "r1", data: { saved: true } });
  const settled = settleMemory(messages);
  assert.ok(settled?.text.trim());
  assert.match(settled!.text, /尚未核对/);
});

test("故障收尾不能复用旧轮写入、孤立回执或已被未知结果覆盖的成功", () => {
  assert.equal(settleMemory([...memoryMessages, { role: "user", content: "现在聊点别的", requestBoundary: true }]), null);
  assert.equal(settleMemory([memoryMessages[0]!, memoryMessages[2]!]), null);
  assert.equal(settleMemory([...memoryMessages, { role: "tool", toolCallId: memoryCall.id,
    content: JSON.stringify({ ok: true, status: "outcome_unknown", summary: "未经确认的结果" }) }]), null);
});
