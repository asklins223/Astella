/**
 * Legacy direct OpenCode Responses adapter.
 *
 * 为什么不复用 OpenAICompatibleProvider：
 * OpenCode Go 的 muse-spark-*（含 muse-spark-1.3-contributor，1,048,576 上下文）、
 * grok-4.6、gpt-5.6-luna 只在 `/responses` 提供，走 `/chat/completions` 会稳定
 * 返回 HTTP 500。Responses API 的请求体是 `input` items（含 function_call /
 * function_call_output），响应体是 `output` items + `status`，与 chat/completions
 * 的 messages/choices 契约不同，无法靠改写 endpoint 复用同一实现。
 *
 * Production Agent routing is registered through Pi's protocol adapter in
 * `pi-agent.ts`; this implementation remains for direct diagnostics and
 * compatibility probes. Endpoint constraints (https://opencode.ai/docs/go):
 * - 每个请求必须带 `x-opencode-session`，否则 400 `MissingSessionID`。
 *   本 provider 在构造时生成一个稳定 UUID：一个 provider 实例对应一次
 *   job/会话，满足上游「每个会话一个稳定 session」的路由与 prompt cache 要求。
 * - 客户端必须自报 user agent，不能使用通用 SDK/HTTP 库名。
 * - muse-spark-1.3-contributor 是 reasoning 模型，`reasoning.effort` 只接受
 *   minimal/low/medium/high/xhigh/max（**不接受 none**）。2026-10-06 配置重设计后，
 *   推理档位由**模型档案**声明（`platforms.X.models.<model>.reasoning`）：
 *   `default` 就是每次请求下发的档位；每次调用显式关思考（离线评测）时取该模型
 *   声明档位里"最接近关"的一档（有的模型不接受 none）。各模型支持范围不同
 *   （deepseek 支持 none、gpt-5.6-luna 不支持 minimal），声明即真相。
 */

import { randomUUID } from "node:crypto";
import type {
  AgentTurnRequest,
  AgentTurnResult,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ModelProfile,
  PlatformOptions,
  ProviderCapability,
  ProviderUsage,
  ReasoningEffort,
} from "@astella/shared";
import { resolveOpenAIResponsesUrl } from "@astella/shared/ai-endpoints";
import {
  postJsonToPublicEndpoint,
  postSseToPublicEndpoint,
  type PublicJsonRequester,
  type PublicStreamingRequester,
} from "@astella/shared/public-json-http";
import type { AIProvider } from "../ai-provider.ts";
import { ProviderRequestError, ProviderStreamError } from "../provider-request-error.ts";
import { logger } from "../logger.ts";
import { AgentOutputError } from "../non-retryable-errors.ts";
import { profileFingerprint } from "./profile-fingerprint.ts";
import { modelTemperatureFields } from "./model-sampling.ts";
import { modelOutputTokenLimit } from "./model-output-budget.ts";
import { countModelTextTokens, DEEPSEEK_TOKENIZER_REVISION } from "../model-tokenizers.ts";

/** 客户端自报标识——端点要求非通用 SDK/HTTP 库名。 */
const USER_AGENT = "astella-ai-worker/1.0";

/** muse-spark-1.3-contributor 的上下文窗口（1M）。 */
const OPENCODE_GO_CONTEXT_WINDOW_TOKENS = 1_048_576;

/** muse-spark-1.3-contributor 的最大输出（128K）。 */
const OPENCODE_GO_MAX_OUTPUT_TOKENS = 131_072;

/** R1: Unified abort error helper. */
function abortError(signal: AbortSignal, phase: string): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(`AI request aborted ${phase}`);
}

/**
 * 校验 OpenCode Go baseUrl 并解析出 Responses API 端点。
 *
 * 与 dashscope 工厂同样把端点校验放在 provider 侧：registry 只保留纯数据。
 */
export function resolveOpenCodeGoEndpoint(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`Invalid OpenCode Go baseUrl: ${baseUrl}`);
  }
  if (!/^(?:[a-z0-9-]+\.)*opencode\.ai$/i.test(hostname)) {
    throw new Error("OpenCode Go baseUrl must be an opencode.ai domain");
  }
  return resolveOpenAIResponsesUrl(baseUrl);
}

/** Xiaomi's native OpenAI Responses endpoint. Restrict this provider to the official API host. */
export function resolveMiMoResponsesEndpoint(baseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`Invalid MiMo baseUrl: ${baseUrl}`);
  }
  if (hostname.toLowerCase() !== "api.xiaomimimo.com") {
    throw new Error("MiMo Responses baseUrl must use api.xiaomimimo.com");
  }
  return resolveOpenAIResponsesUrl(baseUrl);
}

// ─── Responses API wire types ────────────────────────────────────────────

type ResponsesImageDetail = "auto" | "low" | "high";

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: ResponsesImageDetail };

type ResponsesInputItem =
  | { role: "user" | "assistant" | "system"; content: string | ResponsesContentPart[]; phase?: "commentary" | "final_answer" }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReasoningReplayItem;

/**
 * 回放的 reasoning item。
 *
 * 字段按上游要求原样保留（**muse-spark 缺 `summary` 会 400
 * `missing required field 'summary'`**）。2026-10-14 起含明文思考内容
 * `content`（`reasoning_text`）：网关在思考模式下要求交回它，只带
 * `encrypted_content` 同样 400（详见 `readResponsesReasoningHandles`）。
 */
type ReasoningReplayItem = { type: "reasoning" } & Record<string, unknown>;

/** Agent turn 消息（AgentTurnRequest.messages 的元素）的输入形态。 */
type AgentTurnMessage = AgentTurnRequest["messages"][number];

function toResponsesContent(
  content: string | AgentTurnMessage["content"],
): string | ResponsesContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part): ResponsesContentPart => part.type === "text"
    ? { type: "input_text", text: part.text }
    : {
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      });
}

/** ChatMessage（chatCompletion 输入）→ Responses input items。 */
function buildChatInput(messages: ChatMessage[]): {
  instructions: string | null;
  input: ResponsesInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") {
        systemParts.push(message.content);
      } else {
        systemParts.push(
          message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        );
      }
      continue;
    }
    input.push({ role: message.role, content: toResponsesContent(message.content),
      ...(message.role === "assistant" && message.phase ? { phase: message.phase } : {}) });
  }
  const instructions = systemParts.filter((part) => part.trim()).join("\n\n");
  return { instructions: instructions || null, input };
}

