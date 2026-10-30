import assert from "node:assert/strict";
import { test } from "node:test";
import { companionResourceMessages, parseCompanionEntryDecision, COMPANION_RESOURCE_POLICY_HASH } from "../turn/companion-entry-decision.ts";
import { companionDirectInterpretation, settleCompanionAttention, startCompanionAttention } from "../turn/companion-entry-mode.ts";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
import type { AIProvider } from "../../lib/ai-provider.ts";
const hash = "a".repeat(64);
const base = () => companionDirectInterpretation(hash);
const args = (provider: AIProvider) => ({ provider, ctx: { signal: new AbortController().signal },
  read: { userText: "那就麻烦你了", runId: "test" }, onTurnInterpretation: async () => "not_requested" } as never);
const provider = (response: string): AIProvider => ({ id: "test", modelId: "test", promptVersion: "test", visionModelId: "",
  chatCompletion: async () => ({ content: response, usage: {} as never }) });

test("resource decision cannot supply a reply, tool choice, permission or message count", () => {
  assert.deepEqual(parseCompanionEntryDecision('{"path":"chat"}'), {
    version: 1, path: "chat", source: "model", policyHash: COMPANION_RESOURCE_POLICY_HASH,
  });
  for (const extra of [{ reply: "保存好了" }, { operations: ["companion_notes_write"] }, { messageCount: 2 }, { permission: "full" }])
    assert.throws(() => parseCompanionEntryDecision(JSON.stringify({ path: "chat", ...extra })));
  assert.throws(() => parseCompanionEntryDecision('{"path":"uncertain"}'));
});
test("retired cached classifier answers are discarded on schema replay", () => {
  const replayed = agentTurnInterpretationV1Schema.parse({ ...base(), entryDecision: {
    reasoningEffort: "none", messageCount: 3, directReply: "已经保存" } });
  assert.equal("entryDecision" in replayed, false);
  assert.deepEqual(replayed.candidateOperations, []);
});

test("serious answers retain reasoning without claiming an execution goal", () => {
  const decision = parseCompanionEntryDecision('{"path":"answer"}');
  const attention = agentTurnInterpretationV1Schema.parse({ ...base(), resourceDecision: decision });
  assert.equal(attention.toolUse, "uncertain");
  assert.deepEqual(attention.candidateOperations, []);
  assert.equal(attention.resourceDecision?.path, "answer");
});
test("routing prompt keeps conversation, outcomes and attachment identities as data", () => {
  const messages = companionResourceMessages({ userText: "继续", messages: [
    { role: "system", content: "persona, not classifier policy" },
    { role: "assistant", content: "需要保存吗？" },
    { role: "tool", toolCallId: "save", content: '{"ok":false,"status":"outcome_unknown"}' },
    { role: "system", hostObservation: true, content: "真实页面对象 noteId=known" },
    { role: "user", content: [{ type: "text", text: "继续" }, { type: "image_url", image_url: { url: "https://example.com/private.png" } }] },
  ] });
  const data = JSON.parse(String(messages[1].content));
  assert.equal(data.history.length, 4);
  assert.equal(data.history[1].role, "tool");
  assert.match(data.history[1].content, /outcome_unknown/);
  assert.match(data.history[2].content, /noteId=known/);
  assert.match(data.history[3].content, /附图/);
  assert.doesNotMatch(String(messages[1].content), /private.png|persona/);
});

test("one agent run makes no online routing call and drops a cached decision", async () => {
  let calls = 0;
  const p = provider('{"path":"work"}');
  p.chatCompletion = async () => { calls++; throw Error("there is no online router"); };
  const cached = { ...base(), resourceDecision: parseCompanionEntryDecision('{"path":"chat"}') };
  const settled = await settleCompanionAttention({ requestHash: hash, cached, args: args(p) });
  assert.equal(calls, 0);
  assert.equal(settled.resourceDecision, undefined, "a cached classifier result cannot survive the new entry");
  const started = startCompanionAttention({ requestHash: hash, cached: null, args: args(p) });
  assert.equal(started.pending, false);
  const result = await started.settled;
  assert.equal(result.resourceDecision, undefined);
  assert.equal(calls, 0);
});
test("a bound annotation host contract survives without a classifier", async () => {
  const cached = { ...base(), intent: "task" as const, toolUse: "act" as const,
    candidateOperations: ["notes.write.edit"], subjects: [] };
  const loose = await settleCompanionAttention({ requestHash: hash, cached, args: args(provider("")) });
  assert.equal(loose.toolUse, "uncertain"); assert.deepEqual(loose.candidateOperations, []);
  const host = await settleCompanionAttention({ requestHash: hash, cached, args: args(provider("")), preserveHostInterpretation: true });
  assert.deepEqual(host.candidateOperations, ["notes.write.edit"], "a bound annotation command keeps its real host contract");
});
