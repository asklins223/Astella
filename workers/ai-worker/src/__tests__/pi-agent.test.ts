import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRole, type AgentTurnRequest, type ModelProfile } from "@astella/shared";
import type { PublicStreamingRequester } from "@astella/shared/public-json-http";
import { PiAgentProvider } from "../lib/providers/pi-agent.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { createCapabilityProvider } from "../lib/provider-factory.ts";
import { ProviderRequestError, ProviderStreamError } from "../lib/provider-request-error.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";

const tool = { name: "lookup", description: "Read a value", parameters: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
} };
const request = (overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  role: AgentRole.COMPANION_AGENT, systemPrompt: "trusted policy", messages: [{ role: "user", content: "hello" }],
  tools: [], maxTokens: 50, temperature: 0.2, ...overrides,
});
const profile: ModelProfile = { protocol: "openai-responses", contextWindowTokens: 1000000, maxOutputTokens: 131072,
  vision: true, temperature: "reasoning_none_only", reasoning: { levels: ["none", "low", "medium", "high"], default: "medium" } };
const reasoning = { type: "reasoning", id: "rs_probe", status: "completed", summary: [],
  content: [{ type: "reasoning_text", text: "full synthetic thought" }], encrypted_content: "opaque" };
function message(text: string, phase?: string, id = "msg_probe") {
  return { type: "message", id, role: "assistant", status: "completed", ...(phase ? { phase } : {}),
    content: [{ type: "output_text", text, annotations: [] }] };
}
function responseEvents(output: Record<string, unknown>[], status = "completed", extra: Record<string, unknown> = {}) {
  return output.flatMap<Record<string, unknown>>((item, output_index) => [
    { type: "response.output_item.added", output_index, item: { ...item,
      ...(item.type === "message" ? { content: [] } : item.type === "reasoning" ? { content: [], summary: [] } : { arguments: "" }) } },
    ...(item.type === "message" ? [{ type: "response.output_text.delta", output_index, content_index: 0,
      item_id: item.id, delta: (item.content as Array<{ text: string }>)[0]!.text }] : []),
    { type: "response.output_item.done", output_index, item },
  ]).concat([{ type: status === "completed" ? "response.completed" : "response.incomplete",
    response: { id: "resp_probe", status, output,
      usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160, input_tokens_details: { cached_tokens: 64 } }, ...extra } }]);
}
function fixture(responses: Array<{ events?: unknown[]; status?: number; text?: string }>) {
  const captured: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown>; signal?: AbortSignal }> = [];
  let cancels = 0;
  const streamRequest: PublicStreamingRequester = async (url, headers, body, signal) => {
    captured.push({ url, headers, body: body as Record<string, unknown>, signal });
    const response = responses.shift();
    assert.ok(response, "unexpected extra request");
    const text = response.text ?? response.events!.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    return { status: response.status ?? 200, statusText: "OK", cancel: () => { cancels++; },
      body: (async function* () {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 23) yield bytes.slice(i, i + 23);
      })() };
  };
  return { streamRequest, captured, get cancels() { return cancels; } };
}
function mimo(f: ReturnType<typeof fixture>, overrides: Partial<ConstructorParameters<typeof PiAgentProvider>[0]> = {}) {
  return new PiAgentProvider({ providerId: "mimo_responses", apiKey: "synthetic-key", baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-flash", modelProfile: profile, streamRequest: f.streamRequest, ...overrides });
}
function chatEvents(delta: Record<string, unknown>, finish_reason: string | null = "stop") {
  return [{ id: "chat_probe", choices: [{ index: 0, delta, finish_reason }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, prompt_tokens_details: { cached_tokens: 64 } } }];
}
function deepseek(f: ReturnType<typeof fixture>, overrides: Partial<ConstructorParameters<typeof PiAgentProvider>[0]> = {}) {
  return mimo(f, { providerId: "opencode_go", baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash",
    sessionId: "host-session", modelProfile: { ...profile, protocol: "openai-completions", maxOutputTokens: 384000,
      reasoning: { levels: ["none", "low", "high", "max"], default: "high" } }, ...overrides });
}

test("factory selects Pi and exposes MiMo text generation for the configured slots", () => {
  for (const provider of ["opencode_go", "mimo_responses"]) {
    assert.ok(createProvider(provider, { apiKey: "synthetic-key" }) instanceof PiAgentProvider);
  }
  assert.ok(createCapabilityProvider("mimo_responses", "text_generation", { apiKey: "synthetic-key" }) instanceof PiAgentProvider);
});

test("per-step effort reaches the wire for native, buffered and streaming calls", async () => {
  const f = fixture(Array.from({ length: 4 }, () => ({ events: responseEvents([message("done")]) })));
  const provider = mimo(f);
  await provider.executeAgentTurn(request({ reasoningEffort: "high" }));
  await provider.chatCompletion([], { reasoningEffort: "low", responseFormat: "text" });
  await provider.chatCompletionStream([], { nativeAgentRequest: request({ reasoningEffort: "none" }),
    responseFormat: "text" }, undefined, () => {});
  await provider.executeAgentTurn(request({ disableThinking: true, reasoningEffort: "high" }));
  assert.deepEqual(f.captured.map(call => (call.body.reasoning as { effort: string }).effort),
    ["high", "low", "none", "high"]);
});

test("effort is mapped to a supported level without downgrading a harder request", async () => {
  const f = fixture(Array.from({ length: 2 }, () => ({ events: responseEvents([message("done")]) })));
  const provider = mimo(f, { modelProfile: { ...profile,
    reasoning: { levels: ["low", "high"], default: "low" } } });
  await provider.executeAgentTurn(request({ reasoningEffort: "medium" }));
  await provider.executeAgentTurn(request({ reasoningEffort: "none" }));
  assert.deepEqual(f.captured.map(call => (call.body.reasoning as { effort: string }).effort), ["high", "low"]);
});

test("explicit effort cannot bypass a gateway's required-tool compatibility constraint", async () => {
  const f = fixture([{ events: chatEvents({ tool_calls: [{ index: 0, id: "required", type: "function",
    function: { name: "lookup", arguments: '{"query":"synthetic"}' } }] }, "tool_calls") }]);
  await deepseek(f).executeAgentTurn(request({ tools: [tool], toolChoice: "required", reasoningEffort: "high" }));
  assert.deepEqual(f.captured[0]!.body.thinking, { type: "disabled" });
});

test("phase-free Responses delivers first text while the terminal response is still pending", async () => {
  const output = [message("hello")];
  const events = responseEvents(output);
  const chunks: string[] = [];
  let releaseTerminal!: () => void;
  let firstDelta!: () => void;
  const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
  const deltaGate = new Promise<void>(resolve => { firstDelta = resolve; });
  const encode = (values: unknown[]) => new TextEncoder().encode(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
  const streamRequest: PublicStreamingRequester = async () => ({
    status: 200, statusText: "OK", cancel() {},
    body: (async function* () {
      yield encode(events.slice(0, -1));
      await terminalGate;
      yield encode(events.slice(-1));
    })(),
  });
  const provider = mimo(fixture([]), { streamRequest, modelProfile: { ...profile, supportsAssistantPhase: false } });
  const pending = provider.chatCompletionStream([{ role: "user", content: "hi" }], { responseFormat: "text" },
    undefined, delta => { chunks.push(delta); firstDelta(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([deltaGate, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("first text was withheld until completion")), 2_000);
    })]);
    assert.equal(chunks.join(""), "hello");
  } finally {
    clearTimeout(timer);
    releaseTerminal();
    await pending;
  }
  assert.equal(chunks.join(""), "hello", "terminal response must not duplicate streamed text");
});

test("MiMo full tool loop preserves reasoning, host observation order and call identity through Pi", async () => {
  const call = { type: "function_call", id: "fc_probe", call_id: "call_probe", name: "lookup", arguments: '{"query":"hello"}', status: "completed" };
  const f = fixture([{ events: responseEvents([reasoning, call]) }, { events: responseEvents([message("done", "final_answer")]) }]);
  const provider = mimo(f);
  const first = await provider.executeAgentTurn(request({ tools: [tool] }));
  assert.deepEqual(first.reasoning, [reasoning]);
  assert.deepEqual(first.toolCalls, [{ id: "call_probe", name: "lookup", arguments: { query: "hello" } }]);
  assert.equal(first.usage?.promptTokens, 120);
  const second = await provider.executeAgentTurn(request({ messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "", reasoning: first.reasoning, toolCalls: first.toolCalls },
    { role: "tool", toolCallId: "call_probe", content: "found" },
    { role: "assistant", content: "previous reply", phase: "final_answer" },
    { role: "system", hostObservation: true, content: "actual host observation" },
  ] }));
  assert.equal(second.content, "done");
  assert.equal(f.captured[0]!.url, "https://api.xiaomimimo.com/v1/responses");
  const body = f.captured[1]!.body;
  const input = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input.map(item => item.type === "message" ? item.role : item.type ?? item.role),
    ["system", "user", "reasoning", "function_call", "function_call_output", "assistant", "system"]);
  assert.deepEqual(input.find(item => item.type === "reasoning"), reasoning);
  assert.equal(body.max_output_tokens, 131072);
  assert.equal(body.temperature, undefined);
  assert.equal(body.store, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(f.cancels, 2);
});

