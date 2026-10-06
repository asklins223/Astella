import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTurnRequest, ChatMessage, ChatOptions } from "@ailearn/shared";
import {
  measureAgentTurnRequest, measureChatRequest, estimateTextTokens,
  IMAGE_TOKEN_FLOOR, REASONING_HANDLE_TOKEN_FLOOR,
} from "../measure-request.ts";

const request_ = (systemPrompt: string, userText: string): AgentTurnRequest =>
  request({ systemPrompt, messages: [{ role: "user", content: userText }] });

const request = (over: Partial<AgentTurnRequest> = {}): AgentTurnRequest => ({
  role: "companion_agent",
  systemPrompt: "你是一个学习书房里的伴星。",
  messages: [{ role: "user", content: "帮我看看这段公式" }],
  tools: [],
  maxTokens: 2_000,
  temperature: 0.4,
  ...over,
});

test("空内容的估算口径为 0，不给零内容加地板", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.ok(estimateTextTokens("中文") > 0);
  // 中文按 1 token/字符向上取整；英文按 1/3 字符留出向上余量。
  assert.equal(estimateTextTokens("中文"), 2);
  assert.equal(estimateTextTokens("abcdef"), 2);
});

test("system 很短但工具 schema 很大时也能计量到治理压力", async () => {
  const huge = { type: "object", properties: Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`field_${index}`, { type: "string", description: "说明".repeat(10) }]),
  ) };
  const withTools = await measureAgentTurnRequest(request({
    systemPrompt: "短。",
    tools: [{ name: "companion_search_notes", description: "检索笔记", parameters: huge }],
  }));
  const withoutTools = await measureAgentTurnRequest(request({ systemPrompt: "短。" }));
  assert.ok(withTools.inputTokens > withoutTools.inputTokens * 10);
  assert.ok(withTools.parts.tools > withoutTools.parts.tools);
});

test("完整请求覆盖历史、工具结果与工具调用参数，不只测 system", async () => {
  const measured = await measureAgentTurnRequest(request({
    messages: [
      { role: "user", content: "问题" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_note", arguments: { noteId: "n1" } }] },
      { role: "tool", content: "笔记正文".repeat(50), toolCallId: "call-1" },
    ],
  }));
  assert.ok(measured.parts.messages > 0);
  assert.ok(measured.parts.system > 0);
});

test("多模态未知成本不记零：按保守地板计价并写进 unmeasured", async () => {
  const measured = await measureAgentTurnRequest(request({
    messages: [{ role: "user", content: [
      { type: "text", text: "这张图里写了什么？" },
      { type: "image_url", image_url: { url: "https://example.test/a.png" } },
    ] }],
  }));
  assert.ok(measured.parts.multimodal >= IMAGE_TOKEN_FLOOR);
  assert.ok(measured.unmeasured.includes("image"));
  const noImage = await measureAgentTurnRequest(request({
    messages: [{ role: "user", content: "这张图里写了什么？" }],
  }));
  assert.ok(measured.inputTokens > noImage.inputTokens);
});

test("不透明 reasoning 句柄按地板计价而不是零", async () => {
  const measured = await measureAgentTurnRequest(request({
    messages: [{ role: "assistant", content: "好", reasoning: [{ id: "rs_1", encrypted_content: "opaque" }] }],
  }));
  assert.ok(measured.parts.multimodal >= REASONING_HANDLE_TOKEN_FLOOR);
  assert.ok(measured.unmeasured.includes("reasoning_handle"));
});

test("注入 tokenizer 后走精确口径，且不给估算误差余量", async () => {
  const measured = await measureAgentTurnRequest(request({ systemPrompt: "你是一个学习书房里的伴星。" }), {
    countTokens: (text) => text.length,
  });
  assert.equal(measured.method, "tokenizer");
  assert.equal(measured.errorMarginTokens, 0);
  const heuristic = await measureAgentTurnRequest(request({ systemPrompt: "你是一个学习书房里的伴星。" }));
  assert.equal(heuristic.method, "heuristic");
  assert.ok(heuristic.errorMarginTokens >= 256);
  assert.ok(heuristic.inputTokens > measured.inputTokens);
});

test("tokenizer 中途失败退回保守估算，不返回半个精确结果", async () => {
  let calls = 0;
  const measured = await measureAgentTurnRequest(request({
    systemPrompt: "你是一个学习书房里的伴星。",
    messages: [{ role: "user", content: "帮我看看这段公式" }],
  }), {
    countTokens: (text) => {
      calls += 1;
      return calls === 1 ? text.length : null;
    },
  });
  assert.equal(measured.method, "heuristic");
});

test("provider 自带计数能力优先于 tokenizer", async () => {
  const measured = await measureAgentTurnRequest(request(), {
    providerCount: () => 12_345,
    countTokens: () => 1,
  });
  assert.equal(measured.method, "provider_count");
  assert.equal(measured.inputTokens, 12_345);
  assert.equal(measured.errorMarginTokens, 0);
});

test("usage 锚点只在匹配时生效；不匹配时退回保守估算", async () => {
  const matched = await measureAgentTurnRequest(request(), {
    anchor: () => ({ inputTokens: 100_000, matches: true }),
  });
  assert.equal(matched.method, "usage_anchor");
  assert.ok(matched.inputTokens > 100_000);
  const mismatched = await measureAgentTurnRequest(request(), {
    anchor: () => ({ inputTokens: 100_000, matches: false }),
  });
  assert.equal(mismatched.method, "heuristic");
  assert.ok(mismatched.inputTokens < 100_000);
});

test("chat 路径同样计量 options.tools（工具定义是真实序列化内容）", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "帮我做个卡片" }];
  const options: ChatOptions = {
    tools: [{ name: "read_note", description: "读笔记".repeat(200), parameters: {} }],
    maxTokens: 4_096,
  };
  const withTools = await measureChatRequest(messages, options);
  const withoutTools = await measureChatRequest(messages, {});
  assert.ok(withTools.parts.tools > withoutTools.parts.tools);
  assert.ok(withTools.inputTokens > withoutTools.inputTokens);
  assert.equal(withoutTools.parts.system, 0);
});

