/**
 * OpenCodeGoProvider 单元测试。
 *
 * 覆盖 Responses API 契约映射：input items（含 function_call /
 * function_call_output）、output items 解析、reasoning 档位、
 * 强制 header、能力快照与失败分类。
 * 全部通过注入的 requester 完成，不发真实网络请求。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OpenCodeGoProvider,
  continuationAssistantsCarryPlaintext,
  parseResponsesAgentTurn,
  readResponsesReasoningHandles,
  readResponsesText,
  readResponsesFinalText,
  readResponsesUsage,
  resolveOpenCodeGoEndpoint,
} from "../lib/providers/opencode-go.ts";
import type {
  PublicJsonRequester,
  PublicJsonResponse,
  PublicStreamingRequester,
  PublicStreamingResponse,
} from "@astella/shared/public-json-http";
import type { AgentTurnRequest, ChatMessage } from "@astella/shared";
import { AgentRole } from "@astella/shared";
import { ProviderRequestError, ProviderStreamError } from "../lib/provider-request-error.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import { runStreamingAgentStep } from "../handlers/agent/companion-agent-streaming-step.ts";
import { createGovernedProvider } from "../lib/governance.ts";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 记录请求的 JSON requester，返回预设响应。 */
function recordingRequester(response: PublicJsonResponse): {
  request: PublicJsonRequester;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const request: PublicJsonRequester = async (url, headers, body) => {
    calls.push({ url, headers, body: body as Record<string, unknown> });
    return response;
  };
  return { request, calls };
}

function ok(body: unknown): PublicJsonResponse {
  return { status: 200, statusText: "OK", body };
}

/** 把预设的 SSE 文本切成任意边界的分片，验证增量解析。 */
function streamingRequester(
  chunks: string[],
  status = 200,
): { request: PublicStreamingRequester; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const request: PublicStreamingRequester = async (url, headers, body): Promise<PublicStreamingResponse> => {
    captured.push({ url, headers, body: body as Record<string, unknown> });
    const encoder = new TextEncoder();
    async function* iterate(): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield encoder.encode(chunk);
    }
    return { status, statusText: "OK", body: iterate(), cancel: () => undefined };
  };
  return { request, captured };
}

function makeProvider(overrides: Partial<ConstructorParameters<typeof OpenCodeGoProvider>[0]> = {}): OpenCodeGoProvider {
  return new OpenCodeGoProvider({
    apiKey: "test-key",
    baseUrl: "https://opencode.ai/zen/go/v1",
    model: "muse-spark-1.3-contributor",
    ...overrides,
  });
}

test("an actual host observation follows her last reply without inventing user speech or reasoning", async () => {
  const { request, calls } = recordingRequester(ok({ status: "completed", output: [] }));
  await makeProvider({ request }).executeAgentTurn({ role: AgentRole.COMPANION_AGENT,
    systemPrompt: "trusted policy", tools: [], maxTokens: 100, temperature: 0.2,
    messages: [{ role: "user", content: "earlier real user request" }, { role: "assistant", content: "earlier actual answer" },
      { role: "system", hostObservation: true, content: "new actual host observation" }] });
  const body = calls[0]!.body;
  const items = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(items.map(item => item.role ?? item.type), ["user", "assistant", "system"]);
  assert.equal(items.at(-1)!.content, "new actual host observation");
  assert.equal(body.instructions, "trusted policy");
});

test("工具循环的流式终答保留原生调用/回执及不透明思考句柄，经过同一外发治理", async () => {
  const { request, captured } = streamingRequester([
    'data: {"type":"response.output_text.delta","delta":"笔记已保存，可以打开。"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  ]);
  const provider = makeProvider({ streamRequest: request });
  const governed = createGovernedProvider(provider, { consentOk: true, policy: {
    sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: false,
  } }, "synthetic-stream-scope");
  const step = agentTurnRequest({ tools: [], messages: [
    { role: "user", content: "把知识点写成一篇笔记。" },
    { role: "assistant", content: "我正在保存。", phase: "commentary",
      reasoning: [{ type: "reasoning", id: "rs_note", status: "completed", summary: [], encrypted_content: "opaque-note" }],
      toolCalls: [{ id: "save_note", name: "companion_create_note", arguments: { title: "知识点", example: "testperson@example.com" } }] },
    { role: "tool", toolCallId: "save_note", content: '{"status":"succeeded","noteId":"saved-synthetic-note"}' },
  ] });
  const result = await runStreamingAgentStep({ provider: governed, stepRequest: step,
    ctxSignal: new AbortController().signal, timeoutMs: 3000, onProviderDelta: async () => true });
  assert.equal(result.content, "笔记已保存，可以打开。");
  const input = captured[0]!.body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input.map(item => item.type ?? item.role), ["user", "reasoning", "assistant", "function_call", "function_call_output"]);
  assert.equal(input[1]!.encrypted_content, "opaque-note");
  assert.equal(input[2]!.phase, "commentary");
  assert.equal(input[3]!.call_id, "save_note");
  assert.equal(input[4]!.call_id, "save_note");
  assert.ok(!JSON.stringify(input).includes("testperson@example.com"), "原生历史不能绕过PII治理");
  assert.equal(captured[0]!.body.tools, undefined, "终答没有新的写工具");
});

function completionResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_test_1",
    object: "response",
    status: "completed",
    model: "muse-spark-1.3-contributor",
    output: [
      { id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "opaque" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "你好", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens_details: { reasoning_tokens: 12 },
    },
    ...overrides,
  };
}

function agentTurnRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "你是伴星助手。",
    messages: [{ role: "user", content: "今天学什么？" }],
    tools: [
      {
        name: "companion_read_context",
        description: "读取当前学习上下文",
        parameters: { type: "object", properties: {} },
      },
    ],
    maxTokens: 700,
    temperature: 0.9,
    ...overrides,
  } as AgentTurnRequest;
}