test("DeepSeek Chat uses stable session, strict tool arguments and plaintext reasoning replay", async () => {
  const f = fixture([{ events: chatEvents({ reasoning_content: "synthetic thought", tool_calls: [{ index: 0, id: "call_chat", type: "function",
    function: { name: "lookup", arguments: '{"query":"hello"}' } }] }, "tool_calls") }, { events: chatEvents({ content: "done" }) }]);
  const provider = deepseek(f);
  const first = await provider.executeAgentTurn(request({ tools: [tool] }));
  assert.equal(first.usage?.promptTokens, 120);
  assert.equal(first.usage?.cacheMissTokens, 56);
  assert.ok(first.reasoning?.length);
  await provider.executeAgentTurn(request({ messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "", reasoning: first.reasoning, toolCalls: first.toolCalls },
    { role: "tool", toolCallId: first.toolCalls[0]!.id, content: "found" },
  ] }));
  assert.ok(f.captured.every(call => call.url.endsWith("/chat/completions")));
  assert.ok(f.captured.every(call => call.headers["x-opencode-session"] === "host-session"));
  const body = f.captured[1]!.body;
  assert.equal((body.messages as Array<Record<string, unknown>>).find(item => item.role === "assistant")!.reasoning_content, "synthetic thought");
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, 384000);
});

