import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenCodeGoProvider } from "../../lib/providers/opencode-go.ts";
import { ProviderStreamError } from "../../lib/provider-request-error.ts";
import { AgentOutputError } from "../../lib/non-retryable-errors.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "../agent/companion-agent-streaming-step.ts";
import type { AgentTurnRequest } from "@astella/shared";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { CompanionOutputTimeoutError } from "../agent/companion-output-watchdog.ts";

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

test("a retained finish body streams reasoning and tool preparation before the model step completes", async () => {
  const fixture = envelopeProvider("");
  const visible: string[] = [], thinking: string[] = [], tools: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reasoningArrived = new Promise<void>(resolve => { started = resolve; });
  fixture.chatCompletionStream = async (_messages, options, _signal, delta) => {
    options.onReasoningDelta?.("正在核对真实回执");
    options.onToolCallStarted?.({ index: 0, id: "finish", name: "companion_finish" });
    delta("尚未核验的完成文案");
    started();
    await pending;
    return { content: "尚未核验的完成文案", toolCalls: [{ id: "finish", name: "companion_finish", arguments: {} }], finishReason: "tool_calls" };
  };
  const running = runStreamingAgentStep({ provider: fixture, stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000, deferPublication: true,
    onProviderDelta: async text => { visible.push(text); return true; },
    onReasoningDelta: text => thinking.push(text), onToolCallStarted: tool => tools.push(tool.id) });
  await reasoningArrived;
  assert.deepEqual(thinking, ["正在核对真实回执"]);
  assert.deepEqual(tools, ["finish"]);
  assert.deepEqual(visible, [], "progress cannot publish the retained body early");
  release();
  const result = await running;
  assert.deepEqual(visible, []);
  assert.equal(result.toolCalls?.[0]?.id, "finish");
  assert.equal(result.content, "尚未核验的完成文案");
});

test("a settled provider cannot append late speech, thinking or tool-start events to another step", async () => {
  const fixture = envelopeProvider("fresh");
  const visible: string[] = [], thinking: string[] = [], tools: string[] = [];
  let late = () => {};
  fixture.chatCompletionStream = async (_messages, options, _signal, onDelta) => {
    options.onReasoningDelta?.("current thought");
    onDelta("fresh");
    late = () => {
      options.onReasoningDelta?.("orphan thought");
      options.onToolCallStarted?.({ index: 0, id: "late", name: "companion_finish" });
      onDelta("orphan speech");
    };
    return { content: "fresh", toolCalls: [], finishReason: "stop", usage: {} };
  };
  await runStreamingAgentStep({ provider: fixture, stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000,
    onProviderDelta: async text => { visible.push(text); return true; },
    onReasoningDelta: text => thinking.push(text), onToolCallStarted: tool => tools.push(tool.id) });
  late();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(visible, ["fresh"]);
  assert.deepEqual(thinking, ["current thought"]);
  assert.deepEqual(tools, []);
});

test("a provider's synchronous abort callbacks cannot publish a stale answer or tool start", async () => {
  const fixture = envelopeProvider("");
  const visible: string[] = [], thinking: string[] = [], tools: string[] = [];
  fixture.chatCompletionStream = async (_messages, options, signal, onDelta) => new Promise(resolve => {
    options.onReasoningDelta?.("current thought");
    options.onOutputActivity?.("reasoning");
    signal!.addEventListener("abort", () => {
      options.onReasoningDelta?.("orphan thought");
      options.onToolCallStarted?.({ index: 0, id: "late", name: "companion_finish" });
      onDelta("orphan speech");
      resolve({ content: "orphan speech", toolCalls: [], finishReason: "stop", usage: {} });
    }, { once: true });
  });
  await assert.rejects(runStreamingAgentStep({ provider: fixture, stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000,
    outputWatchdogPolicy: { firstOutputMs: 100, idleMs: 100, firstMeaningfulOutputMs: 10 },
    onProviderDelta: async text => { visible.push(text); return true; },
    onReasoningDelta: text => thinking.push(text), onToolCallStarted: tool => tools.push(tool.id) }),
  error => error instanceof CompanionOutputTimeoutError && error.code === "provider_idle_timeout");
  assert.deepEqual(visible, []);
  assert.deepEqual(thinking, ["current thought"]);
  assert.deepEqual(tools, []);
});

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

test("an empty envelope body never releases its internal metadata as conversation text", async () => {
  const malformed = '{"reply":"","delivery":{"outcome":"completed","evidence":}}';
  const shown: string[] = [];
  await assert.rejects(runStreamingAgentStep({ provider: envelopeProvider(malformed), stepRequest: request,
    ctxSignal: new AbortController().signal, timeoutMs: 1000,
    onProviderDelta: async delta => { shown.push(delta); return true; } }),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
  assert.equal(shown.length, 0);
  const empty = await runStreamingAgentStep({ provider: envelopeProvider('{"reply":"","delivery":{"actions":[]}}'),
    stepRequest: request, ctxSignal: new AbortController().signal, timeoutMs: 1000,
    onProviderDelta: async delta => { shown.push(delta); return true; } });
  assert.equal(empty.content, "");
  assert.equal(shown.length, 0);
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