test("带工具的真实流式步骤在终止事件前交付首句，并保留工具和思考句柄", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delivered!: () => void;
  const firstSentence = new Promise<void>(resolve => { delivered = resolve; });
  let captured: Record<string, unknown> | undefined;
  const text = "我先看看当前内容，再陪你整理。";
  const terminal = completionResponse({ output: [
    { type: "reasoning", id: "rs_stream", summary: [], encrypted_content: "opaque-stream", content: [{ text: "private reasoning" }] },
    { type: "message", content: [{ type: "output_text", text }] },
    { type: "function_call", call_id: "call_context", name: "companion_read_context", arguments: '{"section":"current"}' },
  ] });
  const provider = makeProvider({ streamRequest: async (_url, _headers, body) => {
    captured = body as Record<string, unknown>;
    async function* stream() {
      yield new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
      await gate;
      yield new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`);
    }
    return { status: 200, statusText: "OK", body: stream(), cancel: () => undefined };
  } });
  const governed = createGovernedProvider(provider, { consentOk: true, policy: {
    sendToExternal: true, sendImageContent: false, piiDetection: true, auditLogging: false,
  } }, "synthetic-stream-scope");
  assert.equal(governed.chatCompletionStreamToolCalls, true, "真实运行时据此决定工具步骤是否能流式");
  let finished = false;
  const pending = runStreamingAgentStep({ provider: governed, stepRequest: agentTurnRequest(),
    ctxSignal: new AbortController().signal, timeoutMs: 1000,
    onProviderDelta: async delta => { assert.equal(delta, text); delivered(); return true; },
  }).then(result => { finished = true; return result; });
  try {
    await firstSentence;
    assert.equal(finished, false, "首句不能等模型整段结束才发");
    assert.deepEqual(captured?.tools, [{ type: "function", ...agentTurnRequest().tools[0] }]);
    assert.equal(captured?.tool_choice, "auto");
  } finally { release(); }
  const result = await pending;
  assert.deepEqual(result.toolCalls, [{ id: "call_context", name: "companion_read_context", arguments: { section: "current" } }]);
  assert.deepEqual(result.reasoning, [
    { type: "reasoning", id: "rs_stream", summary: [], encrypted_content: "opaque-stream",
      content: [{ text: "private reasoning" }] },
  ], "明文随句柄一起带回：网关在思考模式下要的就是它（0435）");
  assert.equal(result.providerRequestId, "resp_test_1");
  assert.equal(result.usage?.totalTokens, 160);
});

test("原生流式工具调用允许无正文；损坏参数和缺失终止快照仍拒绝", async () => {
  const tool = { type: "function_call", call_id: "read_1", name: "companion_read_context", arguments: "{}" };
  const stream = (response: unknown) => streamingRequester([
    `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ]);
  const native = agentTurnRequest({ toolChoice: "required" });
  const valid = stream({ status: "completed", output: [tool] });
  const provider = makeProvider({ streamRequest: valid.request, modelProfile: { reasoning: { default: "high", levels: ["none", "high"] } } });
  const result = await runStreamingAgentStep({ provider, stepRequest: native,
    ctxSignal: new AbortController().signal, timeoutMs: 1000, onProviderDelta: async () => { assert.fail("工具参数不能作为正文"); } });
  assert.equal(result.content, "");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls[0]?.id, "read_1");
  assert.equal(valid.captured[0]?.body.tool_choice, "required", "强制工具轮关闭思考后仍使用 required");
  for (const [response, code] of [
    [{ status: "completed", output: [{ ...tool, arguments: '{"broken":' }] }, "arguments_malformed"],
    [{ status: "completed" }, "stream_incomplete"],
  ] as const) {
    const broken = stream(response);
    await assert.rejects(() => makeProvider({ streamRequest: broken.request }).chatCompletionStream([], {
      responseFormat: "text", nativeAgentRequest: native,
    }, undefined, () => undefined), (error: unknown) => error instanceof Error && "code" in error && error.code === code);
  }
});

// ─── 端点解析 ────────────────────────────────────────────────────────────

test("resolveOpenCodeGoEndpoint: 追加 /responses", () => {
  assert.equal(
    resolveOpenCodeGoEndpoint("https://opencode.ai/zen/go/v1"),
    "https://opencode.ai/zen/go/v1/responses",
  );
});

test("resolveOpenCodeGoEndpoint: 已是 /responses 不重复追加（含尾斜杠）", () => {
  assert.equal(
    resolveOpenCodeGoEndpoint("https://opencode.ai/zen/go/v1/responses/"),
    "https://opencode.ai/zen/go/v1/responses",
  );
});

test("resolveOpenCodeGoEndpoint: 拒绝非 opencode.ai 域名", () => {
  assert.throws(
    () => resolveOpenCodeGoEndpoint("https://evil.example.com/v1"),
    /opencode\.ai/,
  );
  assert.throws(() => resolveOpenCodeGoEndpoint("not-a-url"), /Invalid OpenCode Go baseUrl/);
});

// ─── 构造与 header 约束 ───────────────────────────────────────────────────

test("constructor: 非 opencode.ai baseUrl 直接抛错（不发出请求）", () => {
  assert.throws(
    () => makeProvider({ baseUrl: "https://api.example.com/v1" }),
    /opencode\.ai/,
  );
});

test("请求必须带 x-opencode-session / User-Agent / Authorization", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request, sessionId: "sess-fixed-1" });
  await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(calls[0].headers["x-opencode-session"], "sess-fixed-1");
  assert.equal(calls[0].headers["User-Agent"], "astella-ai-worker/1.0");
  assert.equal(calls[0].headers.Authorization, "Bearer test-key");
});

test("未显式给 sessionId 时：同实例内稳定、不同实例间不同", async () => {
  const first = recordingRequester(ok(completionResponse()));
  const second = recordingRequester(ok(completionResponse()));
  const providerA = makeProvider({ request: first.request });
  const providerB = makeProvider({ request: second.request });
  await providerA.chatCompletion([{ role: "user", content: "1" }], {});
  await providerA.chatCompletion([{ role: "user", content: "2" }], {});
  await providerB.chatCompletion([{ role: "user", content: "3" }], {});
  const sessionA = first.calls[0].headers["x-opencode-session"];
  assert.ok(sessionA, "必须自动生成会话 ID");
  assert.equal(first.calls[1].headers["x-opencode-session"], sessionA, "同一实例会话 ID 必须稳定");
  assert.notEqual(
    second.calls[0].headers["x-opencode-session"],
    sessionA,
    "不同实例（不同 job/会话）必须是不同 ID",
  );
});

// ─── chatCompletion ──────────────────────────────────────────────────────

test("chatCompletion: system 进 instructions，user 进 input", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  const messages: ChatMessage[] = [
    { role: "system", content: "系统 A" },
    { role: "system", content: "系统 B" },
    { role: "user", content: "问题" },
  ];
  await provider.chatCompletion(messages, { responseFormat: "text" });
  const body = calls[0].body;
  assert.equal(body.instructions, "系统 A\n\n系统 B");
  assert.deepEqual(body.input, [{ role: "user", content: "问题" }]);
  assert.equal(body.stream, false);
  // 档案没声明时，线上发的是这一档平台自己声明的最大输出——调用方那个 4096
  // 不再是天花板（它只会在档案缺失时把长回答砍成半截话）。
  assert.equal(body.max_output_tokens, 131_072);
});