/**
 * input 是否以 assistant 收尾——即"没有新的用户回合，模型要续写她自己上一条"。
 *
 * 只跳过尾部的 system item（主动参与轮的宿主观察压在历史之后，见
 * `companion-agent-runtime` 的 initiativeObservation）；工具回执（function_call_output）
 * 等无 role 的 item 一旦出现在尾部就不是续写形状，直接判否。
 *
 * 这个形状本身不是错误——错的是**在思考模式下带着工具**走进它。
 * 判据与完整实验矩阵见 `continuationAssistantsCarryPlaintext`。
 */
export function endsWithAssistantTurn(input: readonly ResponsesInputItem[]): boolean {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const role = (input[index] as { role?: string }).role;
    if (role === "system") continue;
    return role === "assistant";
  }
  return false;
}

/**
 * 末条 assistant 是否带着**明文** `reasoning_text`——网关认的就是这句话本身。
 *
 * 2026-10-14 实测（真网关，`scripts/probe-plaintext-reasoning.ts`）：
 * 同一个"思考开 + 带工具 + 以 assistant 收尾"的形状，三发对照——
 *
 *   带 `content[].reasoning_text` 明文 → 过
 *   只带 `encrypted_content`          → 400
 *   完全不带 reasoning                → 400
 *
 * 触发条件也不是"以 assistant 收尾"本身。以下形状在思考开 + 带工具下都能过：
 *  - 以 user 收尾；
 *  - 以 tool 回执收尾（工具循环续跑，encrypted-only 句柄就够）；
 *  - 末条 assistant **正文为空**；
 *  - assistant 后面跟着**别的用户消息**（它不是被续写的那条）。
 * 网关只在"要模型接着写一段正文"时才要求交回 `reasoning_text`；尾部追加
 * system 观察救不了它——网关只看 user/assistant/工具项，不看 system。
 *
 * 而且**不是只有末条**要带（2026-10-14 在真实失败快照上逐条变异，脚本
 * `probe-mutate-snapshot.ts`）：`…user assistant assistant user assistant assistant
 * assistant[rs]` 这种"末尾三条连发、只有最后一条带"是 400；去掉中间两条缺的、
 * 或给每条都挂上、或只留最后一条，三种改法都过。所以判据是**逐条**的：
 * 凡是处在"纯文本续写位"上的 assistant，每一条都得带明文。
 *
 * 所以判断"要不要关思考"得看两件事：形状对不对，**和**该带的明文带没带。
 * 0435 把明文随消息落库之后，主动参与轮通常带得回来；带不回来时（历史早于
 * 0435、非思考模型、provider 没返回 reasoning）才降到关思考。
 *
 * 工具循环续跑（`loadContinuation`）不受这条约束：那条链的 assistant 带 toolCalls、
 * 后面接回执，`companion_agent_tool_calls.reasoning_handles` 现存 243 行
 * encrypted-only 就够用（实测 `probe-reasoning-passback-v4.ts` 的 E 发）。
 */
export function continuationAssistantsCarryPlaintext(input: readonly ResponsesInputItem[]): boolean {
  const items = input as readonly { role?: string; type?: string; content?: unknown }[];
  /** 这个 assistant item 前面紧挨着的 reasoning 有没有明文。 */
  const assistantHasPlaintext = (index: number): boolean => {
    for (let back = index - 1; back >= 0; back -= 1) {
      const prior = items[back]!;
      // buildAgentTurnInput 把 reasoning item 排在它所归属的 assistant message 之前
      // （顺序必须与模型产出一致，见 buildAgentTurnInput）。
      if (prior.type === "reasoning") return reasoningItemHasPlaintext(prior.content);
      // 跨到了另一条消息上：这条 assistant 没有自己的 reasoning。
      if (prior.role !== undefined) return false;
    }
    return false;
  };
  /** 这条 assistant 之后到结尾，是不是"纯文本续写位"：没有 user，也没有工具项。 */
  const isTextContinuationSlot = (index: number): boolean => {
    for (let next = index + 1; next < items.length; next += 1) {
      const after = items[next]!;
      // 尾部的宿主观察（system）不改变判定，网关也不看它。
      if (after.role === "system") continue;
      if (after.role === "user") return false;
      if (after.type === "function_call" || after.type === "function_call_output") return false;
      // 另一条 assistant（连发）：它自己单独判，这里继续往后看。
    }
    return true;
  };
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.role !== "assistant") continue;
    // 正文为空的 assistant 收尾实测能过网关，不在这个约束里。
    const content = items[index]!.content;
    const text = typeof content === "string" ? content : "";
    if (text.trim().length === 0) continue;
    if (!isTextContinuationSlot(index)) continue;
    if (!assistantHasPlaintext(index)) return false;
  }
  return true;
}

/** reasoning item 的 `content` 里是否真有一段 `reasoning_text` 正文。 */
function reasoningItemHasPlaintext(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(part =>
    (part as { type?: string; text?: unknown }).type === "reasoning_text"
    && typeof (part as { text?: unknown }).text === "string"
    && (part as { text: string }).text.trim().length > 0);
}

/**
 * Agent turn 历史消息 → Responses input items。
 *
 * 映射规则（与 chat/completions 的 tool_calls/tool_call_id 一一对应）：
 * - assistant + reasoning 句柄 → `reasoning` items
 * - assistant + toolCalls → `function_call` items（Responses 无 assistant.tool_calls）
 * - tool + toolCallId      → `function_call_output` item
 * - tool 缺 toolCallId     → 按 user 消息回放（schema 中该字段可选，避免静默丢结果）
 *
 * **顺序必须与模型的产出顺序一致：reasoning → message → function_call。**
 * Responses API 按 items 顺序重建上游请求；把 message 排在 reasoning 之前会让
 * deepseek 思考模式直接 400「reasoning_text must be passed back」（实测：
 * 忠实顺序通过、message 前置失败），与是否携带明文 reasoning 无关。
 */
