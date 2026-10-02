import assert from "node:assert/strict";
import test from "node:test";
import { noteLearningSnapshotHash } from "../note-learning-snapshot.ts";

const snapshot = {
  taskVersion: 1, noteVersionId: "note-version", heading: "小节", selectedText: "框选的原句",
  modelId: "model-a", promptVersion: "prompt-v1",
  generationParameters: { temperature: 0.25, maxTokens: 700, responseFormat: "json_object" as const, disableThinking: true },
  messages: [{ role: "user" as const, content: "解释这段原句" }],
};

for (const [task, temperature] of [["速看", 0.2], ["原句解释", 0.25], ["往外学", 0.35]] as const) {
test(`${task}的实际小数采样参数能生成稳定快照，不会在调用模型前失败`, () => {
  const input = { ...snapshot, generationParameters: { ...snapshot.generationParameters, temperature } };
  const hash = noteLearningSnapshotHash(input);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(noteLearningSnapshotHash({ ...input, generationParameters: {
    disableThinking: true, responseFormat: "json_object", maxTokens: 700, temperature,
  } }), hash);
  for (const changed of [
    { ...input, selectedText: "另一句" }, { ...input, modelId: "model-b" },
    { ...input, generationParameters: { ...input.generationParameters, temperature: 0.5 } },
  ]) assert.notEqual(noteLearningSnapshotHash(changed), hash);
});
}