test("chatCompletion: 默认 JSON 模式，responseFormat=text 时不下发 text.format", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  await provider.chatCompletion([{ role: "user", content: "a" }], {});
  assert.deepEqual(calls[0].body.text, { format: { type: "json_object" } });
  await provider.chatCompletion([{ role: "user", content: "a" }], { responseFormat: "text" });
  assert.equal(calls[1].body.text, undefined);
});

test("chatCompletion: 解析 output_text 与 Responses 形态 usage", async () => {
  const { request } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  const result = await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.equal(result.content, "你好");
  assert.equal(result.usage.promptTokens, 120);
  assert.equal(result.usage.completionTokens, 40);
  assert.equal(result.usage.totalTokens, 160);
  assert.equal(result.usage.cacheHitTokens, 64);
  assert.equal(result.usage.requestId, "resp_test_1");
});

test("chatCompletion: multimodal user content 映射为 input_text/input_image", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  await provider.chatCompletion([
    {
      role: "user",
      content: [
        { type: "text", text: "这张图是什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } },
      ],
    },
  ], {});
  assert.deepEqual(calls[0].body.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "这张图是什么？" },
      { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "low" },
    ],
  }]);
});

test("chatCompletion: 模型档案 reasoning.default → reasoning.effort", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({
    request,
    modelProfile: { reasoning: { levels: ["minimal", "low", "medium", "high", "xhigh"], default: "high" } },
  });
  await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.deepEqual(calls[0].body.reasoning, { effort: "high" });
});

test("chatCompletion: 档案 default=none 显式关闭思考（deepseek 系支持 none）", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({
    request,
    modelProfile: { reasoning: { levels: ["none", "low", "high", "max"], default: "none" } },
  });
  await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.deepEqual(calls[0].body.reasoning, { effort: "none" });
});

test("chatCompletion: 未声明 reasoning 时不下发档位（用网关默认）", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.equal(calls[0].body.reasoning, undefined);
});

test("chatCompletion: 显式关思考取声明档位里最接近关的一档（muse-spark 不支持 none）", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({
    request,
    modelProfile: { reasoning: { levels: ["minimal", "low", "medium", "high", "xhigh"], default: "high" } },
  });
  await provider.chatCompletion([{ role: "user", content: "hi" }], { disableThinking: true });
  assert.deepEqual(calls[0].body.reasoning, { effort: "minimal" });
});

test("chatCompletion: 模型支持 none 时显式关思考直接发 none", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({
    request,
    modelProfile: { reasoning: { levels: ["none", "low", "high", "max"], default: "high" } },
  });
  await provider.chatCompletion([{ role: "user", content: "hi" }], { disableThinking: true });
  assert.deepEqual(calls[0].body.reasoning, { effort: "none" });
});

test("采样受限模型在 chat、stream、agent 三个出口开思考时都省略温度，关时保留", async () => {
  const sent: Record<string, unknown>[] = [];
  const provider = makeProvider({ modelProfile: { temperature: "reasoning_none_only",
    reasoning: { levels: ["none", "medium"], default: "medium" } },
    request: async (_url, _headers, body) => { sent.push(body as Record<string, unknown>);
      return ok({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "完整答复" }] }] }); },
    streamRequest: async (_url, _headers, body) => { sent.push(body as Record<string, unknown>);
      return { status: 200, statusText: "OK", cancel: () => undefined, body: (async function* () {
        yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"完整答复"}\n\ndata: {"type":"response.completed"}\n\n');
      })() }; } });
  for (const disableThinking of [false, true]) {
    await provider.chatCompletion([{ role: "user", content: "问题" }], { disableThinking, temperature: 0.9, responseFormat: "text" });
    await provider.chatCompletionStream([{ role: "user", content: "问题" }], { disableThinking, temperature: 0.9, responseFormat: "text" }, undefined, () => undefined);
    await provider.executeAgentTurn({ role: "companion_agent", systemPrompt: "答复", messages: [{ role: "user", content: "问题" }],
      tools: [], maxTokens: 8000, temperature: 0.9, disableThinking });
  }
  assert.ok(sent.slice(0, 3).every(body => !("temperature" in body)));
  assert.ok(sent.slice(3).every(body => body.temperature === 0.9));
});

test("chatCompletion: 无档案时显式关思考回退 minimal", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  await provider.chatCompletion([{ role: "user", content: "hi" }], { disableThinking: true });
  assert.deepEqual(calls[0].body.reasoning, { effort: "minimal" });
});

test("executeAgentTurn: 档案档位同样作用于工具调用请求", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({
    request,
    modelProfile: { reasoning: { levels: ["none", "low", "high", "max"], default: "none" } },
  });
  await provider.executeAgentTurn(agentTurnRequest());
  assert.deepEqual(calls[0].body.reasoning, { effort: "none" });
});

/**
 * 2026-10-06 真窗口实测：开着思考发 `tool_choice: "required"`，deepseek-v4.1-flash
 * 直接 400「Thinking mode does not support this tool_choice」——带图那一轮必然要她
 * 调 `companion_read_image`，正好撞上，整轮失败。思考档与强制工具调用在这端互斥，
 * 所以降级成 auto；关掉思考时才允许真的强制。
 */
test("executeAgentTurn: 模型支持 none 时关闭思考以保留 required tool choice", async () => {
  const thinkingOn = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const onProvider = makeProvider({
    request: thinkingOn.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await onProvider.executeAgentTurn(agentTurnRequest({ toolChoice: "required" }));
  assert.deepEqual(thinkingOn.calls[0].body.reasoning, { effort: "none" });
  assert.equal(thinkingOn.calls[0].body.tool_choice, "required");

  const thinkingOff = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const offProvider = makeProvider({
    request: thinkingOff.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "none" } },
  });
  await offProvider.executeAgentTurn(agentTurnRequest({ toolChoice: "required" }));
  assert.equal(thinkingOff.calls[0].body.tool_choice, "required");
});

/**
 * 网关契约（2026-10-14 真网关实测，完整矩阵记在 `scripts/probe-plaintext-reasoning.ts`）：
 * 思考开 + 带工具 + **正文非空的 assistant 收尾** + 没带回那条的 `reasoning_text` 明文
 * = 400「reasoning_text must be passed back」。主动参与轮天生是这个形状，
 * 所以 0435 起明文随消息落库；带不回来时才降到关思考。
 */