test("streaming separates private/commentary text, thinking and final answer", async () => {
  const events = responseEvents([reasoning, message("private", "analysis", "msg_private"), message("commentary", "commentary", "msg_comment"), message("final", "final_answer", "msg_final")]);
  events.splice(1, 0, { type: "response.reasoning_text.delta", output_index: 0, delta: "synthetic thought" });
  const f = fixture([{ events }]);
  const deltas: string[] = [], thoughts: string[] = [];
  const result = await mimo(f).chatCompletionStream([{ role: "user", content: "hello" }],
    { responseFormat: "text", onReasoningDelta: delta => thoughts.push(delta) }, undefined, delta => deltas.push(delta));
  assert.equal(result.content, "final");
  assert.equal(deltas.join(""), "final");
  assert.equal(thoughts.join(""), "synthetic thought");
  assert.deepEqual(result.reasoning, [reasoning]);
});

test("terminal-only Responses output backfills complete text and reasoning", async () => {
  const f = fixture([{ events: [responseEvents([reasoning, message("terminal", "final_answer")]).at(-1)] }]);
  const deltas: string[] = [];
  const result = await mimo(f).chatCompletionStream([], { responseFormat: "text" }, undefined, delta => deltas.push(delta));
  assert.equal(result.content, "terminal");
  assert.deepEqual(result.reasoning, [reasoning]);
  assert.equal(deltas.join(""), "terminal");
});

test("Pi's partial JSON repair never authorizes malformed tool calls", async () => {
  for (const api of ["chat", "responses"]) {
    let settled = 0;
    const events = api === "chat" ? chatEvents({ tool_calls: [{ index: 0, id: "bad_call", type: "function",
      function: { name: "lookup", arguments: '{"query":"half' } }] }, "tool_calls")
      : responseEvents([{ type: "function_call", id: "fc_bad", call_id: "bad_call", name: "lookup", arguments: '{"query":"half' }]);
    const f = fixture([{ events }]);
    const provider = api === "chat" ? deepseek(f) : mimo(f);
    await assert.rejects(provider.chatCompletionStream([], { tools: [tool], onToolCallSettled: () => { settled++; } }, undefined, () => {}),
      error => error instanceof AgentOutputError && error.code === "arguments_malformed");
    assert.equal(settled, 0);
  }
});

