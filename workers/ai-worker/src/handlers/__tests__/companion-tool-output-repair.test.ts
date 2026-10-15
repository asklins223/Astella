import assert from "node:assert/strict";
import test from "node:test";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { runStreamingAgentStep } from "../companion-agent-streaming-step.ts";
import { CompanionStreamStoppedError } from "../companion-dialogue-stream.ts";
import { CompanionToolOutputRepairError } from "../companion-tool-output-repair.ts";

const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT, systemPrompt: "policy",
  messages: [{ role: "user", content: "current question" }], tools: [], maxTokens: 1_000, temperature: 0.9 };

async function stream(parts: string[], terminalError?: Error, rejectDelivery = false) {
  const published: string[] = [];
  let consumed = 0;
  const provider = { chatCompletionStream: async (_messages: unknown, _options: unknown, _signal: unknown,
    onDelta: (delta: string) => void) => {
    for (const part of parts) { onDelta(part); consumed++; await Promise.resolve(); }
    if (terminalError) throw terminalError;
    return { content: parts.join(""), toolCalls: [], finishReason: "stop" };
  } } as unknown as AIProvider;
  let error: unknown;
  try { await runStreamingAgentStep({ provider, stepRequest: request, ctxSignal: new AbortController().signal,
    timeoutMs: 2_000, onProviderDelta: async delta => { published.push(delta); return !rejectDelivery; } }); }
  catch (caught) { error = caught; }
  return { published: published.join(""), error, consumed };
}

test("protocol drafts are quarantined at every chunk boundary without dropping the provider tail or executing text", async () => {
  const prefix = "我先核对当前问题。";
  const text = prefix + "<tool_call><function=agent_calculate><parameter=expression>1+1</parameter></function></tool_call>后续草稿";
  for (let split = 0; split <= text.length; split++) {
    const result = await stream([text.slice(0, split), text.slice(split)]);
    assert.ok(result.error instanceof CompanionToolOutputRepairError, `split ${split}`);
    assert.equal(result.consumed, 2, "quarantine is not an upstream truncation");
    assert.equal(result.error.publishedText, result.published);
    assert.ok(prefix.startsWith(result.published), `control syntax reached the public stream at split ${split}`);
    assert.equal(result.error.code, "tool_protocol_leak");
  }
});

test("an invalid native argument result preserves the exact published prefix for explicit in-run correction", async () => {
  const prefix = "先核对这一步。";
  const result = await stream([prefix], new AgentOutputError("arguments_malformed", "invalid JSON"));
  assert.ok(result.error instanceof CompanionToolOutputRepairError);
  assert.equal(result.error.code, "arguments_malformed");
  assert.equal(result.error.publishedText, prefix);
  assert.equal(result.published, prefix);
});

test("the actual malformed-argument failure cannot expose protocol text while being corrected", async () => {
  const result = await stream(["先核对。", "<tool_call><parameter=agent_calculate>bad</tool_call>"],
    new AgentOutputError("arguments_malformed", "invalid JSON"));
  assert.ok(result.error instanceof CompanionToolOutputRepairError);
  assert.equal(result.error.code, "tool_protocol_leak");
  assert.equal(result.published, "先核对。");
});

test("legitimate protocol examples in Markdown remain complete", async () => {
  for (const text of ["例如 `<tool_call>` 是代码。", "示例：\n```xml\n<tool_call><function=demo></function></tool_call>\n```\n解释完毕。", "只比较 x < y，不调用工具。"] ) {
    const result = await stream([...text]);
    assert.equal(result.error, undefined);
    assert.equal(result.published, text);
  }
});

test("delivery refusal remains a cancellation boundary and cannot be converted into a model retry", async () => {
  const result = await stream(["已经失效的交付。"], new AgentOutputError("arguments_malformed", "invalid JSON"), true);
  assert.ok(result.error instanceof CompanionStreamStoppedError);
});