test("continuationAssistantsCarryPlaintext：只认带明文 reasoning_text 的续写", () => {
  const carries = (messages: Array<Record<string, unknown>>) =>
    continuationAssistantsCarryPlaintext(messages as never);
  const plain = [{ type: "reasoning_text", text: "我先想清楚他要什么" }];
  const encryptedOnly = [{ type: "summary", text: "…" }];

  assert.equal(carries([
    { role: "user", content: "hi" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "嗨" },
  ]), true, "带明文 → 网关放行，不必关思考");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { type: "reasoning", content: encryptedOnly },
    { role: "assistant", content: "嗨" },
  ]), false, "只带 encrypted_content 同样 400，必须关思考");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "嗨" },
    { role: "system", content: "宿主观察：人在学习页" },
  ]), true, "尾部宿主观察不改变判定");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "嗨" },
  ]), false, "没带 reasoning → 关思考");

  // 工具循环续跑位：assistant 带 toolCalls、后面接回执。实测 encrypted-only 句柄
  // 就够（probe-reasoning-passback-v4.ts 的 E 发），不要求明文。
  assert.equal(carries([
    { role: "user", content: "hi" },
    { type: "reasoning", content: encryptedOnly },
    { role: "assistant", content: "查一下进度" },
    { type: "function_call_output", call_id: "c1", output: "{}" },
  ]), true, "工具循环位不要求明文，不误伤续跑");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
  ]), true, "正文为空的 assistant 收尾实测能过，不在约束里");

  assert.equal(carries([
    { type: "reasoning", content: plain },
    { role: "user", content: "hi" },
  ]), true, "没有 assistant 消息，不适用");

  // 真实失败快照的形状（probe-mutate-snapshot.ts 的 V0）：末尾三条连发 assistant，
  // 只有最后一条带明文 → 400。逐条判据必须抓到中间那两条缺的。
  assert.equal(carries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "上一条" },
    { role: "assistant", content: "这一条" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "末条" },
  ]), false, "末尾连发的 assistant 中间两条缺明文 → 关思考（真实 V0 形状）");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "上一条" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "这一条" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "末条" },
  ]), true, "每条都带明文（真实 V2 形状）");

  assert.equal(carries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "中间那条" },
    { role: "user", content: "再来" },
    { type: "reasoning", content: plain },
    { role: "assistant", content: "末条" },
  ]), true, "被用户消息隔开的 assistant 不在约束里（真实 V1 形状）");
});

test("executeAgentTurn: 带工具且 assistant 收尾时，只在没带回明文时关思考", async () => {
  // 真实的 reasoning item 形状：完整 item，明文在 `content[].reasoning_text` 里。
  const plainReasoning = [{
    type: "reasoning", id: "rs_1", status: "completed", summary: [],
    content: [{ type: "reasoning_text", text: "想清楚他要什么" }],
  }];

  // 带明文 → 思考照发。
  const withPlaintext = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const plaintextProvider = makeProvider({
    request: withPlaintext.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await plaintextProvider.executeAgentTurn(agentTurnRequest({ messages: [
    { role: "user", content: "嗨" },
    { role: "assistant", content: "嗨，学起来吗？", reasoning: plainReasoning },
  ] as never }));
  assert.deepEqual(withPlaintext.calls[0].body.reasoning, { effort: "high" },
    "带回明文：网关放行，思考保得住——这正是 0435 落库的意义");

  // 没带明文 → 关思考。
  const noPlaintext = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const noPlaintextProvider = makeProvider({
    request: noPlaintext.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await noPlaintextProvider.executeAgentTurn(agentTurnRequest({ messages: [
    { role: "user", content: "嗨" },
    { role: "assistant", content: "嗨，学起来吗？" },
  ] as never }));
  assert.deepEqual(noPlaintext.calls[0].body.reasoning, { effort: "none" },
    "带不回明文（历史早于 0435）：降到关思考，不让整轮死掉");

  // 以用户收尾 → 不受影响。
  const userTurn = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const userProvider = makeProvider({
    request: userTurn.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await userProvider.executeAgentTurn(agentTurnRequest());
  assert.deepEqual(userTurn.calls[0].body.reasoning, { effort: "high" },
    "以用户收尾的正常轮不受守卫影响");

  // 无工具 → 不受影响。
  const noTools = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const noToolsProvider = makeProvider({
    request: noTools.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await noToolsProvider.executeAgentTurn(agentTurnRequest({ tools: [], messages: [
    { role: "user", content: "嗨" },
    { role: "assistant", content: "嗨，学起来吗？" },
  ] as never }));
  assert.deepEqual(noTools.calls[0].body.reasoning, { effort: "high" },
    "无工具的续写形状实测能过网关，不降级");
});

test("chatCompletionStream: 流式原生路径同样受守卫（同一条网关契约）", async () => {
  const stream = streamingRequester([
    `data: ${JSON.stringify({ type: "response.completed", response: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "好" }] }],
    } })}\n\n`,
  ]);
  const provider = makeProvider({
    streamRequest: stream.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await provider.chatCompletionStream([], {
    responseFormat: "text",
    nativeAgentRequest: agentTurnRequest({ messages: [
      { role: "user", content: "嗨" },
      { role: "assistant", content: "嗨，学起来吗？" },
    ] as never }),
  }, undefined, () => undefined);
  assert.deepEqual(stream.captured[0]?.body.reasoning, { effort: "none" });
});

test("chatCompletion: disableMaxTokens 时不带 max_output_tokens", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request, platformOptions: { disableMaxTokens: true } });
  await provider.chatCompletion([{ role: "user", content: "hi" }], {});
  assert.equal(calls[0].body.max_output_tokens, undefined);
});

test("chatCompletion: 空输出抛错", async () => {
  const { request } = recordingRequester(ok(completionResponse({ output: [] })));
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.chatCompletion([{ role: "user", content: "hi" }], {}),
    /returned empty output/,
  );
});

test("chatCompletion: HTTP 错误抛 ProviderRequestError 并带 error.type", async () => {
  const { request } = recordingRequester({
    status: 401,
    statusText: "Unauthorized",
    body: { error: { type: "ModelError", message: "Model is not supported" } },
  });
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.chatCompletion([{ role: "user", content: "hi" }], {}),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.providerCode, "ModelError");
      return true;
    },
  );
});

test("chatCompletion: 2xx + status=failed 视为失败", async () => {
  const { request } = recordingRequester(ok({
    id: "resp_x",
    status: "failed",
    error: { code: "server_error", message: "upstream exploded" },
    output: [],
  }));
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.chatCompletion([{ role: "user", content: "hi" }], {}),
    /response failed .*upstream exploded/,
  );
});

test("普通 Responses chat 也拒绝 max_output_tokens 截断的正文", async () => {
  const { request } = recordingRequester(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "截断的识图结果" }] }] }));
  await assert.rejects(() => makeProvider({ request }).chatCompletion([{ role: "user", content: "读图" }], { responseFormat: "text" }),
    (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated");
});

// ─── executeAgentTurn ────────────────────────────────────────────────────

