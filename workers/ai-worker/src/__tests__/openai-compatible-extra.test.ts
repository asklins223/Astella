/**
 * OpenAI-compatible provider contract tests.
 *
 * Validation-session prompt/schema tests were removed with the obsolete V1
 * validation worker path. These tests cover the active generic chat and
 * Supervisor Agent transport contracts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@astella/shared/public-json-http";

const messages = [{ role: "user" as const, content: "ping" }];

test("embedding 出网保留长输入的末尾纠正，不静默只取前 1500 字", async () => {
  let sent: Record<string, unknown> = {};
  let observedSignal: AbortSignal | undefined;
  const provider = new OpenAICompatibleProvider({ apiKey: "test-key", baseUrl: "https://api.example.com/v1",
    model: "chat", embeddingModel: "embedding", request: async (_url, _headers, body, signal) => {
      sent = body as Record<string, unknown>; observedSignal = signal;
      return { status: 200, statusText: "OK", body: { data: [{ embedding: [0.1, 0.2] }] } };
    } });
  const text = "旧背景\n".repeat(500) + "末尾纠正：改完的是封面，正文尚未修改。🙂";
  const signal = new AbortController().signal;
  assert.deepEqual(await provider.embed(text, signal), [0.1, 0.2]);
  assert.equal((sent.input as string[])[0]?.length, text.length);
  assert.ok((sent.input as string[])[0] === text, "完整输入必须逐字保留");
  assert.equal(sent.model, "embedding");
  assert.equal(observedSignal, signal);
});

test("embedding 上游拒绝长输入时返回现有降级标记，不改成成功的前缀向量", async () => {
  const sent: Record<string, unknown>[] = [];
  const provider = new OpenAICompatibleProvider({ apiKey: "test-key", baseUrl: "https://api.example.com/v1",
    model: "embedding", request: async (_url, _headers, body) => {
      sent.push(body as Record<string, unknown>);
      return { status: 400, statusText: "Bad Request", body: { error: { code: "input_too_long" } } };
    } });
  const text = "长输入".repeat(2000) + "末尾信息";
  assert.equal(await provider.embed(text), null);
  assert.equal(sent.length, 1);
  assert.equal((sent[0]?.input as string[])[0]?.length, text.length);
  assert.ok((sent[0]?.input as string[])[0] === text, "拒绝前仍应发送完整输入");
});

test("跨模型请求在HTTP出口按目标模型输出上限夹取，不沿用主模型的大预算", async () => {
  const sent: Record<string,unknown>[]=[];
  const provider=new OpenAICompatibleProvider({apiKey:"test-key",baseUrl:"https://api.example.com/v1",
    model:"small-fallback",modelProfile:{contextWindowTokens:32768,maxOutputTokens:8192},
    streamRequest:async (_url,_headers,body)=>{
      sent.push(body as Record<string,unknown>);
      return {status:200,statusText:"OK",cancel:()=>{},body:(async function*(){
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完整答复。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      })()};
    },
    request:async (_url,_headers,body)=>{sent.push(body as Record<string,unknown>);return {status:200,statusText:"OK",
      body:{choices:[{message:{content:"完整答复。"},finish_reason:"stop"}]}};}});
  await provider.chatCompletion(messages,{maxTokens:131072,responseFormat:"text"});
  await provider.executeAgentTurn({role:"companion_agent",systemPrompt:"答复。",messages,tools:[],maxTokens:131072,temperature:0.2});
  await provider.chatCompletionStream(messages,{maxTokens:131072,responseFormat:"text"},undefined,()=>{});
  assert.deepEqual(sent.map(body=>body.max_tokens),[8192,8192,8192]);
});

test("已声明的大输出模型不被固定65536护栏缩小", async () => {
  let sent:Record<string,unknown>={};
  const provider=new OpenAICompatibleProvider({apiKey:"test-key",baseUrl:"https://api.example.com/v1",
    model:"large",modelProfile:{contextWindowTokens:1000000,maxOutputTokens:131072},
    request:async (_url,_headers,body)=>{sent=body as Record<string,unknown>;return {status:200,statusText:"OK",
      body:{choices:[{message:{content:"完整答复。"},finish_reason:"stop"}]}};}});
  await provider.executeAgentTurn({role:"companion_agent",systemPrompt:"答复。",messages,tools:[],maxTokens:131072,temperature:0.2});
  assert.equal(sent.max_tokens,131072);
});

test("按轮关闭思考的参数优先于旧网关额外参数", async () => {
  let sent:Record<string,unknown>={};
  const provider=new OpenAICompatibleProvider({apiKey:"test-key",baseUrl:"https://api.example.com/v1",model:"hybrid",
    modelProfile:{reasoning:{levels:["none","high"],default:"high"}},extraRequestParams:{enable_thinking:true},
    request:async(_url,_headers,body)=>{sent=body as Record<string,unknown>;return {status:200,statusText:"OK",
      body:{choices:[{message:{content:"你好。"},finish_reason:"stop"}]}};}});
  await provider.chatCompletion(messages,{responseFormat:"text",disableThinking:true});
  assert.equal(sent.enable_thinking,false);
});

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

function createProvider(request: PublicJsonRequester = mockRequester({
  status: 200,
  statusText: "OK",
  body: { choices: [{ message: { content: "ok" } }] },
})): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request,
  });
}

test("OpenAICompatibleProvider: generic chat completion returns content and usage", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  }));

  const result = await provider.chatCompletion(messages, { responseFormat: "text" });
  assert.equal(result.content, "hello");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.usage.promptTokens, 10);
  assert.equal(result.usage.completionTokens, 5);
});

test("OpenAICompatibleProvider: HTTP errors expose provider status", async () => {
  const provider = createProvider(mockRequester({
    status: 401,
    statusText: "Unauthorized",
    body: { error: { code: "invalid_api_key", message: "invalid api key" } },
  }));

  await assert.rejects(
    provider.chatCompletion(messages, { responseFormat: "text" }),
    (error: unknown) =>
      error instanceof ProviderRequestError
      && error.status === 401
      && error.providerCode === "invalid_api_key",
  );
});

test("OpenAICompatibleProvider: abort and network errors fail closed", async () => {
  const provider = createProvider(async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(provider.chatCompletion(messages, { responseFormat: "text" }), /network unavailable/);

  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    provider.chatCompletion(messages, { responseFormat: "text" }, controller.signal),
    /user cancelled/,
  );
});

test("OpenAICompatibleProvider: id and prompt version identify the active transport", () => {
  const provider = createProvider();
  assert.equal(provider.id, "openai_compatible");
  assert.equal(provider.promptVersion, "v6-openai-compatible");
  assert.equal(provider.modelId, "gpt-4");
});

const agentTurnRequest = {
  role: "text_extractor",
  systemPrompt: "test system prompt",
  messages: [{ role: "user" as const, content: "分析这段内容" }],
  tools: [{
    name: "record_extraction_decisions",
    description: "记录提取决策",
    parameters: { type: "object", properties: {} },
  }],
};

test("OpenAICompatibleProvider.executeAgentTurn: finish_reason=length is non-retryable", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: {
              name: "record_extraction_decisions",
              arguments: '{"candidates":[{"localId":"c1"},{"localId":',
            },
          }],
        },
        finish_reason: "length",
      }],
    },
  }));

  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (error: unknown) => error instanceof AgentOutputError && error.code === "output_truncated",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: malformed tool arguments are rejected", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: { name: "record_extraction_decisions", arguments: "{invalid json" },
          }],
        },
        finish_reason: "stop",
      }],
    },
  }));

  await assert.rejects(
    provider.executeAgentTurn(agentTurnRequest as never),
    (error: unknown) => error instanceof AgentOutputError && error.code === "arguments_malformed",
  );
});

test("OpenAICompatibleProvider.executeAgentTurn: valid tool calls are returned", async () => {
  const provider = createProvider(mockRequester({
    status: 200,
    statusText: "OK",
    body: {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            function: {
              name: "record_extraction_decisions",
              arguments: '{"bundleIds":["b1"],"candidates":[{"localId":"c1"}]}',
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
  }));

  const result = await provider.executeAgentTurn(agentTurnRequest as never);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "record_extraction_decisions");
  assert.deepEqual(result.toolCalls[0].arguments, {
    bundleIds: ["b1"],
    candidates: [{ localId: "c1" }],
  });
  assert.equal(result.finishReason, "tool_calls");
});

test("OpenAICompatibleProvider.executeAgentTurn: no-tool turn stays natural text (no response_format)", async () => {
  // 根因二（2026-09-19）：无工具轮不再强制 json_object——伴星终答/闲聊要自然文本，
  // 强制 JSON 是 json_envelope_leak 的直接来源；structured_action fallback 由
  // content 的 JSON 解析承担，不依赖 response_format。
  const captured: Record<string, unknown>[] = [];
  const provider = createProvider(async (_url, _headers, body) => {
    captured.push(body as Record<string, unknown>);
    return {
      status: 200,
      statusText: "OK",
      body: { choices: [{ message: { content: "你好呀，今天想学点什么？" }, finish_reason: "stop" }] },
    } as PublicJsonResponse;
  });

  const result = await provider.executeAgentTurn({
    ...agentTurnRequest,
    tools: [],
  } as never);
  assert.equal(result.content, "你好呀，今天想学点什么？");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(captured[0].response_format, undefined);
  assert.equal(captured[0].tools, undefined);
});
