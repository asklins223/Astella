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
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";
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
  assert.deepEqual(result.reasoning, [{ type: "reasoning", id: "rs_stream", summary: [], encrypted_content: "opaque-stream" }]);
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
  assert.equal(valid.captured[0]?.body.tool_choice, "auto", "思考与 required 的兼容规则与整段请求一致");
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
  assert.equal(body.max_output_tokens, 4096);
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
test("executeAgentTurn: 开着思考时 required 降级为 auto，关着思考才保留 required", async () => {
  const thinkingOn = recordingRequester(ok(completionResponse({
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  })));
  const onProvider = makeProvider({
    request: thinkingOn.request,
    modelProfile: { reasoning: { levels: ["none", "high"], default: "high" } },
  });
  await onProvider.executeAgentTurn(agentTurnRequest({ toolChoice: "required" }));
  assert.deepEqual(thinkingOn.calls[0].body.reasoning, { effort: "high" });
  assert.equal(thinkingOn.calls[0].body.tool_choice, "auto");

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
  assert.equal(calls[0].body.max_output_tokens, 700);
  assert.equal(calls[0].body.text, undefined, "有工具时不下发 JSON 模式");
  assert.equal(result.content, "好的");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.providerRequestId, "resp_test_1");
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

test("Responses 最终正文排除中间 commentary，未声明 phase 的旧返回仍完整保留", () => {
  const message = (text: string, phase?: string) => ({ type: "message", phase, content: [{ type: "output_text", text }] });
  assert.equal(readResponsesFinalText({ output: [message("内部预备说明", "commentary"), message("最终正文", "final_answer")] }), "最终正文");
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

test("完成事件的正文与已收到增量不一致时不能静默替换或宣布成功", async () => {
  const { request } = streamingRequester([
    'data: {"type":"response.output_text.delta","delta":"半截旧稿"}\n\n',
    'data: {"type":"response.completed","response":{"output":[{"type":"message","phase":"final_answer","content":[{"type":"output_text","text":"另一份完整稿"}]}]}}\n\n',
  ]);
  await assert.rejects(() => makeProvider({ streamRequest: request }).chatCompletionStream([{ role: "user", content: "问题" }],
    { responseFormat: "text" }, undefined, () => undefined),
    (error: unknown) => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
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
      'data: {"type":"response.output_text.delta","delta":"半截答复"}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}' + ending,
    ]);
    const provider = makeProvider({ streamRequest: request });
    await assert.rejects(() => provider.chatCompletionStream(
      [{ role: "user", content: "hi" }], { responseFormat: "text" }, undefined, () => undefined),
      (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated");
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

test("readResponsesReasoningHandles: 剥离明文 reasoning_text，保留不透明字段", () => {
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
  assert.equal("content" in handles[0], false, "明文推理不得进入契约");
  assert.deepEqual(handles[0], {
    id: "rs_1",
    type: "reasoning",
    status: "completed",
    encrypted_content: "opaque-handle",
    summary: [],
  });
});

test("readResponsesReasoningHandles: 无 reasoning item 时为空数组", () => {
  assert.deepEqual(readResponsesReasoningHandles({ output: [{ type: "message", content: [] }] }), []);
  assert.deepEqual(readResponsesReasoningHandles({}), []);
});

test("executeAgentTurn: 返回 reasoning 句柄（不含明文）", async () => {
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
  assert.equal("content" in (result.reasoning?.[0] ?? {}), false, "明文推理不得外泄给调用方");
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