test("executeAgentTurn: tools 使用 Responses 扁平 function 格式，无 function 包装层", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "好的" }],
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  const result = await provider.executeAgentTurn(agentTurnRequest());
  assert.deepEqual(calls[0].body.tools, [{
    type: "function",
    name: "companion_read_context",
    description: "读取当前学习上下文",
    parameters: { type: "object", properties: {} },
  }]);
  assert.equal(calls[0].body.tool_choice, "auto");
  assert.equal(calls[0].body.instructions, "你是伴星助手。");
  // 同上：没档案声明时用平台最大输出，700 这个按任务抄的数不再上线。
  assert.equal(calls[0].body.max_output_tokens, 131_072);
  assert.equal(calls[0].body.text, undefined, "有工具时不下发 JSON 模式");
  assert.equal(result.content, "好的");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.providerRequestId, "resp_test_1");
});

/**
 * steer 的内部核对指令是**步中**注入的一条 system 消息（companion-step-plan.ts 的
 * companionStepCorrectionMessages）。Responses 只有一个 instructions 字段，
 * 这条若被跳过，她就只收到重附的用户回合，不知道那句是要纠正上一段。
 */
test("executeAgentTurn: 步中注入的 system 指令并进 instructions，input 不留下 system item", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "好的" }],
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  await makeProvider({ request }).executeAgentTurn(agentTurnRequest({
    messages: [
      { role: "user", content: "把刚才那段改一下" },
      { role: "assistant", content: "已改成三段。" },
      { role: "system", content: "这是本轮的内部核对，不是新的用户请求。" },
      { role: "user", content: "把刚才那段改一下" },
    ],
  }));
  assert.equal(calls[0].body.instructions,
    "你是伴星助手。\n\n这是本轮的内部核对，不是新的用户请求。");
  assert.deepEqual(calls[0].body.input, [
    { role: "user", content: "把刚才那段改一下" },
    { role: "assistant", content: "已改成三段。" },
    { role: "user", content: "把刚才那段改一下" },
  ]);
});

test("executeAgentTurn: function_call output item → toolCalls（arguments 已解析）", async () => {
  const { request } = recordingRequester(ok(completionResponse({
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
      { type: "function_call", call_id: "call_1", name: "companion_read_context", arguments: "{\"scope\":\"today\"}" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  const result = await provider.executeAgentTurn(agentTurnRequest());
  assert.deepEqual(result.toolCalls, [{
    id: "call_1",
    name: "companion_read_context",
    arguments: { scope: "today" },
  }]);
  assert.equal(result.finishReason, "tool_calls");
});

test("executeAgentTurn: 工具历史回放为 function_call + function_call_output", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  await provider.executeAgentTurn(agentTurnRequest({
    messages: [
      { role: "user", content: "今天学什么？" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "companion_read_context", arguments: { scope: "today" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "{\"ok\":true}" },
    ],
  }));
  assert.deepEqual(calls[0].body.input, [
    { role: "user", content: "今天学什么？" },
    { type: "function_call", call_id: "call_1", name: "companion_read_context", arguments: "{\"scope\":\"today\"}" },
    { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
  ]);
});

test("executeAgentTurn: 无工具轮保持自然文本（不写 text.format；structured_action 由 content 解析）", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "{\"toolCalls\":[{\"id\":\"c1\",\"name\":\"noop\",\"arguments\":{}}]}" }],
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  const result = await provider.executeAgentTurn(agentTurnRequest({ tools: [] }));
  // 根因二（2026-09-19）：无工具轮不再强制 json_object——伴星终答要自然文本，
  // 信封模型按 JSON 输出是 json_envelope_leak 的直接来源。
  assert.equal(calls[0].body.text, undefined);
  assert.equal(calls[0].body.tools, undefined);
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "noop", arguments: {} }]);
});

test("executeAgentTurn: status=incomplete/max_output_tokens → 不可重试的 output_truncated", async () => {
  const { request } = recordingRequester(ok({
    id: "resp_trunc",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "半句话" }] }],
    usage: { input_tokens: 10, output_tokens: 700, total_tokens: 710 },
  }));
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.executeAgentTurn(agentTurnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof AgentOutputError);
      assert.equal(error.code, "output_truncated");
      return true;
    },
  );
});

test("executeAgentTurn: arguments 非法 JSON → 不可重试的 arguments_malformed", async () => {
  const { request } = recordingRequester(ok(completionResponse({
    output: [{ type: "function_call", call_id: "call_bad", name: "companion_read_context", arguments: "{\"scope\":" }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.executeAgentTurn(agentTurnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof AgentOutputError);
      assert.equal(error.code, "arguments_malformed");
      return true;
    },
  );
});

test("executeAgentTurn: HTTP 500（muse-spark 在 chat/completions 的表现）分类为 ProviderRequestError", async () => {
  const { request } = recordingRequester({
    status: 500,
    statusText: "Internal Server Error",
    body: { type: "error", error: { type: "error", message: "Internal server error" } },
  });
  const provider = makeProvider({ request });
  await assert.rejects(
    () => provider.executeAgentTurn(agentTurnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test("executeAgentTurn: 已 abort 的 signal 立即抛错且不发请求", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request });
  const controller = new AbortController();
  controller.abort(new Error("job cancelled"));
  await assert.rejects(
    () => provider.executeAgentTurn(agentTurnRequest(), controller.signal),
    /job cancelled/,
  );
  assert.equal(calls.length, 0);
});

// ─── 流式 ────────────────────────────────────────────────────────────────

test("Responses 最终正文排除中间与未知阶段，兼容 final 和未声明 phase 的旧返回", () => {
  const message = (text: string, phase?: string) => ({ type: "message", phase, content: [{ type: "output_text", text }] });
  assert.equal(readResponsesFinalText({ output: [message("内部预备说明", "commentary"), message("最终正文", "final_answer")] }), "最终正文");
  assert.equal(readResponsesFinalText({ output: [message("私有分析", "analysis"), message("最终正文", "final")] }), "最终正文");
  assert.equal(readResponsesFinalText({ output: [message("只有私有分析", "analysis")] }), null);
  assert.equal(readResponsesFinalText({ output: [message("旧格式一"), message("旧格式二")] }), "旧格式一旧格式二");
  assert.equal(readResponsesFinalText({ output: [message("只有中间消息", "commentary")] }), null);
});

test("流式发布 final_answer，commentary 原样回放时带原始 phase", async () => {
  const { request, captured } = streamingRequester([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","phase":"commentary"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"预备说明"}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","phase":"final_answer"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":1,"delta":"最终正文"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","phase":"commentary","content":[{"type":"output_text","text":"预备说明"}]},{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"最终正文"}]}]}}\n\n',
  ]);
  const provider = makeProvider({ streamRequest: request }), deltas: string[] = [];
  const result = await provider.chatCompletionStream([{ role: "assistant", content: "前一条说明", phase: "commentary" },
    { role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text));
  assert.deepEqual(deltas, ["最终正文"]);
  assert.equal(result.content, "最终正文");
  assert.equal(result.phase, "final_answer");
  const inputs = captured[0]!.body.input as Array<{ role: string; phase?: string }>;
  assert.equal(inputs[0]?.phase, "commentary");
  assert.equal(inputs[1]?.phase, undefined);
});