test("chat 路径把 system 消息与普通消息分开归类", async () => {
  const measured = await measureChatRequest([
    { role: "system", content: "协议与身份" },
    { role: "user", content: "你好" },
  ]);
  assert.ok(measured.parts.system > 0);
  assert.ok(measured.parts.messages > 0);
});

// ─── 44 §4.2／§8.1：缓存命中仍占窗口 ─────────────────────────────────────

test("44 §4.2：缓存命中的 token 仍占窗口，不因命中而被扣掉", async () => {
  // 口径上：**缓存命中只影响计费，不影响占用**。把命中部分从预算里减掉，会让
  // 一个「几乎全是缓存前缀」的请求被判定成没压力，而它其实已经贴着窗口了。
  //
  // 计数端口刻意**没有** cacheHitTokens 这个入参——不给字段，就没人能顺手减掉它。
  const request = request_("历史很长", "问题也在这里");
  const measured = await measureAgentTurnRequest(request, {
    anchor: () => ({ inputTokens: 90_000, matches: true }),
  });
  // 锚点给的是**完整前缀**的 token 数；新增内容另计，总量只会更大。
  assert.equal(measured.method, "usage_anchor");
  assert.ok(measured.inputTokens > 90_000, "缓存前缀仍计入窗口，只在其上再加新增内容");
  assert.equal(measured.errorMarginTokens > 0, true);
});

test("44 §4.2：已包含的 assistant 输出不重复计算", async () => {
  const reply = "这是一段上一次已经完整产出过的回答。";
  const request = request_(reply, "请继续");
  const measured = await measureAgentTurnRequest(request, {
    anchor: () => ({ inputTokens: 0, matches: true }),
  });
  // 锚点说前缀是 0 —— 新增内容就是全部；重复计入会翻倍。
  const single = await measureAgentTurnRequest(request);
  assert.equal(measured.inputTokens, single.inputTokens);
});