test("only MiMo decodes JSON-encoded union values after complete wire validation", async () => {
  const declaration = { name: "nullable_probe", description: "Synthetic nullable values", parameters: {
    type: "object", properties: {
      revision: { anyOf: [{ type: "integer" }, { type: "null" }] },
      when: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      text: { anyOf: [{ type: "string" }, { type: "null" }] },
    }, required: ["revision", "when", "text"], additionalProperties: false,
  } };
  const raw = { revision: "1", when: "null", text: "null" };
  for (const providerId of ["mimo_responses", "opencode_go"] as const) {
    const f = fixture([{ events: responseEvents([{ type: "function_call", id: "fc_union", call_id: "union_call",
      name: declaration.name, arguments: JSON.stringify(raw) }]) }]);
    const result = await mimo(f, { providerId, ...(providerId === "opencode_go"
      ? { baseUrl: "https://opencode.ai/inference/go/v1" } : {}) }).executeAgentTurn(request({ tools: [declaration] }));
    assert.deepEqual(result.toolCalls[0]?.arguments,
      providerId === "mimo_responses" ? { revision: 1, when: null, text: "null" } : raw);
    assert.deepEqual((f.captured[0]!.body.tools as Array<{ parameters: unknown }>)[0]?.parameters,
      declaration.parameters, "the provider codec must not change schema authority");
  }
});

test("required tools: MiMo preserves auto results for host verification; DeepSeek required disables thinking", async () => {
  const f = fixture([{ events: responseEvents([message("no tool", "final_answer")]) }]);
  const result = await mimo(f).executeAgentTurn(request({ tools: [tool], toolChoice: "required" }));
  assert.equal(result.content, "no tool"); assert.deepEqual(result.toolCalls, []);
  assert.equal(f.captured[0]!.body.tool_choice, "auto");
  const c = fixture([{ events: chatEvents({ tool_calls: [{ index: 0, id: "call_req", type: "function",
    function: { name: "lookup", arguments: '{"query":"required"}' } }] }, "tool_calls") }]);
  await deepseek(c).executeAgentTurn(request({ tools: [tool], toolChoice: "required" }));
  assert.deepEqual(c.captured[0]!.body.thinking, { type: "disabled" });
  assert.equal(c.captured[0]!.body.tool_choice, "required");
  assert.equal(c.captured[0]!.body.temperature, 0.2);
});

test("HTTP errors retain privacy-safe status/code and cancel the socket", async () => {
  const f = fixture([{ status: 400, text: JSON.stringify({ error: { type: "invalid_request_error", message: "secret-prompt" } }) }]);
  await assert.rejects(mimo(f).executeAgentTurn(request()), error => error instanceof ProviderRequestError
    && error.status === 400 && error.providerCode === "invalid_request_error" && !error.message.includes("secret-prompt"));
  assert.equal(f.cancels, 1);
});

test("EOF without terminal/finish_reason fails; output truncation is non-retryable", async () => {
  const f = fixture([{ events: responseEvents([message("partial", "final_answer")]).slice(0, -1) }]);
  await assert.rejects(mimo(f).executeAgentTurn(request()), error => error instanceof ProviderStreamError && error.code === "stream_incomplete");
  const c = fixture([{ events: chatEvents({ content: "partial" }, null) }]);
  await assert.rejects(deepseek(c).executeAgentTurn(request()), error => error instanceof ProviderStreamError && error.code === "stream_incomplete");
  const t = fixture([{ events: responseEvents([], "incomplete", { incomplete_details: { reason: "max_output_tokens" } }) }]);
  await assert.rejects(mimo(t).executeAgentTurn(request()), error => error instanceof AgentOutputError && error.code === "output_truncated");
});

test("disabled output caps, model override, no-thinking sampling and remote images survive Pi conversion", async () => {
  const f = fixture([{ events: responseEvents([message('{"ok":true}', "final_answer")]) }]);
  await mimo(f, { platformOptions: { disableMaxTokens: true } }).chatCompletion([{ role: "user", content: [
    { type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.com/synthetic.png", detail: "high" } },
  ] }], { model: "mimo-synthetic-override", disableThinking: true, temperature: 0.4 });
  const body = f.captured[0]!.body;
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.model, "mimo-synthetic-override");
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.equal(body.temperature, 0.4);
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.ok(JSON.stringify(body.input).includes('"image_url":"https://example.com/synthetic.png"'));
  assert.ok(!JSON.stringify(body).includes("__ASTELLA_IMAGE_"));
});

test("already cancelled calls never contact the transport", async () => {
  const f = fixture([]);
  const controller = new AbortController(); controller.abort(new Error("cancel-probe"));
  await assert.rejects(mimo(f).executeAgentTurn(request(), controller.signal), /cancel-probe/);
  assert.equal(f.captured.length, 0);
});