test("未声明阶段能力的模型也不外发 analysis，final 阶段仍可见", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","phase":"analysis"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"私有分析"}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","phase":"final"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":1,"delta":"用户可见答案"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","phase":"analysis","content":[{"type":"output_text","text":"私有分析"}]},{"type":"message","phase":"final","content":[{"type":"output_text","text":"用户可见答案"}]}]}}\n\n',
  ]);
  const deltas: string[] = [];
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text));
  assert.deepEqual(deltas, ["用户可见答案"]);
  assert.equal(result.content, "用户可见答案");
  assert.equal(result.phase, "final_answer");
});

test("仅有 analysis 阶段时拒绝空的可见答复", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","phase":"analysis"}}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"私有分析"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","phase":"analysis","content":[{"type":"output_text","text":"私有分析"}]}]}}\n\n',
  ]);
  const deltas: string[] = [];
  await assert.rejects(() => makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text)),
  (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_empty");
  assert.deepEqual(deltas, []);
});

test("完成事件的正文与已收到增量不一致时不能静默替换或宣布成功", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_text.delta","delta":"半截旧稿"}\n\n',
    'data: {"type":"response.completed","response":{"output":[{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"另一份完整稿"}]}]}}\n\n',
  ]);
  await assert.rejects(() => makeProvider({ streamRequest: request }).chatCompletionStream([{ role: "user", content: "问题" }],
    { responseFormat: "text" }, undefined, () => undefined),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
});

test("带索引的增量先于 commentary 阶段到达时不误判，并保留同响应的工具调用", async () => {
  const toolCall = { type: "function_call", call_id: "call_context", name: "companion_read_context", arguments: "{}" };
  const { request } = streamingRequester([
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"仅内部使用的准备说明"}\n\n',
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0,
      item: { type: "message", phase: "commentary", content: [{ type: "output_text", text: "仅内部使用的准备说明" }] } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: toolCall })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
      { type: "message", phase: "commentary", content: [{ type: "output_text", text: "仅内部使用的准备说明" }] }, toolCall,
    ] } })}\n\n`,
  ]);
  const deltas: string[] = [];
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "看看当前学习上下文" }],
    { responseFormat: "text", tools: agentTurnRequest().tools }, undefined, text => deltas.push(text));
  assert.equal(result.content, "");
  assert.deepEqual(deltas, []);
  assert.equal(result.toolCalls?.[0]?.id, "call_context");
});

test("流中标 final_answer、终态标 commentary 且文本逐字一致时保留这版并带回工具调用", async () => {
  const toolCall = { type: "function_call", call_id: "call_search", name: "companion_search_notes", arguments: "{}" };
  const text = "我先去库里搜一下这篇笔记";
  const { request } = streamingRequester([
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "final_answer" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: text })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: toolCall })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
      { type: "message", phase: "commentary", content: [{ type: "output_text", text }] }, toolCall,
    ] } })}\n\n`,
  ]);
  const deltas: string[] = [];
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "整理成一篇笔记" }],
    { responseFormat: "text", tools: agentTurnRequest().tools }, undefined, delta => deltas.push(delta));
  assert.equal(result.content, text);
  assert.deepEqual(deltas, [text]);
  assert.equal(result.toolCalls?.[0]?.id, "call_search");
});

test("终态有另一份正文时，已下发前缀出现在终态里也不能当一致", async () => {
  const streamed = "已下发的前缀";
  const { request } = streamingRequester([
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "final_answer" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: streamed })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
      { type: "message", phase: "commentary", content: [{ type: "output_text", text: streamed }] },
      { type: "message", phase: "final_answer", content: [{ type: "output_text", text: "另一份完整的正文" }] },
    ] } })}\n\n`,
  ]);
  await assert.rejects(() => makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, () => undefined),
  (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
});

test("terminal-only text and an omitted final delta settle without a second model call", async () => {
  for (const prefix of ["", "完整"]) {
    const { request, captured } = streamingRequester([
      ...(prefix ? [`data: ${JSON.stringify({ type: "response.output_text.delta", delta: prefix })}\n\n`] : []),
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "完整正文" }] }] } })}\n\n`,
    ]);
    const deltas: string[] = [];
    const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
      [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text));
    assert.equal(result.content, "完整正文");
    assert.equal(deltas.join(""), "完整正文");
    assert.equal(captured.length, 1);
  }
});

