import assert from "node:assert/strict";
import { test } from "node:test";
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

test("终答去重：新的终答正文照常追加", () => {
  const text = assembleCompanionFinishText({
    visibleSegments: ["嗨。"], visibleSegmentDelivered: [true],
    utterancePublished: true, finishText: "今天想先做哪件事？",
  });
  assert.match(text, /嗨。/);
  assert.match(text, /今天想先做哪件事？/);
});

test("写已经落地、下一代模型失败时不把整轮变成错误卡", () => {
  const definitions = [{ name: "companion_notes_write", riskClass: "reversible_low" },
    { name: "companion_say", riskClass: "reversible_low" }];
  const receipt = (operation: string, summary: string, ok = true) => ({ role: "tool", content: JSON.stringify({
    ok, receiptId: "call-1", operation, data: { status: ok ? "succeeded" : "not_executed", summary } }) });
  const settled = settleCompanionLandedWritesOnFailure({ messages: [receipt("notes.write.edit", "已替换指定段落")],
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions });
  assert.ok(settled);
  assert.ok(settled!.text.includes("已替换指定段落"), "保存回执必须出现在交付正文里");
  assert.deepEqual(settled!.receiptIds, ["call-1"]);

  // 失败的回执、语音类回执和已下发过正文的步骤都不算。
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: [receipt("notes.write.edit", "x", false)],
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions }), null);
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: [receipt("say.publish", "你好")],
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: false, definitions }), null);
  assert.equal(settleCompanionLandedWritesOnFailure({ messages: [receipt("notes.write.edit", "x")],
    visibleSegments: [], visibleSegmentDelivered: [], richBlocks: [], stepEmitted: true, definitions }), null);
});
