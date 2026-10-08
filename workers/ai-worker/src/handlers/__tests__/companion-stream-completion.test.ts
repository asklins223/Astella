import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeGoProvider } from "../../lib/providers/opencode-go.ts";
import { ProviderStreamError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "../companion-agent-streaming-step.ts";
import type { AgentTurnRequest } from "@astella/shared";

const request: AgentTurnRequest = { role: "companion_agent", systemPrompt: "答复眼前的话。",
  messages: [{ role: "user", content: "那句后来呢？" }], tools: [], maxTokens: 8000, temperature: 0.9, disableThinking: true };
const provider = (terminal?: Record<string, unknown>) => new OpenCodeGoProvider({
  apiKey: "test-key", baseUrl: "https://opencode.ai/zen/go/v1", model: "test",
  streamRequest: async () => ({ status: 200, statusText: "OK", cancel: () => undefined,
    body: (async function* () {
      const encoder = new TextEncoder();
      yield encoder.encode('data: {"type":"response.output_text.delta","delta":"这是已到达但还没有说完的正文"}\n\n');
      if (terminal) yield encoder.encode(`data: ${JSON.stringify(terminal)}`);
    })() }),
});

test("真实流式执行器不把断流前缀归一为 stop，也不重发已交付文字", async () => {
  const visible: string[] = [];
  await assert.rejects(() => runStreamingAgentStep({ provider: provider(), stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000,
    onProviderDelta: async text => { visible.push(text); return true; } }),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_incomplete"
      && !canRetryCompanionStream(error, { emitted: visible.length > 0, now: 0, deadline: 1000 }));
  assert.deepEqual(visible, ["这是已到达但还没有说完的正文"]);
});

test("整段待发布时额度截断仍失败，不能换传输再用同样额度取草稿", async () => {
  const visible: string[] = [];
  await assert.rejects(() => runStreamingAgentStep({ provider: provider({ type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }),
    stepRequest: request, ctxSignal: new AbortController().signal, timeoutMs: 1000, deferPublication: true,
    onProviderDelta: async text => { visible.push(text); return true; } }),
    (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated"
      && !canRetryCompanionStream(error, { emitted: false, now: 0, deadline: 1000 }));
  assert.deepEqual(visible, []);
});

test("完整完成事件即使无末尾换行也能经真实执行器正常返回", async () => {
  const result = await runStreamingAgentStep({ provider: provider({ type: "response.completed", response: { status: "completed" } }),
    stepRequest: request, ctxSignal: new AbortController().signal, timeoutMs: 1000, onProviderDelta: async () => true });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.content, "这是已到达但还没有说完的正文");
});