test("Responses emits write preparation before arguments finish and dispatches only a completed item once", async () => {
  const item = { type: "function_call", call_id: "write", name: "companion_create_note", arguments: "" };
  const done = { ...item, arguments: JSON.stringify({ title: "测试", markdown: "合成正文" }) };
  const events: string[] = [];
  const { request } = streamingRequester([
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: done.arguments })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: done })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [done] } })}\n\n`,
  ]);
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "生成笔记" }], { responseFormat: "text", tools: agentTurnRequest().tools,
      onToolCallStarted: call => events.push(`started:${call.id}`),
      onToolCallSettled: call => events.push(`settled:${call.id}`),
    }, undefined, () => undefined);
  assert.deepEqual(events, ["started:write", "settled:write"]);
  assert.equal(result.toolCalls?.[0]?.id, "write");
});

test("思考增量只交给 onReasoningDelta，不混进正文也不改变收尾", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"先确认他要的是定义还是例子"}\n\n',
    'data: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"，这题有标准答案。"}\n\n',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"合力等于质量乘加速度。"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"合力等于质量乘加速度。"}]}]}}\n\n',
  ]);
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "牛顿第二定律是什么" }],
    { responseFormat: "text", onReasoningDelta: text => reasoning.push(text) },
    undefined, text => deltas.push(text));
  assert.deepEqual(reasoning, ["先确认他要的是定义还是例子", "，这题有标准答案。"]);
  assert.deepEqual(deltas, ["合力等于质量乘加速度。"]);
  assert.equal(result.content, "合力等于质量乘加速度。");
});

test("没要思考出口的调用方一切照旧（不传回调时 provider 不做任何额外的事）", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.reasoning_text.delta","delta":"内部推理"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"正文"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"正文"}]}]}}\n\n',
  ]);
  const deltas: string[] = [];
  const result = await makeProvider({ streamRequest: request }).chatCompletionStream(
    [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text));
  assert.deepEqual(deltas, ["正文"]);
  assert.equal(result.content, "正文");
});

test("声明阶段输出的模型不提前发布未知阶段，完成时只发布已确认最终正文", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"尚未分类的预备稿"}\n\n',
    'data: {"type":"response.output_text.delta","output_index":1,"delta":"另一个最终稿"}\n\n',
    'data: {"type":"response.completed","response":{"output":[{"type":"message","phase":"commentary","content":[{"type":"output_text","text":"尚未分类的预备稿"}]},{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"另一个最终稿"}]}]}}\n\n',
  ]);
  const deltas: string[] = [];
  const result = await makeProvider({ streamRequest: request, modelProfile: { supportsAssistantPhase: true } }).chatCompletionStream(
    [{ role: "user", content: "问题" }], { responseFormat: "text" }, undefined, text => deltas.push(text));
  assert.deepEqual(deltas, ["另一个最终稿"]);
  assert.equal(result.content, "另一个最终稿");
});

test("chatCompletionStream: 逐 delta 回调并累计全文（跨分片断行）", async () => {
  const sse = [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_s\"}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_s\",\"status\":\"completed\"}}\n\n",
  ].join("");
  // 在 JSON 中间切断，验证跨 chunk 缓冲
  const parts = [sse.slice(0, 90), sse.slice(90, 200), sse.slice(200)];
  const { request, captured } = streamingRequester(parts);
  const provider = makeProvider({ streamRequest: request });
  const deltas: string[] = [];
  const result = await provider.chatCompletionStream(
    [{ role: "user", content: "hi" }],
    { responseFormat: "text" },
    undefined,
    (delta) => deltas.push(delta),
  );
  assert.deepEqual(deltas, ["你", "好"]);
  assert.equal(result.content, "你好");
  assert.equal(captured[0].body.stream, true);
  assert.equal(captured[0].headers.Accept, "text/event-stream");
});

test("chatCompletionStream: 终止事件后无换行也能收尾", async () => {
  const { request } = streamingRequester([
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"尾\"}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
  ]);
  const provider = makeProvider({ streamRequest: request });
  const result = await provider.chatCompletionStream(
    [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined,
  );
  assert.equal(result.content, "尾");
});

test("chatCompletionStream: 收到正文但缺完成事件，不能把断流当完整答复", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_text.delta","delta":"答复只到了半截"}\n\n',
  ]);
  const provider = makeProvider({ streamRequest: request }), deltas: string[] = [];
  await assert.rejects(() => provider.chatCompletionStream(
    [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, delta => deltas.push(delta)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stream_incomplete");
  assert.deepEqual(deltas, ["答复只到了半截"]);
});

test("chatCompletionStream: 输出额度耗尽，包括无末尾换行，使用不可重试的截断错误", async () => {
  for (const ending of ["\n\n", ""]) {
    const { request } = streamingRequester([
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"半截答复"}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}' + ending,
    ]);
    const provider = makeProvider({ streamRequest: request, modelProfile: { supportsAssistantPhase: false } });
    const deltas: string[] = [];
    await assert.rejects(() => provider.chatCompletionStream(
      [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, delta => deltas.push(delta)),
      (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated");
    assert.deepEqual(deltas, ["半截答复"]);
  }
});

test("chatCompletionStream: response.failed 记录固定状态，不带供应方错误正文", async () => {
  const { request } = streamingRequester([
    "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream 挂了\"}}}\n\n",
  ]);
  const provider = makeProvider({ streamRequest: request });
  await assert.rejects(
    () => provider.chatCompletionStream(
      [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined,
    ),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_failed"
      && !error.message.includes("upstream 挂了"),
  );
});

test("chatCompletionStream: 空输出抛错", async () => {
  const { request } = streamingRequester([
    "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
  ]);
  const provider = makeProvider({ streamRequest: request });
  await assert.rejects(
    () => provider.chatCompletionStream(
      [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined,
    ),
    /empty streaming output/,
  );
});

test("chatCompletionStream: HTTP 错误抛 ProviderRequestError", async () => {
  const { request } = streamingRequester([
    "{\"error\":{\"type\":\"ModelError\",\"message\":\"not supported\"}}",
  ], 401);
  const provider = makeProvider({ streamRequest: request });
  await assert.rejects(
    () => provider.chatCompletionStream(
      [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.providerCode, "ModelError");
      return true;
    },
  );
});

// ─── reasoning 句柄（多轮工具循环回放） ──────────────────────────────────

/**
 * 2026-10-14 用户决定（0435）：**不再剥离明文思维链**。
 *
 * 旧约束要求 provider 删掉 `content[].reasoning_text` 再返回。真网关三发实测推翻了它：
 * "思考开 + 带工具 + 以 assistant 收尾"这个形状下，带明文过、只带 encrypted_content 400、
 * 完全不带 400（`scripts/probe-plaintext-reasoning.ts`）。主动参与轮每一轮都是这个形状，
 * 剥掉之后那句话就再也凑不回来。
 */
test("readResponsesReasoningHandles: 保留明文 reasoning_text（网关要求交回）", () => {
  const handles = readResponsesReasoningHandles({
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        status: "completed",
        encrypted_content: "opaque-handle",
        content: [{ type: "reasoning_text", text: "这里是模型内部推理明文" }],
        summary: [],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "回答" }] },
    ],
  });
  assert.equal(handles.length, 1);
  assert.deepEqual(handles[0], {
    id: "rs_1",
    type: "reasoning",
    status: "completed",
    encrypted_content: "opaque-handle",
    content: [{ type: "reasoning_text", text: "这里是模型内部推理明文" }],
    summary: [],
  });
});

test("readResponsesReasoningHandles: 无 reasoning item 时为空数组", () => {
  assert.deepEqual(readResponsesReasoningHandles({ output: [{ type: "message", content: [] }] }), []);
  assert.deepEqual(readResponsesReasoningHandles({}), []);
});

test("executeAgentTurn: 返回 reasoning item 且含明文 reasoning_text", async () => {
  const { request } = recordingRequester(ok(completionResponse({
    output: [
      {
        id: "rs_deepseek",
        type: "reasoning",
        status: "completed",
        encrypted_content: "enc-1",
        content: [{ type: "reasoning_text", text: "明文思考内容" }],
        summary: [],
      },
      { type: "function_call", call_id: "call_1", name: "companion_read_context", arguments: "{}" },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  const result = await provider.executeAgentTurn(agentTurnRequest());
  assert.equal(result.reasoning?.length, 1);
  assert.equal(result.reasoning?.[0].id, "rs_deepseek");
  assert.equal(result.reasoning?.[0].summary !== undefined, true, "muse-spark 要求 summary 字段存在");
  assert.deepEqual(result.reasoning?.[0].content,
    [{ type: "reasoning_text", text: "明文思考内容" }],
    "明文必须原样带出：网关在思考模式下要的就是这句话，剥掉就凑不回来（0435）");
});

test("executeAgentTurn: 无 reasoning 的响应不带 reasoning 字段", async () => {
  const { request } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  const result = await provider.executeAgentTurn(agentTurnRequest());
  assert.equal(result.reasoning, undefined);
});

test("executeAgentTurn: reasoning 句柄回放为 reasoning item，且排在 function_call 之前", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "晴，21°C" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  await provider.executeAgentTurn(agentTurnRequest({
    messages: [
      { role: "user", content: "今天天气？" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "北京" } }],
        reasoning: [{ id: "rs_1", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-1" }],
      },
      { role: "tool", toolCallId: "call_1", content: "{\"tempC\":21}" },
    ],
  }));
  const input = calls[0].body.input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["user", "reasoning", "function_call", "function_call_output"],
  );
  assert.deepEqual(input[1], {
    type: "reasoning",
    id: "rs_1",
    status: "completed",
    summary: [],
    encrypted_content: "enc-1",
  });
  assert.equal(input[2].call_id, "call_1");
});

/**
 * 顺序回归护栏：模型产出顺序是 reasoning → message → function_call，
 * 回放必须保持同一顺序。把 message 排在 reasoning 之前会让 deepseek 思考模式
 * 400「reasoning_text must be passed back」（实测），与是否携带明文无关。
 */
test("executeAgentTurn: 带前导文本时顺序为 reasoning → message → function_call", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "晴，21°C" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  await provider.executeAgentTurn(agentTurnRequest({
    messages: [
      { role: "user", content: "今天天气？" },
      {
        role: "assistant",
        content: "我先查一下。",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "北京" } }],
        reasoning: [{ id: "rs_1", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-1" }],
      },
      { role: "tool", toolCallId: "call_1", content: "{\"tempC\":21}" },
    ],
  }));
  const input = calls[0].body.input as Array<Record<string, unknown>>;
  assert.deepEqual(
    input.map((item) => item.type ?? item.role),
    ["user", "reasoning", "assistant", "function_call", "function_call_output"],
  );
  assert.equal(input[2].content, "我先查一下。");
});

test("executeAgentTurn: assistant 无 reasoning 句柄时不注入 reasoning item（muse-spark 路径不变）", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })));
  const provider = makeProvider({ request });
  await provider.executeAgentTurn(agentTurnRequest({
    messages: [
      { role: "user", content: "今天天气？" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: {} }] },
      { role: "tool", toolCallId: "call_1", content: "{}" },
    ],
  }));
  const input = calls[0].body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input.map((item) => item.type ?? item.role), ["user", "function_call", "function_call_output"]);
});

// ─── 能力快照 ────────────────────────────────────────────────────────────

test("getCapabilities: 未声明档案时用内置缺省（muse-spark 基线 1M / 128K）", () => {
  const provider = makeProvider();
  const capabilities = provider.getCapabilities();
  assert.equal(capabilities.providerId, "opencode_go");
  assert.equal(capabilities.contextWindowTokens, 1_048_576);
  assert.equal(capabilities.maxOutputTokens, 131_072);
  assert.equal(capabilities.maxInputTokens, 1_048_576 - 131_072);
  assert.equal(capabilities.toolMode, "native_tools");
  assert.equal(capabilities.modelId, "muse-spark-1.3-contributor");
});

test("getCapabilities: 模型档案覆盖上下文与输出上限", () => {
  const provider = makeProvider({ modelProfile: { contextWindowTokens: 200_000, maxOutputTokens: 16_384 } });
  const capabilities = provider.getCapabilities();
  assert.equal(capabilities.contextWindowTokens, 200_000);
  assert.equal(capabilities.maxOutputTokens, 16_384);
  assert.equal(capabilities.maxInputTokens, 200_000 - 16_384);
});

test("max_output_tokens 受模型档案 maxOutputTokens 上限约束", async () => {
  const { request, calls } = recordingRequester(ok(completionResponse()));
  const provider = makeProvider({ request, modelProfile: { maxOutputTokens: 2_000 } });
  await provider.chatCompletion([{ role: "user", content: "hi" }], { maxTokens: 5_000 });
  assert.equal(calls[0].body.max_output_tokens, 2_000);
});

// ─── 纯解析函数 ──────────────────────────────────────────────────────────

test("readResponsesText: 拼接多个 message item，忽略 reasoning item", () => {
  assert.equal(readResponsesText({
    output: [
      { type: "reasoning", encrypted_content: "x" },
      { type: "message", content: [{ type: "output_text", text: "A" }] },
      { type: "message", content: [{ type: "output_text", text: "B" }] },
    ],
  }), "AB");
  assert.equal(readResponsesText({ output: [] }), null);
  assert.equal(readResponsesText({ output: [{ type: "message", content: [{ type: "output_text", text: "  " }] }] }), null);
});

test("readResponsesUsage: 缺 total 时由 input+output 推导；非法值不进入用量", () => {
  const usage = readResponsesUsage({ id: "r1", usage: { input_tokens: 10, output_tokens: 4 } });
  assert.equal(usage?.totalTokens, 14);
  assert.equal(readResponsesUsage({ usage: { input_tokens: 1.5, output_tokens: -2 } }), null);
  assert.equal(readResponsesUsage({}), null);
});

test("parseResponsesAgentTurn: finishReason 映射（completed/incomplete/未知）", () => {
  assert.equal(parseResponsesAgentTurn({ status: "completed", output: [] }, true).finishReason, "stop");
  assert.equal(
    parseResponsesAgentTurn({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, true).finishReason,
    "length",
  );
  assert.equal(
    parseResponsesAgentTurn({ status: "incomplete", incomplete_details: { reason: "content_filter" } }, true).finishReason,
    "content_filter",
  );
});

test("parseResponsesAgentTurn: arguments 为对象时也接受，非对象标记 malformed", () => {
  const asObject = parseResponsesAgentTurn({
    status: "completed",
    output: [{ type: "function_call", call_id: "c1", name: "t", arguments: { a: 1 } }],
  }, true);
  assert.deepEqual(asObject.toolCalls[0].arguments, { a: 1 });
  assert.equal(asObject.toolCalls[0].argumentsMalformed, undefined);

  const asArray = parseResponsesAgentTurn({
    status: "completed",
    output: [{ type: "function_call", call_id: "c2", name: "t", arguments: "[1,2]" }],
  }, true);
  assert.equal(asArray.toolCalls[0].argumentsMalformed, true);
});
