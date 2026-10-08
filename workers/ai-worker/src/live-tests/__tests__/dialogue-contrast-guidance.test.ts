import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDialogueExperimentRequest } from "../dialogue-experiment.ts";
import { contrastDialogueGuidance } from "../dialogue-contrast-guidance.ts";

test("对照指导仅替换闲聊执行块，保留人格、完整纠正和出网参数", () => {
  const input = buildDialogueExperimentRequest({ id: "long-correction", intent: "conversation",
    history: [{ role: "user", text: "未发送".repeat(10000), seq: "1", createdAt: "2026-10-07T08:00:00Z" },
      { role: "assistant", text: "已经发送了。", seq: "2", createdAt: "2026-10-07T08:01:00Z" }],
    userText: "只是写完了，还没发。" }, "full", 384000).request;
  const original = structuredClone(input);
  const candidate = contrastDialogueGuidance(input);
  assert.deepEqual({ ...candidate, systemPrompt: "" }, { ...original, systemPrompt: "" });
  assert.ok(candidate.systemPrompt.includes("<persona_data>"));
  assert.ok(candidate.systemPrompt.includes("<conversation_timeline>"));
  assert.deepEqual(input, original);
  candidate.messages[0]!.content = "mutated";
  assert.deepEqual(input, original);
});

test("对照指导拒绝误用在知识请求或执行块重复的输入上", () => {
  const question = buildDialogueExperimentRequest({ id: "help", intent: "question", history: [],
    userText: "这个接口怎么辨认？" }, "full", 384000).request;
  assert.throws(() => contrastDialogueGuidance(question));
  const casual = buildDialogueExperimentRequest({ id: "chat", intent: "conversation", history: [],
    userText: "改完了。" }, "full", 384000).request;
  assert.throws(() => contrastDialogueGuidance({ ...casual, systemPrompt: casual.systemPrompt + casual.systemPrompt }));
  assert.throws(() => contrastDialogueGuidance({ ...casual, messages: [{ role: "assistant", content: "先前的话" }] }));
});
