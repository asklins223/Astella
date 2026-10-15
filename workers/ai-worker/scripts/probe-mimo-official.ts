/**
 * MiMo Chat Completions 方言探针（2026-10-15）。
 *
 * Agent 已改走官方 Responses API；本脚本只验证仍保留的 Chat Completions 路径
 * （例如 MiMo ASR 使用的端点）中的思考开关与 reasoning_content 续轮约定。
 *
 * 官方文档（小米 MiMo）两条与我们现有实现直接冲突：
 *
 *  A. 字段是 `thinking: {type: "enabled"|"disabled"}`；Chat 平台实例显式声明
 *     `thinkingParam: "thinking_type"`，避免把 Responses 的 `reasoning.effort`
 *     误发到 Chat Completions 请求。
 *     判据用文档给的可观测信号：`usage.completion_tokens_details.reasoning_tokens`。
 *
 *  B. "多轮会话中开启深度思考、历史存在工具调用时，回传的 assistant 若包含
 *     tool_calls，必须完整回传 reasoning_content，否则 400。"
 *     这部分只对 Chat Completions 客户端有意义；MiMo Agent 的真实调用链会回放
 *     Responses `reasoning` items，不依赖这个字段。
 *
 *   docker cp scripts/probe-mimo-official.ts astella-dev-worker-1:/app/scripts/
 *   docker exec astella-dev-worker-1 ./node_modules/.bin/tsx scripts/probe-mimo-official.ts
 */
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

const cfg = JSON.parse(readFileSync("/app/config/ai-platforms.json", "utf8")) as {
  platforms: Record<string, { baseUrl: string; apiKey: string; models: Record<string, unknown> }>;
};
const mimo = cfg.platforms.mimo!;
const key = (mimo.apiKey.startsWith("${") ? process.env.MIMO_API_KEY : mimo.apiKey) ?? "";
const URL_ = `${mimo.baseUrl.replace(/\/+$/, "")}/chat/completions`;
const MODEL = "mimo-v2.6-flash";

async function call(body: Json, signal?: AbortSignal): Promise<{ status: number; body: Json }> {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal,
  });
  return { status: res.status, body: await res.json().catch(() => ({}) as Json) };
}
const reasoningTokens = (b: Json): number =>
  ((b.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)
    ?.completion_tokens_details?.reasoning_tokens) ?? -1;

// ── A. 思考开关字段：三个变体，看 reasoning_tokens ─────────────────────
// 用需要推理的题，让"思考开着"有可观测的 token；"只回复好"可能本就不思考。
const MATH = "987 * 432 等于多少？请逐步推理后给出结果。";
async function thinkingProbe(label: string, extra: Json): Promise<void> {
  try {
    const { status, body } = await call({
      model: MODEL, max_completion_tokens: 1500, messages: [{ role: "user", content: MATH }], ...extra,
    });
    console.log(`[A ${label}] status=${status} reasoning_tokens=${reasoningTokens(body)}`,
      status >= 400 ? JSON.stringify(body).slice(0, 200) : "");
  } catch (err) {
    console.log(`[A ${label}] EXC`, (err as Error).message.slice(0, 120));
  }
}
console.log("=== A. 思考开关字段（reasoning_tokens 越小＝关得越干净） ===");
await thinkingProbe("baseline(不传开关)", {});
await thinkingProbe("reasoning_effort:none(我们现下发)", { reasoning_effort: "none" });
await thinkingProbe("thinking:{type:disabled}(官方文档)", { thinking: { type: "disabled" } });
await thinkingProbe("enable_thinking:false(旧默认)", { enable_thinking: false });

// ── B. reasoning_content 回传：工具循环会不会 400 ─────────────────────
console.log("=== B. 工具循环的 reasoning_content 回传 ===");
const TOOLS = [{
  type: "function",
  function: {
    name: "get_current_weather",
    description: "Get the current weather for a given city",
    parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
  },
}];
async function firstAssistantWithTool(): Promise<Json | null> {
  const { status, body } = await call({
    model: MODEL, messages: [{ role: "user", content: "北京今天天气怎么样？" }],
    tools: TOOLS, thinking: { type: "enabled" },
  });
  if (status >= 400) { console.log(`[B] 取 toolCall 失败 status=${status}`, JSON.stringify(body).slice(0, 200)); return null; }
  const msg = (body.choices as Json[] | undefined)?.[0]?.message as Json | undefined;
  if (!msg) return null;
  console.log("[B] 首发 assistant: reasoning_content 存在 =", JSON.stringify(msg.reasoning_content ?? null).slice(0, 110),
    "| tool_calls =", JSON.stringify((msg.tool_calls as unknown[] | null)?.length ?? null));
  return msg;
}
const first = await firstAssistantWithTool();
if (first?.tool_calls) {
  const toolMsg = { role: "assistant", content: first.content ?? "", tool_calls: first.tool_calls };
  const toolResult = { role: "tool", tool_call_id: (first.tool_calls as Array<{ id: string }>)[0]!.id,
    content: "Sunny 25°C" };
  const base = {
    model: MODEL, tools: TOOLS, thinking: { type: "enabled" },
    messages: [{ role: "user", content: "北京今天天气怎么样？" }],
  };
  // B1：不回传 reasoning_content（我们当前实现的形状）
  try {
    const r = await call({ ...base, messages: [...base.messages, toolMsg, toolResult] });
    console.log(`[B1 不回传 reasoning_content] status=${r.status}`,
      r.status >= 400 ? JSON.stringify(r.body).slice(0, 260) : "OK(没炸)");
  } catch (err) { console.log("[B1] EXC", (err as Error).message.slice(0, 120)); }
  // B2：回传 reasoning_content（文档要求的形状）
  try {
    const r = await call({ ...base, messages: [...base.messages, { ...toolMsg, reasoning_content: first.reasoning_content }, toolResult] });
    console.log(`[B2 回传 reasoning_content] status=${r.status}`,
      r.status >= 400 ? JSON.stringify(r.body).slice(0, 260) : "OK");
  } catch (err) { console.log("[B2] EXC", (err as Error).message.slice(0, 120)); }
  // B3：只带 tool_calls 的 assistant、后面没有 tool 结果（历史含工具调用的形状）
  try {
    const r = await call({ ...base, messages: [{ role: "user", content: "那上海呢？" }, toolMsg] });
    console.log(`[B3 assistant带tool_calls无reasoning] status=${r.status}`,
      r.status >= 400 ? JSON.stringify(r.body).slice(0, 260) : "OK(没炸)");
  } catch (err) { console.log("[B3] EXC", (err as Error).message.slice(0, 120)); }
} else {
  console.log("[B] 首发没拿到 tool_calls，无法测回传（跳过 B1-B3）");
}