test("streamed tool notifications preserve host IDs and exact arguments", async () => {
  const call = { type: "function_call", id: "fc_notify", call_id: "call_notify", name: "lookup", arguments: '{ "query": "hello" }' };
  const f = fixture([{ events: responseEvents([call]) }]);
  const started: string[] = [], settled: Array<{ id: string; argsText: string }> = [];
  const result = await mimo(f).chatCompletionStream([], { tools: [tool],
    onToolCallStarted: item => started.push(item.id), onToolCallSettled: item => settled.push(item),
  }, undefined, () => assert.fail("tool-only turn must not publish text"));
  assert.deepEqual(started, ["call_notify"]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.id, result.toolCalls![0]!.id);
  assert.equal(settled[0]!.argsText, call.arguments);
});

test("image markers remain unique across mixed messages and leave ordinary text untouched", async () => {
  const f = fixture([{ events: responseEvents([message("done", "final_answer")]) }]);
  await mimo(f).chatCompletion([
    { role: "user", content: [{ type: "text", text: "__ASTELLA_IMAGE_0__" },
      { type: "image_url", image_url: { url: "https://example.com/one.png" } }] },
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/two.png" } }] },
  ], { responseFormat: "text" });
  const input = JSON.stringify(f.captured[0]!.body.input);
  assert.ok(input.includes("https://example.com/one.png"));
  assert.ok(input.includes("https://example.com/two.png"));
  assert.ok(input.includes('"text":"__ASTELLA_IMAGE_0__"'));
});

test("a response can backfill plaintext reasoning in its terminal snapshot", async () => {
  const events = responseEvents([reasoning, message("done", "final_answer")]);
  const done = events.find(event => event.type === "response.output_item.done" && (event.item as Record<string, unknown>).type === "reasoning")!;
  done.item = { ...reasoning, content: undefined };
  const f = fixture([{ events }]);
  const result = await mimo(f).executeAgentTurn(request());
  assert.deepEqual(result.reasoning, [reasoning]);
});

test("wire mismatch and successful-but-empty responses are rejected", async () => {
  const events = responseEvents([message("stream text", "final_answer")]);
  (events.at(-1)!.response as Record<string, unknown>).output = [message("different terminal", "final_answer")];
  const f = fixture([{ events }, { events: responseEvents([]) }]);
  await assert.rejects(mimo(f).executeAgentTurn(request()), error => error instanceof ProviderStreamError && error.code === "stream_content_mismatch");
  await assert.rejects(mimo(f).executeAgentTurn(request()), error => error instanceof ProviderStreamError && error.code === "stream_empty");
});

test("a model without an off level uses its declared lowest effort", async () => {
  const f = fixture([{ events: responseEvents([message("done", "final_answer")]) }]);
  await mimo(f, { providerId: "opencode_go", baseUrl: "https://opencode.ai/zen/go/v1", model: "muse-spark-1.3-contributor",
    modelProfile: { ...profile, reasoning: { levels: ["minimal", "high"], default: "high" } } }).chatCompletion([], {
    disableThinking: true, responseFormat: "text", temperature: 0.2,
  });
  assert.equal((f.captured[0]!.body.reasoning as Record<string, unknown>).effort, "minimal");
  assert.equal(f.captured[0]!.body.temperature, undefined);
});

test("in-flight cancellation closes the underlying socket and preserves caller reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel-in-flight");
  let cancelled = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const streamRequest: PublicStreamingRequester = async () => ({ status: 200, statusText: "OK",
    cancel: () => { cancelled++; release(); }, body: (async function* () {
      yield new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp_cancel"}}\n\n');
      started(); await wait;
    })() });
  const provider = mimo(fixture([]), { streamRequest });
  const result = provider.executeAgentTurn(request(), controller.signal);
  await ready;
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  assert.equal(cancelled, 1);
});

test("cross-protocol fallback converts a Chat thinking field into a valid Responses item", async () => {
  const c = fixture([{ events: chatEvents({ reasoning: "synthetic cross-provider thought", content: "previous answer" }) }]);
  const first = await deepseek(c).executeAgentTurn(request());
  const f = fixture([{ events: responseEvents([message("done", "final_answer")]) }]);
  await mimo(f).executeAgentTurn(request({ messages: [
    { role: "user", content: "hello" }, { role: "assistant", content: first.content ?? "", reasoning: first.reasoning },
    { role: "user", content: "continue" },
  ] }));
  const item = (f.captured[0]!.body.input as Array<Record<string, unknown>>).find(item => item.type === "reasoning");
  assert.deepEqual(item, { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "synthetic cross-provider thought" }] });
});
