import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeGoProvider } from "../../lib/providers/opencode-go.ts";
import { ProviderStreamError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "../agent/companion-agent-streaming-step.ts";
import type { AgentTurnRequest } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";

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

function envelopeProvider(raw: string, chunks = [raw]): AIProvider {
  return { id: "mock", modelId: "mock", visionModelId: "mock", promptVersion: "test",
    chatCompletion: async () => ({ content: raw, usage: {} }),
    chatCompletionStream: async (_messages, _options, _signal, delta) => {
    for (const chunk of chunks) delta(chunk);
    return { content: raw, finishReason: "stop", toolCalls: [] };
  } };
}

test("malformed envelope quotes cannot silently turn a complete story into a successful prefix", async () => {
  const raw = '{"reply":"有个哥子减肥，晚上躺在床上发誓："明天开始，不吃饭了！"第二天他还是吃了早饭。"}';
  await assert.rejects(() => runStreamingAgentStep({ provider: envelopeProvider(raw), stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000, onProviderDelta: async () => true }),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
});

test("a provider stop cannot certify an unfinished JSON envelope", async () => {
  for (const raw of ['{"reply":"这个故事还有后半段', '{"reply":"这个故事还有后半段"']) {
    await assert.rejects(() => runStreamingAgentStep({ provider: envelopeProvider(raw), stepRequest: request,
      ctxSignal: new AbortController().signal, timeoutMs: 1000, onProviderDelta: async () => true }),
      (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
  }
});

test("valid escaped story dialogue remains complete at every stream split", async () => {
  const text = '乌龟说："坐稳了。"\n小狐狸抱紧果篮，两个朋友一起平安过了河。';
  const raw = JSON.stringify({ reply: text, emotion: "happy" });
  for (let split = 1; split < raw.length; split++) {
    const visible: string[] = [];
    const result = await runStreamingAgentStep({ provider: envelopeProvider(raw, [raw.slice(0, split), raw.slice(split)]),
      stepRequest: request, ctxSignal: new AbortController().signal, timeoutMs: 1000,
      onProviderDelta: async delta => { visible.push(delta); return true; } });
    assert.equal(result.content, text, `split ${split}`);
    assert.equal(visible.join(""), text, `split ${split}`);
  }
});
