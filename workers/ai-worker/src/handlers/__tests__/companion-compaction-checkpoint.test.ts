import assert from "node:assert/strict";
import test from "node:test";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { createCompactionCheckpoint, restoreCompactionCheckpoint } from "../companion-compaction-checkpoint.ts";
import type { CompactionTraceV1 } from "../companion-context-handoff.ts";
import { boundedStepSender } from "../companion-compaction.ts";
import { AIContextCompactionRequiredError } from "../../lib/context-governor.ts";
import { canonicalJsonV1 } from "@astella/shared/content-hash";

const scope = { runId: "run-a", conversationId: "conversation-a" };
const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "Original policy.",
  messages: [{ role: "user", content: "Original source." }, { role: "assistant", content: "Original answer." }, { role: "user", content: "Current request." }],
  tools: [], maxTokens: 1000, temperature: 0.2 };
const folded = [{ role: "assistant" as const, content: "A source-bound semantic checkpoint." }, request.messages.at(-1)!];
const trace = (): CompactionTraceV1 => ({ sourceKind: "history_exchanges", foldedFromSeq: "1", foldedThroughSeq: "2", foldedMessageCount: 2,
  summarySourceSha256: "a".repeat(64), remainingFromSeq: "3", uncoveredBeforeSeq: null, modelId: "model", inputTokens: 100,
  triggerTokens: 80, hardInputTokens: 120, reason: "pressure", at: "2026-10-15T10:00:00Z", checkpoint: createCompactionCheckpoint(scope, request, folded) });

test("a complete private checkpoint restores only this run's identical full request", () => {
  const original = trace();
  const restored = restoreCompactionCheckpoint({ ...scope, request, traces: [original] });
  assert.deepEqual(restored!.messages, folded);
  assert.equal((restored!.receipt as unknown as Record<string, unknown>).checkpoint, undefined, "ordinary receipts/logs exclude private context");
  for (const changed of [{ ...request, systemPrompt: "Changed policy." }, { ...request, maxTokens: 2000 },
    { ...request, messages: [...request.messages, { role: "user" as const, content: "New evidence." }] },
    { ...request, tools: [{ name: "new_tool", description: "new capability", parameters: {} }] }])
    assert.equal(restoreCompactionCheckpoint({ ...scope, request: changed, traces: [original] }), null);
  assert.equal(restoreCompactionCheckpoint({ ...scope, runId: "another-run", request, traces: [original] }), null);
  assert.equal(restoreCompactionCheckpoint({ ...scope, conversationId: "another-conversation", request, traces: [original] }), null);
  restored!.messages[0]!.content = "Changed returned copy.";
  assert.deepEqual(JSON.parse(original.checkpoint!.messagesJson), folded);
});

test("tampered message content or role cannot become a reusable checkpoint", () => {
  for (const mutate of [
    (value: CompactionTraceV1) => { value.checkpoint!.messagesJson = value.checkpoint!.messagesJson.replace("A source-bound semantic checkpoint.", "An invented completion."); },
    (value: CompactionTraceV1) => { value.checkpoint!.messagesJson = value.checkpoint!.messagesJson.replace('"assistant"', '"invented-authority"'); },
  ]) {
    const value = trace(); mutate(value);
    assert.equal(restoreCompactionCheckpoint({ ...scope, request, traces: [value] }), null);
  }
  const checkpoint = createCompactionCheckpoint({ ...scope, secretExtraField: "must not be copied" } as typeof scope, request, folded);
  assert.equal((checkpoint as unknown as Record<string, unknown>).secretExtraField, undefined);
});

test("fractional provider and tool parameters survive the private integer-canonical handoff", () => {
  const withTool: AgentTurnRequest = { ...request, messages: [...request.messages,
    { role: "assistant", content: "", toolCalls: [{ id: "fractional", name: "tool", arguments: { confidence: 0.75 } }] }] };
  const value = trace();
  value.checkpoint = createCompactionCheckpoint(scope, withTool, withTool.messages);
  assert.doesNotThrow(() => canonicalJsonV1(value));
  const restored = restoreCompactionCheckpoint({ ...scope, request: withTool, traces: [value] });
  assert.deepEqual(restored!.messages.at(-1)!.toolCalls![0]!.arguments, { confidence: 0.75 });
});

test("a compressed request is sent only after its asynchronous checkpoint persistence completes", async () => {
  const order: string[] = [];
  let attempt = true;
  const receipt = trace();
  const error = new AIContextCompactionRequiredError({ decision: { detail: "source pressure" } } as never);
  const send = boundedStepSender({ hasAttempt: () => attempt, consumeAttempt: () => { attempt = false; },
    fold: () => ({ messages: folded, receipt }), onCompacted: async () => { await Promise.resolve(); order.push("checkpoint committed"); } });
  await send(request, async input => {
    if (input.messages.length === request.messages.length) throw error;
    order.push("provider called");
    return { content: "Reply.", toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: null };
  });
  assert.deepEqual(order, ["checkpoint committed", "provider called"]);
});

test("a verified prior checkpoint resumes before the no-progress cooldown without another summary or synthetic trace", async () => {
  const saved = trace();
  const order: string[] = [];
  let current = request;
  const send = boundedStepSender({
    beginRequest: value => { current = value as AgentTurnRequest; },
    restore: () => restoreCompactionCheckpoint({ ...scope, request: current, traces: [saved] }),
    fold: () => { throw new Error("must not summarize the already compressed source again"); },
    hasAttempt: () => true, consumeAttempt: () => { order.push("consume"); },
    onCompacted: () => { order.push("new compaction"); },
    cooldown: { decide: async () => { order.push("cooldown"); return { allowed: false, reason: "no_progress", retryAfterMs: null }; },
      record: async () => { order.push("record"); } },
  });
  const result = await send(request, async actual => {
    order.push("provider");
    assert.deepEqual(actual.messages, folded);
    assert.equal(actual.systemPrompt, request.systemPrompt);
    return { content: "Resumed reply.", toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: null };
  });
  assert.equal(result.content, "Resumed reply.");
  assert.deepEqual(order, ["provider"]);
});
