import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDialogueLayerRequests } from "../dialogue-layer-diagnostic.ts";
import { buildCasualFirstStepRequest } from "../../handlers/companion-speculative-first-step.ts";

const runtime = { permissionLevel: "guided", stepBudget: 4 };

test("分层诊断保留完整原生纠正，三个条件只改变系统输入", () => {
  const messages = [
    { role: "user" as const, content: "原话".repeat(10000) + "末尾更正：只是写完，还未发送。" },
    { role: "assistant" as const, content: "已经发出去了。" },
    { role: "user" as const, content: "没发，我只是写完了。" },
  ];
  const input = buildCasualFirstStepRequest({ ...runtime, messages,
    turnPolicy: "<persona_data>当前人格</persona_data>", maxTokens: 384000 });
  const requests = buildDialogueLayerRequests(input, runtime);
  for (const request of Object.values(requests)) {
    assert.deepEqual(request.messages, messages);
    assert.deepEqual({ ...request, systemPrompt: "" }, { ...requests.full, systemPrompt: "" });
  }
  assert.doesNotMatch(requests.bare.systemPrompt, /声音表达协议|业务回执|persona_data/);
  assert.match(requests.protocol.systemPrompt, /声音表达协议/);
  assert.doesNotMatch(requests.protocol.systemPrompt, /persona_data/);
  assert.match(requests.full.systemPrompt, /persona_data/);
  requests.bare.messages[0]!.content = "changed";
  assert.equal(input.messages[0]!.content, messages[0]!.content);
  assert.notEqual(requests.full.messages[0]!.content, "changed");
});

test("分层诊断拒绝遗漏当前用户输入或完整策略的夹具", () => {
  const full = buildCasualFirstStepRequest({ ...runtime, turnPolicy: "policy",
    messages: [{ role: "user", content: "当前问题" }], maxTokens: 1000 });
  assert.throws(() => buildDialogueLayerRequests({ ...full, systemPrompt: "" }, runtime));
  assert.throws(() => buildDialogueLayerRequests({ ...full,
    messages: [{ role: "assistant", content: "旧回复" }] }, runtime));
});