function buildAgentTurnInput(
  systemPrompt: string,
  messages: AgentTurnMessage[],
): { instructions: string | null; input: ResponsesInputItem[] } {
  const input: ResponsesInputItem[] = [];
  const injectedSystem: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.hostObservation) {
        // Preserve the actual host event after history. It is neither new user
        // speech nor a fabricated model function call / reasoning handle.
        input.push({ role: "system", content: toResponsesContent(message.content) });
        continue;
      }
      // 普通策略合并到 instructions（与 buildChatInput 同一处理）。
      // 按出现顺序接在宿主政策之后：步中注入的内部核对指令若在这里被丢掉，
      // 她就只收到重附的用户回合，不知道那句是要纠正上一段。
      injectedSystem.push(typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      continue;
    }
    if (message.role === "tool") {
      const output = typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (message.toolCallId) {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output });
      } else {
        input.push({ role: "user", content: output });
      }
      continue;
    }
    for (const handle of message.reasoning ?? []) {
      input.push({ type: "reasoning", ...handle } as ReasoningReplayItem);
    }
    // 空 content 的 assistant 消息只用于承载 toolCalls：Responses 的 input item
    // 要求 content 非空，因此只在其确实携带文本时才回放该条消息。
    const hasContent = typeof message.content === "string"
      ? message.content.trim().length > 0
      : message.content.length > 0;
    if (hasContent) {
      input.push({ role: message.role, content: toResponsesContent(message.content),
        ...(message.role === "assistant" && message.phase ? { phase: message.phase } : {}) });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  const instructions = [systemPrompt, ...injectedSystem]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return { instructions: instructions || null, input };
}

// ─── Responses API 响应解析（导出供单测直接覆盖） ─────────────────────────

interface ResponsesOutputItem {
  type?: unknown;
  phase?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  call_id?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readOutputItems(body: unknown): ResponsesOutputItem[] {
  const output = asRecord(body)?.output;
  return Array.isArray(output) ? output as ResponsesOutputItem[] : [];
}

/** 拼接 output 中所有 message item 的 output_text。 */
export function readResponsesText(body: unknown): string | null {
  const parts: string[] = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = asRecord(rawPart);
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  const text = parts.join("");
  return text.trim() ? text : null;
}

/** No-tool completion publishes the final answer, not intermediate commentary. */
export function readResponsesFinalText(body: unknown): string | null {
  const messages = readOutputItems(body).filter(item => item.type === "message");
  const finals = messages.filter(item => isFinalAnswerPhase(item.phase));
  // Explicit non-final phases (including analysis and unknown future phases)
  // are never user-visible. Unphased messages remain compatible with legacy
  // gateways that do not return phase metadata.
  return readResponsesText({ output: finals.length ? finals : messages.filter(item => item.phase === undefined) });
}

function responsesPhase(body: unknown, finalOnly = false): "commentary" | "final_answer" | undefined {
  const messages = readOutputItems(body).filter(item => item.type === "message");
  const finals = messages.filter(item => isFinalAnswerPhase(item.phase));
  const selected = finalOnly ? (finals.length ? finals : messages.filter(item => item.phase === undefined)) : messages;
  const phases = new Set(selected.map(item => item.phase));
  const first = [...phases][0];
  if (phases.size !== 1) return undefined;
  if (first === "commentary") return "commentary";
  return isFinalAnswerPhase(first) || first === undefined ? "final_answer" : undefined;
}

function isFinalAnswerPhase(phase: unknown): boolean {
  // OpenCode Go streams have returned both Responses spellings in live runs.
  return phase === "final_answer" || phase === "final";
}

function isPrivateOrUnknownPhase(phase: unknown): boolean {
  return phase !== undefined && phase !== "commentary" && !isFinalAnswerPhase(phase);
}

/**
 * Responses usage → ProviderUsage。
 *
 * Responses 用 input_tokens/output_tokens（而非 chat/completions 的
 * prompt_tokens/completion_tokens），cache 命中在
 * usage.input_tokens_details.cached_tokens。
 */
export function readResponsesUsage(body: unknown): ProviderUsage | null {
  const record = asRecord(body);
  const usage = asRecord(record?.usage);
  if (!usage) return null;
  const asTokenCount = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

  const promptTokens = asTokenCount(usage.input_tokens);
  const completionTokens = asTokenCount(usage.output_tokens);
  const totalTokens = asTokenCount(usage.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;

  const cacheHitTokens = asTokenCount(asRecord(usage.input_tokens_details)?.cached_tokens);
  return {
    totalTokens,
    promptTokens,
    completionTokens,
    requestId: typeof record?.id === "string" ? record.id : null,
    ...(cacheHitTokens !== null ? { cacheHitTokens } : {}),
  };
}

/**
 * 从 output 中提取 reasoning item（供下一轮回放）。
 *
 * 2026-10-14 用户决定：**不再剥离明文思考**。旧版在这里删掉 `content`
 * （`reasoning_text`），理由是"模型内部推理不必落库"。这条约束与网关的思考模式
 * 契约正面冲突——实测（`scripts/probe-plaintext-reasoning.ts`，同一份原文三发）：
 * 带明文过、只带 `encrypted_content` 400、完全不带 400；网关要的就是那句话本身，
 * 剥掉之后就再也凑不回来。主动参与轮的历史天生以她上一条收尾、带工具、开思考，
 * 于是每一轮都撞这堵墙（43 条主动轮里思考档位为开的全灭）。
 *
 * 字段仍须原样保留：muse-spark 缺 `summary` 会 400 `missing required field 'summary'`。
 * 现在 `content` 也一并保留，所以下游（`companion_agent_tool_calls.reasoning_handles`
 * 与 `companion_messages.reasoning`）落库的是完整 item。
 */
export function readResponsesReasoningHandles(body: unknown): Array<Record<string, unknown>> {
  const handles: Array<Record<string, unknown>> = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "reasoning") continue;
    const handle = { ...(item as Record<string, unknown>) };
    if (Object.keys(handle).length > 0) handles.push(handle);
  }
  return handles;
}

interface ParsedResponsesToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsMalformed?: boolean;
}

/**
 * Responses 响应体 → agent turn 结果。
 *
 * 与 chat/completions 路径保持同一套语义（见 json-response.ts
 * parseAgentTurnToolCalls）：
 * - `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`
 *   归一为 finishReason "length"，由调用方升级为不可重试的 AgentOutputError。
 * - function_call.arguments 解析失败标记 argumentsMalformed，绝不静默降级为空对象。
 * - 无定义工具时回退解析 content 里的 structured_action JSON（与 chat/completions 一致）。
 */
