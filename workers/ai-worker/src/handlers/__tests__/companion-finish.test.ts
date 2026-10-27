import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest } from "@astella/shared";
import { validateCompanionFinish } from "../agent/companion-finish.ts";

function writeReceipt(id = "edit-1"): AgentTurnRequest["messages"] {
  return [
    { role: "user", content: "把标题改一下。" },
    { role: "assistant", content: "", toolCalls: [{ id, name: "companion_notes_write", arguments: { action: "edit" } }] },
    { role: "tool", toolCallId: id, content: JSON.stringify({ ok: true, receiptId: id, summary: "已保存" }) },
  ];
}

test("finish accepts only a successful write receipt from this request", () => {
  const result = validateCompanionFinish({ text: "改好了，其他内容没动。", actions: [{ receiptId: "edit-1" }], evidence: [] },
    writeReceipt());
  assert.deepEqual(result, { ok: true, text: "改好了，其他内容没动。", writesLanded: true });
});

test("finish rejects a historical or fabricated write receipt", () => {
  const messages: AgentTurnRequest["messages"] = [
    ...writeReceipt("old-edit"),
    { role: "user", content: "再改一次。" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const historical = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "old-edit" }], evidence: [] }, messages);
  assert.equal(historical.ok, false);
  assert.match(historical.ok ? "" : historical.error, /本轮真实成功/);

  const readAsAction = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "read-1" }], evidence: [] }, messages);
  assert.equal(readAsAction.ok, false);

  const fabricated = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "made-up" }], evidence: [] }, messages);
  assert.equal(fabricated.ok, false);
});

test("finish rejects an unsupported completion claim when actions are empty", () => {
  const result = validateCompanionFinish({ text: "已经保存好了。", actions: [], evidence: [] }, writeReceipt());
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /actions 为空/);
});

test("finish allows a plain read answer with evidence and no actions", () => {
  const messages: AgentTurnRequest["messages"] = [
    { role: "user", content: "这篇笔记说了什么？" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const result = validateCompanionFinish({ text: "它讲了三件事。", actions: [], evidence: [{ receiptId: "read-1" }] }, messages);
  assert.equal(result.ok, true);
});

test("a deliverable read can be cited as the turn's result, an ordinary read cannot", () => {
  const messages: AgentTurnRequest["messages"] = [
    { role: "user", content: "把我的复习过程画成流程图。" },
    { role: "assistant", content: "", toolCalls: [{ id: "draw-1", name: "companion_visual", arguments: { action: "diagram" } }] },
    { role: "tool", toolCallId: "draw-1",
      content: JSON.stringify({ ok: true, receiptId: "draw-1", summary: "已画出 3 步流程图" }) },
  ];
  // 2026-10-27 live: this exact shape was rejected, costing the turn an extra step.
  const delivered = validateCompanionFinish({ text: "画好了，三步。", actions: [{ receiptId: "draw-1" }], evidence: [] }, messages);
  assert.equal(delivered.ok, true, "a deliverable read is a valid action citation");

  const lookup: AgentTurnRequest["messages"] = [
    { role: "user", content: "这篇笔记说了什么？" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "companion_notes_read", arguments: { action: "read" } }] },
    { role: "tool", toolCallId: "read-1", content: JSON.stringify({ ok: true, receiptId: "read-1" }) },
  ];
  const asAction = validateCompanionFinish({ text: "改好了。", actions: [{ receiptId: "read-1" }], evidence: [] }, lookup);
  assert.equal(asAction.ok, false, "an ordinary read cannot stand in for a completed change");
});