export function parseResponsesAgentTurn(
  body: unknown,
  hasTools: boolean,
): {
  content: string | null;
  toolCalls: ParsedResponsesToolCall[];
  finishReason: string;
  requestId: string | null;
} {
  const record = asRecord(body);
  const content = hasTools ? readResponsesText(body) : readResponsesFinalText(body);
  const toolCalls: ParsedResponsesToolCall[] = [];
  for (const item of readOutputItems(body)) {
    if (item.type !== "function_call") continue;
    const rawArguments = item.arguments;
    let args: Record<string, unknown> = {};
    let argumentsMalformed: boolean | undefined;
    const asObject = asRecord(rawArguments);
    if (typeof rawArguments === "string") {
      try {
        const parsed = asRecord(JSON.parse(rawArguments));
        if (parsed) {
          args = parsed;
        } else {
          argumentsMalformed = true;
        }
      } catch {
        argumentsMalformed = true;
      }
    } else if (asObject) {
      args = asObject;
    } else {
      argumentsMalformed = true;
    }
    toolCalls.push({
      id: typeof item.call_id === "string" && item.call_id ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments: args,
      ...(argumentsMalformed ? { argumentsMalformed } : {}),
    });
  }

  if (!hasTools && toolCalls.length === 0 && content) {
    try {
      const parsed = JSON.parse(content) as { toolCalls?: unknown };
      if (Array.isArray(parsed?.toolCalls)) {
        for (const call of parsed.toolCalls as Array<Record<string, unknown>>) {
          // AI P0-6（2026-09-15 审计）：此处此前直接
          // `arguments: (call.arguments ?? {}) as Record<string, unknown>`——字符串
          // 形态的 arguments（被截断或非 JSON）会被当成字符串塞进对象位，且没有
          // argumentsMalformed 标记，于是 provider 的 fail-closed 检查漏掉这条路径
          // （native function_call 路径与 chat/completions 路径都有标记）。
          // 现在与那两处对齐：字符串必须解析，失败即标记 → 上层升级为
          // 不可重试的 arguments_malformed。
          const rawArgs = call.arguments ?? {};
          let args: Record<string, unknown> = {};
          let argumentsMalformed: boolean | undefined;
          if (typeof rawArgs === "string") {
            try {
              const parsedArgs = asRecord(JSON.parse(rawArgs));
              if (parsedArgs) {
                args = parsedArgs;
              } else {
                argumentsMalformed = true;
              }
            } catch {
              argumentsMalformed = true;
            }
          } else {
            args = rawArgs as Record<string, unknown>;
          }
          toolCalls.push({
            id: String(call.id ?? ""),
            name: String(call.name ?? ""),
            arguments: args,
            ...(argumentsMalformed ? { argumentsMalformed } : {}),
          });
        }
      }
    } catch {
      // content 不是有效 JSON，忽略（与 chat/completions 路径一致）
    }
  }

  const status = typeof record?.status === "string" ? record.status : "";
  const incompleteReason = asRecord(record?.incomplete_details)?.reason;
  const finishReason = status === "incomplete" && incompleteReason === "max_output_tokens"
    ? "length"
    : toolCalls.length > 0
      ? "tool_calls"
      : status === "incomplete"
        ? String(incompleteReason ?? "incomplete")
        : status === "completed"
          ? "stop"
          : status || "stop";

  return {
    content,
    toolCalls,
    finishReason,
    requestId: typeof record?.id === "string" ? record.id : null,
  };
}

/** 网关错误体（{"error":{"type","message"}}）→ 隐私安全的错误码。 */
function readOpenCodeGoErrorCode(body: unknown): string | undefined {
  const error = asRecord(asRecord(body)?.error);
  const type = error?.type;
  if (typeof type === "string") return type;
  const code = error?.code ?? asRecord(body)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

/** 网关错误体里的那句话（`error.message`）。code 只到 `invalid_request_error` 这一层， */
/** 具体哪一句非法只能从这里读。 */
function readOpenCodeGoErrorMessage(body: unknown): string | undefined {
  const message = asRecord(asRecord(body)?.error)?.message ?? asRecord(body)?.message;
  if (typeof message !== "string" || !message.trim()) return undefined;
  return message.replace(/\s+/g, " ").slice(0, 400);
}

/**
 * 网关拒绝这一发时，先把**它自己说的理由**留下再抛。
 *
 * 失败入库只剩 `category/name/code`（`provider-request-error.ts` 的注释写了这件事），
 * 而 code 只到错误类型名——2026-10-14 实测 10 条 `provider_http_400` 里，"到底哪句非法"
 * 一条都没留，只能靠人肉重放猜。日志是这一层唯一的完整通道：400 是那种必须能回答
 * 「我请求里哪一行不对」的失败，没有那句话就修不了。
 */
function logOpenCodeRejection(provider: string, status: number, body: unknown): void {
  if (status < 400 || status > 499) return;
  logger.warn({ provider, status, code: readOpenCodeGoErrorCode(body), gateway: readOpenCodeGoErrorMessage(body) },
    "OpenAI Responses request rejected");
}

// ─── Provider ────────────────────────────────────────────────────────────

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  request?: PublicJsonRequester;
  streamRequest?: PublicStreamingRequester;
  /** Explicit conversation identity (OpenCode Go requires it; MiMo ignores it). */
  sessionId?: string;
  platformOptions?: PlatformOptions;
  /** Model capability profile: reasoning/context/output limits are declared here. */
  modelProfile?: ModelProfile;
  /** The wire-compatible Responses gateway served by this implementation. */
  protocol?: "opencode_go" | "mimo_responses";
}

export class OpenCodeGoProvider implements AIProvider {
  readonly id: string;
  readonly chatCompletionStreamToolCalls = true;
  readonly promptVersion: string;
  readonly modelId: string;
  readonly visionModelId: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  /** 稳定会话 ID——端点强制要求（缺失即 400），用于路由与 prompt cache。 */
  private readonly sessionId: string;
  private readonly request: PublicJsonRequester;
  private readonly streamRequest: PublicStreamingRequester;
  private readonly platformOptions: PlatformOptions | undefined;
  /** 模型能力档案（2026-10-06 配置重设计）。 */
  private readonly modelProfile: ModelProfile | undefined;
  /** 模型档案覆盖的最大输出 token（缺省用内置的 131K）。 */
  private readonly maxOutputTokens: number;
  private readonly protocol: "opencode_go" | "mimo_responses";

  constructor(options: OpenAIResponsesProviderOptions) {
    this.protocol = options.protocol ?? "opencode_go";
    this.id = this.protocol;
    this.promptVersion = this.protocol === "mimo_responses" ? "v1-mimo-responses" : "v6-opencode-go";
    this.apiKey = options.apiKey;
    this.modelId = options.model;
    this.visionModelId = options.model;
    this.endpoint = this.protocol === "mimo_responses"
      ? resolveMiMoResponsesEndpoint(options.baseUrl)
      : resolveOpenCodeGoEndpoint(options.baseUrl);
    this.sessionId = options.sessionId ?? randomUUID();
    this.request = options.request ?? postJsonToPublicEndpoint;
    this.streamRequest = options.streamRequest ?? postSseToPublicEndpoint;
    this.platformOptions = options.platformOptions;
    this.modelProfile = options.modelProfile;
    this.maxOutputTokens = options.modelProfile?.maxOutputTokens
      ?? OPENCODE_GO_MAX_OUTPUT_TOKENS;
  }

  /** 档位高低语义顺序（用于给"显式关思考"挑最接近关的一档）。 */
  private static readonly EFFORT_ORDER: ReasoningEffort[] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
  ];

  /**
   * reasoning 档位（模型档案驱动，2026-10-06 配置重设计）。
   *
   * - 档案声明了 `reasoning` → 每次请求下发 `default`；
   * - 每次调用显式关思考（离线评测等）→ 取该模型声明档位里"最接近关"的一档
   *   （不支持 none 的模型落到它自己的最低档）；未声明档位时用网关缺省的 minimal；
   * - 未声明 `reasoning` → 不下发该字段，用网关默认。
   */
  private reasoningField(perCallDisableThinking: boolean, explicitEffort?: string): Record<string, unknown> {
    const reasoning = this.modelProfile?.reasoning;
    // Explicit per-step effort wins, but only when the model declares that level.
    if (explicitEffort && reasoning?.levels.includes(explicitEffort as never)) {
      return { reasoning: { effort: explicitEffort } };
    }
    if (perCallDisableThinking) {
      if (!reasoning) return { reasoning: { effort: "minimal" } };
      const off = OpenCodeGoProvider.EFFORT_ORDER.find((level) => reasoning.levels.includes(level));
      // levels 非空由配置校验保证；防御性兜底给最低档即可。
      return { reasoning: { effort: off ?? "minimal" } };
    }
    if (reasoning) return { reasoning: { effort: reasoning.default } };
    return {};
  }

  private headers(stream: boolean): Record<string, string> {
    if (this.protocol === "mimo_responses") {
      return {
        Accept: stream ? "text/event-stream" : "application/json",
        "Content-Type": "application/json",
        "api-key": this.apiKey,
        ...this.platformOptions?.extraHeaders,
      };
    }
    return {
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": USER_AGENT,
      "x-opencode-session": this.sessionId,
    };
  }

  private nativeToolFields(
    tools: AgentTurnRequest["tools"],
    toolChoice: AgentTurnRequest["toolChoice"],
    reasoning: Record<string, unknown>,
  ): Record<string, unknown> {
    if (tools.length === 0) return {};
    const effort = asRecord(reasoning.reasoning)?.effort;
    // This gateway rejects required tools while thinking is enabled.
    const forcedWithThinkingOn = this.protocol === "opencode_go"
      && toolChoice === "required" && effort !== undefined && effort !== "none";
    return {
      tools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
      // MiMo Responses documents only `auto`; other values are silently removed.
      // We detect a missed required call after parsing and route it through the
      // existing cross-model fallback instead of pretending the requirement held.
      tool_choice: this.protocol === "mimo_responses" || forcedWithThinkingOn ? "auto" : toolChoice ?? "auto",
    };
  }

  private mustFallbackForMissingRequiredTool(
    toolChoice: AgentTurnRequest["toolChoice"] | undefined,
    tools: AgentTurnRequest["tools"],
    reasoning: Record<string, unknown>,
  ): boolean {
    if (toolChoice !== "required" || tools.length === 0) return false;
    if (this.protocol === "mimo_responses") return false;
    const effort = asRecord(reasoning.reasoning)?.effort;
    return this.protocol === "opencode_go" && effort !== undefined && effort !== "none";
  }

  private requiredToolChoiceUnsupportedError(): ProviderRequestError {
    return new ProviderRequestError({
      provider: this.id,
      status: 400,
      providerCode: "MODEL_TOOL_CHOICE_NOT_SUPPORTED",
    });
  }

  /** 2xx 但 status="failed" 的响应体 → 抛错（含隐私安全的错误码）。 */
  private throwIfResponseFailed(body: unknown, model: string): void {
    const record = asRecord(body);
    if (record?.status !== "failed") return;
    const error = asRecord(record.error);
    const detail = typeof error?.message === "string"
      ? `: ${error.message.slice(0, 200)}`
      : "";
    throw new Error(`${this.id} response failed (${model})${detail}`);
  }

  async chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (signal?.aborted) throw abortError(signal, "before request");
    const model = options.model ?? this.modelId;
    const { instructions, input } = buildChatInput(messages);
    const reasoning = this.reasoningField(options.disableThinking ?? false, options.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      input,
      ...modelTemperatureFields(this.modelProfile, options.temperature ?? 0.2, asRecord(reasoning.reasoning)?.effort),
      stream: false,
      ...(instructions ? { instructions } : {}),
      ...(options.responseFormat === "text"
        ? {}
        : { text: { format: { type: "json_object" as const } } }),
      ...reasoning,
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = this.resolveOutputTokenLimit();
    }
    const response = await this.request(this.endpoint, this.headers(false), body, signal);
    if (signal?.aborted) throw abortError(signal, "after response");
    if (response.status < 200 || response.status >= 300) {
      logOpenCodeRejection(this.id, response.status, response.body);
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode: readOpenCodeGoErrorCode(response.body),
      });
    }
    this.throwIfResponseFailed(response.body, model);
    if (asRecord(response.body)?.status === "incomplete") {
      if (asRecord(asRecord(response.body)?.incomplete_details)?.reason === "max_output_tokens")
        throw new AgentOutputError("output_truncated", "chat response exhausted its output limit");
      throw new ProviderStreamError(this.id, "stream_incomplete");
    }
    const content = readResponsesFinalText(response.body);
    if (content === null) {
      throw new Error(`${this.id} returned empty output (${model})`);
    }
    return {
      content,
      usage: readResponsesUsage(response.body)
        ?? { totalTokens: null, promptTokens: null, completionTokens: null, requestId: null },
    };
  }

  /**
   * 真实流式：`stream: true` + Responses SSE。
   * 文本增量为 `response.output_text.delta`（data.delta），
   * `response.completed` 结束；思考增量 `response.reasoning_text.delta` 只在调用方
   * 挂了 `onReasoningDelta` 时透出，它**永远不进** `onDelta` 那条正文通路。
   */
  async chatCompletionStream(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<Awaited<ReturnType<NonNullable<AIProvider["chatCompletionStream"]>>>> {
    if (signal?.aborted) throw abortError(signal, "before request");
    const model = options.model ?? this.modelId;
    const { instructions, input } = options.nativeAgentRequest
      ? buildAgentTurnInput(options.nativeAgentRequest.systemPrompt, options.nativeAgentRequest.messages)
      : buildChatInput(messages);
    const tools = options.nativeAgentRequest?.tools ?? options.tools ?? [];
    const hasTools = tools.length > 0;
    const toolChoice = options.nativeAgentRequest?.toolChoice ?? options.toolChoice;
    // 与 executeAgentTurn 同一条网关契约（见 continuationAssistantsCarryPlaintext）：
    // 带工具 + 以 assistant 收尾 + 思考开，且**没把那条的 reasoning_text 明文带回来**
    // ——网关会 400。流式这条路同样会撞，所以同样降级。
    const continuationGuard = this.protocol === "opencode_go" && hasTools && endsWithAssistantTurn(input)
      && !continuationAssistantsCarryPlaintext(input);
    const requiredToolThinkingOff = this.protocol === "opencode_go" && toolChoice === "required"
      && hasTools && this.modelProfile?.reasoning?.levels.includes("none") === true;
    if (continuationGuard && !(options.disableThinking ?? false)) {
      logger.info({ provider: this.id, model },
        `${this.id} thinking disabled: assistant-terminated tool request without plaintext reasoning_text (gateway demands passback)`);
    }
    const reasoning = this.reasoningField(
      (options.disableThinking ?? false) || continuationGuard || requiredToolThinkingOff,
    );
    const body: Record<string, unknown> = {
      model,
      input,
      ...modelTemperatureFields(this.modelProfile, options.temperature ?? 0.2, asRecord(reasoning.reasoning)?.effort),
      stream: true,
      ...(instructions ? { instructions } : {}),
      ...(options.responseFormat === "text"
        ? {}
        : { text: { format: { type: "json_object" as const } } }),
      ...reasoning,
      ...this.nativeToolFields(tools, toolChoice, reasoning),
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = this.resolveOutputTokenLimit();
    }
    const response = await this.streamRequest(this.endpoint, this.headers(true), body, signal);
    if (signal?.aborted) {
      response.cancel();
      throw abortError(signal, "after response");
    }
    if (response.status < 200 || response.status >= 300) {
      let providerCode: string | undefined;
      let parsedBody: unknown = null;
      try {
        const raw = await readStreamingBodyText(response.body);
        parsedBody = raw ? JSON.parse(raw) : null;
        providerCode = readOpenCodeGoErrorCode(parsedBody);
      } catch {
        // 非 JSON 错误体：保留原始状态码即可
      }
      logOpenCodeRejection(this.id, response.status, parsedBody);
      throw new ProviderRequestError({ provider: this.id, status: response.status, providerCode });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let responseBytes = 0;
    let completed = false;
    let providerError: Error | null = null;
    let finalPhase: "commentary" | "final_answer" | undefined;
    let toolCalls: AgentTurnResult["toolCalls"] = [];
    let reasoningHandles: AgentTurnResult["reasoning"];
    let usage: AgentTurnResult["usage"] = null;
    let providerRequestId: string | null = null;
    const itemPhases = new Map<number, unknown>();
    const pendingTextByIndex = new Map<number, string>();
    const startedCalls = new Set<string>();
    const settledCalls = new Set<string>();
    const publishText = (text: string): void => {
      if (!text) return;
      content += text;
      onDelta(text);
    };
    const observeTool = (item: unknown, index: number, done: boolean) => {
      const call = asRecord(item);
      if (call?.type !== "function_call" || typeof call.call_id !== "string" || typeof call.name !== "string") return;
      if (!startedCalls.has(call.call_id)) {
        startedCalls.add(call.call_id);
        options.onToolCallStarted?.({ index, id: call.call_id, name: call.name });
      }
      // Responses supplies an explicit item completion boundary. Never dispatch
      // arguments.delta fragments, even if one happens to parse as JSON.
      if (!done || settledCalls.has(call.call_id) || typeof call.arguments !== "string") return;
      try {
        const args = JSON.parse(call.arguments);
        if (!args || typeof args !== "object" || Array.isArray(args)) return;
      } catch { return; }
      settledCalls.add(call.call_id);
      options.onToolCallSettled?.({ index, id: call.call_id, name: call.name, argsText: call.arguments });
    };
    let withheldUnknownPhase = false;
    /** 终止事件/断流后的统一收尾：先抛 provider 错误，再拒绝空输出。 */
    const settle = (): void => {
      response.cancel();
      if (providerError) throw providerError;
      if (!completed) throw new ProviderStreamError(this.id, "stream_incomplete");
      if (!content.trim() && toolCalls.length === 0) throw new ProviderStreamError(this.id, "stream_empty");
    };
    const result = () => ({ content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop",
      ...(finalPhase ? { phase: finalPhase } : {}), ...(reasoningHandles?.length ? { reasoning: reasoningHandles } : {}),
      usage, providerRequestId });
    const consumeData = (data: string): boolean => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
        if (typeof parsed.delta === "string" && parsed.delta.length > 0
          && typeof parsed.type === "string" && /(?:output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta$/u.test(parsed.type)) options.onOutputActivity?.();
      } catch {
        return false; // 忽略无法解析的 SSE 行（部分网关会插入空行/注释）
      }
      switch (parsed.type) {
        case "response.output_item.added":
        case "response.output_item.done":
          if (typeof parsed.output_index === "number" && asRecord(parsed.item)?.type === "message") {
            const index = parsed.output_index;
            const phase = asRecord(parsed.item)?.phase;
            itemPhases.set(index, phase);
            if (phase === "commentary" || isPrivateOrUnknownPhase(phase)) {
              // A provider may send text deltas before the message metadata.
              // Discard them once a private/unknown phase arrives.
              pendingTextByIndex.delete(index);
            } else if (isFinalAnswerPhase(phase)) {
              const pending = pendingTextByIndex.get(index);
              if (pending) publishText(pending);
              pendingTextByIndex.delete(index);
            }
          }
          if (typeof parsed.output_index === "number")
            observeTool(parsed.item, parsed.output_index, parsed.type === "response.output_item.done");
          return false;
        case "response.output_text.delta": {
          const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : null;
          const phase = outputIndex === null ? undefined : itemPhases.get(outputIndex);
          if (phase === "commentary" || isPrivateOrUnknownPhase(phase)) return false;
          if (this.modelProfile?.supportsAssistantPhase && !isFinalAnswerPhase(phase)) {
            withheldUnknownPhase = true;
            return false;
          }
          const delta = parsed.delta;
          if (typeof delta === "string" && delta.length > 0) {
            // Models declared phase-free have no private commentary phase;
            // publish immediately so EOF and output truncation retain the
            // visible partial answer. Keep the conservative buffer for
            // phase-capable and unprofiled models.
            if (outputIndex !== null && phase === undefined && this.modelProfile?.supportsAssistantPhase !== false) {
              pendingTextByIndex.set(outputIndex, (pendingTextByIndex.get(outputIndex) ?? "") + delta);
              withheldUnknownPhase = true;
            } else publishText(delta);
          }
          return false;
        }
        case "response.reasoning_text.delta": {
          // 思考增量走**另一条路**：它不是正文，永不进净化/朗读/历史，只让等待有内容看。
          // 不传回调就什么都不做（与这条流以前的行为逐字相同）。
          if (typeof options.onReasoningDelta === "function" && typeof parsed.delta === "string")
            options.onReasoningDelta(parsed.delta);
          return false;
        }
        case "response.completed": {
          const terminal = asRecord(parsed.response);
          if (terminal && Array.isArray(terminal.output)) {
            const output = readOutputItems(terminal);
            const hasFinalAnswer = output.some(item => item.type === "message" && isFinalAnswerPhase(item.phase));
            for (const [index, pending] of pendingTextByIndex) {
              const item = output[index];
              const isVisibleMessage = item?.type === "message" && (
                isFinalAnswerPhase(item.phase) || (item.phase === undefined && !hasFinalAnswer)
              );
              if (isVisibleMessage) publishText(pending);
            }
            pendingTextByIndex.clear();
            const finalText = readResponsesFinalText(terminal);
            // Some gateways deliver text only in the terminal output, or omit
            // its last delta. Reconcile a matching prefix without another model
            // call; a genuinely different emitted prefix still fails closed.
            if (finalText?.startsWith(content)) {
              const suffix = finalText.slice(content.length);
              content = finalText;
              if (suffix) onDelta(suffix);
            }
            // 上游实测（2026-10-13，要求工具的步骤 2/3 复现）：同一条消息在流事件里
            // 标 final_answer、在终态快照里标 commentary（两份文本逐字相同），只是
            // **标签**变了。这时整条请求作废重打没有保护任何人——重打出来的还是同一段
            // 文字。当终态里所有 message 的全文与已下发的正文逐字一致，就接受这版并
            // 保留内容；文本真的不同的情况仍 fail closed。
            const terminalMessageText = readResponsesText(terminal);
            if ((finalText ?? "") !== content
              && !(finalText === null && content.length > 0 && terminalMessageText === content)) {
              providerError = new ProviderStreamError(this.id, "stream_content_mismatch");
            }
            // Commentary and analysis items may coexist with the final answer.
            // Report only the publishable answer phase to downstream clients.
            finalPhase = responsesPhase({ output }, true);
            const parsedTurn = parseResponsesAgentTurn(terminal, hasTools);
            const malformed = parsedTurn.toolCalls.find(call => call.argumentsMalformed);
            if (malformed) providerError = new AgentOutputError("arguments_malformed", "provider stream returned malformed tool arguments");
            toolCalls = parsedTurn.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
            if (this.mustFallbackForMissingRequiredTool(toolChoice, tools, reasoning) && toolCalls.length === 0) {
              providerError = this.requiredToolChoiceUnsupportedError();
            }
            terminal.output.forEach((item, index) => observeTool(item, index, true));
            reasoningHandles = readResponsesReasoningHandles(terminal);
            usage = readResponsesUsage(terminal);
            providerRequestId = parsedTurn.requestId;
          }
          else if (withheldUnknownPhase || hasTools) providerError = new ProviderStreamError(this.id, "stream_incomplete");
          completed = true;
          return true;
        }
        case "response.incomplete": {
          const reason = asRecord(asRecord(parsed.response)?.incomplete_details)?.reason;
          providerError = reason === "max_output_tokens"
            ? new AgentOutputError("output_truncated", "provider stream exhausted its output limit")
            : new ProviderStreamError(this.id, "stream_incomplete");
          return true;
        }
        case "response.failed":
        case "error": {
          providerError = new ProviderStreamError(this.id, "stream_failed");
          return true;
        }
        default:
          return false;
      }
    };
    const abortListener = () => {
      response.cancel();
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      for await (const value of response.body) {
        responseBytes += value.byteLength;
        if (responseBytes > 8 * 1024 * 1024) {
          response.cancel();
          throw new ProviderStreamError(this.id, "stream_too_large");
        }
        buffer += decoder.decode(value, { stream: true });
        // PERF: 用 consumed 游标扫描本 chunk 内完整行，仅在末尾一次性截取未处理尾部，
        // 避免每行都 slice 造成 O(n²) 复制（与 openai-compatible 流式实现一致）。
        let lineEnd: number;
        let consumed = 0;
        while ((lineEnd = buffer.indexOf("\n", consumed)) !== -1) {
          const line = buffer.slice(consumed, lineEnd).replace(/\r$/, "");
          consumed = lineEnd + 1;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          if (consumeData(trimmed.slice(5).trim())) {
            settle();
            return result();
          }
        }
        buffer = buffer.slice(consumed);
      }
      // 部分网关在最后一个事件后不再补换行，或用 [DONE] 直接断流：
      // flush 解码器并解析残留的完整 data 行，而不是丢掉最后一个事件。
      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing.startsWith("data:")) consumeData(trailing.slice(5).trim());
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
    if (signal?.aborted) throw abortError(signal, "after stream");
    // Text deltas are not evidence of completion. The delivery layer retains
    // any already-visible prefix as a failed partial reply, never a success.
    settle();
    return result();
  }

  /**
   * Agent turn（native tools）。
   *
   * Responses API 用 `tools[].{type:"function",name,parameters}`（扁平，无
   * `function` 包装层）；无工具轮保持自然文本（不写 text.format，见下方注释）。
   * 一次 attempt 最多一次 provider 请求。
   */
  async executeAgentTurn(
    request: AgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    if (signal?.aborted) throw abortError(signal, "before executeAgentTurn");
    const model = request.model ?? this.modelId;
    const { instructions, input } = buildAgentTurnInput(request.systemPrompt, request.messages);
    const hasTools = request.tools.length > 0;
    const requiredToolThinkingOff = this.protocol === "opencode_go" && request.toolChoice === "required"
      && hasTools && this.modelProfile?.reasoning?.levels.includes("none") === true;
    // OpenCode Go 网关契约（2026-10-14 实测，见 continuationAssistantsCarryPlaintext）：带工具 + 以
    // assistant 收尾 + 思考开，且没把那条的 reasoning_text 明文带回来 = 400。
    // 主动参与轮天生是这个形状；0435 起明文随消息落库、正常能带回来，带不回来时
    // （历史早于 0435、provider 没返回 reasoning）才降到关思考，不让整轮死掉。
    // 无工具、以用户收尾、或正文为空的 assistant 收尾都不受影响。
    const continuationGuard = this.protocol === "opencode_go" && hasTools && endsWithAssistantTurn(input)
      && !continuationAssistantsCarryPlaintext(input);
    if (continuationGuard && !(request.disableThinking ?? false)) {
      logger.info({ provider: this.id, model },
        `${this.id} thinking disabled: assistant-terminated tool request without plaintext reasoning_text (gateway demands passback)`);
    }
    const reasoning = this.reasoningField(
      (request.disableThinking ?? false) || continuationGuard || requiredToolThinkingOff,
      request.reasoningEffort,
    );
    const body: Record<string, unknown> = {
      model,
      input,
      ...modelTemperatureFields(this.modelProfile, request.temperature, asRecord(reasoning.reasoning)?.effort),
      ...(instructions ? { instructions } : {}),
      ...reasoning,
    };
    if (!(this.platformOptions?.disableMaxTokens ?? false)) {
      body.max_output_tokens = this.resolveOutputTokenLimit();
    }
    Object.assign(body, this.nativeToolFields(request.tools, request.toolChoice, reasoning));
    // 无工具轮不再强制 json_object（根因二 2026-09-19，与 openai-compatible 同步）：
    // executeAgentTurn 的无工具轮是伴星自然文本终答，强制 JSON 是 json_envelope_leak
    // 的直接来源。structured_action fallback 由 parseResponsesAgentTurn 对 content
    // 的解析承担。chatCompletion 的默认 JSON 模式不受影响（显式调用方需要 JSON）。

    const response = await this.request(this.endpoint, this.headers(false), body, signal);
    if (signal?.aborted) throw abortError(signal, "after agent turn response");
    if (response.status < 200 || response.status >= 300) {
      logOpenCodeRejection(this.id, response.status, response.body);
      throw new ProviderRequestError({
        provider: this.id,
        status: response.status,
        providerCode: readOpenCodeGoErrorCode(response.body),
      });
    }
    this.throwIfResponseFailed(response.body, model);
    if (signal?.aborted) throw abortError(signal, "after agent turn body read");

    const { content, toolCalls, finishReason, requestId } =
      parseResponsesAgentTurn(response.body, hasTools);
    const reasoningHandles = readResponsesReasoningHandles(response.body);

    // 输出截断 / 参数损坏检测（与 chat/completions 路径同一套非重试语义）：
    // finish_reason="length" 与 arguments 损坏都是确定性失败，重投只会空转，
    // 必须抛 AgentOutputError 让队列直接标记 dead。
    if (finishReason === "length") {
      throw new AgentOutputError(
        "output_truncated",
        `agent output truncated at max_output_tokens `
        + `(toolCalls=${toolCalls.length}, malformed=${toolCalls.filter((tc) => tc.argumentsMalformed).length})`,
      );
    }
    const malformed = toolCalls.find((tc) => tc.argumentsMalformed);
    if (malformed) {
      throw new AgentOutputError(
        "arguments_malformed",
        `tool call "${malformed.name}" has malformed arguments JSON (id=${malformed.id || "unknown"})`,
      );
    }
    if (this.mustFallbackForMissingRequiredTool(request.toolChoice, request.tools, reasoning)
      && toolCalls.length === 0) {
      throw this.requiredToolChoiceUnsupportedError();
    }

    return {
      content,
      ...(responsesPhase(response.body, !hasTools) ? { phase: responsesPhase(response.body, !hasTools) } : {}),
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      finishReason,
      // 思考模式下部分模型（deepseek）要求下一轮把 reasoning 原样回传，
      // 否则工具循环第二步 400；调用方负责把它挂回 assistant 消息。
      ...(reasoningHandles.length > 0 ? { reasoning: reasoningHandles } : {}),
      usage: readResponsesUsage(response.body),
      providerRequestId: requestId,
    };
  }

  /**
   * 能力快照：窗口/输出上限来自**模型档案**（2026-10-06 配置重设计），
   * 未声明时用内置缺省（muse-spark 基线：1,048,576 / 131,072）。
   */
  getCapabilities(): ProviderCapability {
    const contextWindowTokens = this.modelProfile?.contextWindowTokens
      ?? OPENCODE_GO_CONTEXT_WINDOW_TOKENS;
    const reservedOutputTokens = this.maxOutputTokens;
    return {
      providerId: this.id,
      modelId: this.modelId,
      visionModelId: this.visionModelId,
      toolMode: "native_tools",
      contextWindowTokens,
      reservedOutputTokens,
      maxInputTokens: contextWindowTokens - reservedOutputTokens,
      maxOutputTokens: this.maxOutputTokens,
      // maxInputTokens 是「窗口 − 最大输出」的派生值，不是供应商独立声明的输入
      // 硬限制——不填 inputHardLimitTokens，预算解析只按 C − O 表达它。
      outputLimitEnforced: !(this.platformOptions?.disableMaxTokens ?? false),
      fingerprint: `${this.id}:${this.modelId}:native_tools:${profileFingerprint(this.modelProfile)}:${this.modelId === "deepseek-v4.1-flash" ? DEEPSEEK_TOKENIZER_REVISION : "byte-bound"}`,
    };
  }

  resolveOutputTokenLimit(): number | undefined {
    // 与 openai-compatible 同一口径：档案声明优先，没声明用这一档平台自己声明的最大输出，
    // 不回落到场点默认的 8192。handler 报的那个数不再当天花板。
    return modelOutputTokenLimit(this.modelProfile, this.maxOutputTokens);
  }

  countTextTokens(text: string): Promise<number | null> {
    return countModelTextTokens(this.modelId, text);
  }
}

/** MiMo's official Responses endpoint shares this wire implementation, without OpenCode-only headers/guards. */
export class MiMoResponsesProvider extends OpenCodeGoProvider {
  constructor(options: Omit<OpenAIResponsesProviderOptions, "protocol">) {
    super({ ...options, protocol: "mimo_responses" });
  }
}

async function readStreamingBodyText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error("Responses API error response exceeded 1048576 bytes");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
