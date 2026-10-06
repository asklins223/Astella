import type { AgentTurnRequest, ChatMessage, ChatOptions } from "@ailearn/shared";
import {
  contextRequestMeasurementV1Schema,
  type ContextRequestMeasurementV1,
} from "@ailearn/shared/context-budget-contracts";

/**
 * 方案 44 §4.2：完整模型请求的输入计量 P。
 *
 * P 必须覆盖**实际序列化后**送出去的全部内容：system / 历史 / 当前输入 / 工具 schema /
 * 工具调用参数与结果 / provider 包装 / 多模态。只测 system 或某个业务数据块，会得到
 * 「system 明明很短所以没事」的错误结论——工具 schema 与单次工具结果完全可能比正文大。
 *
 * 计数能力按优先级注入（44 §4.2）：
 *   1. `tokenizer` —— 适配当前模型的 tokenizer（精确）；
 *   2. `providerCount` —— provider 自带的计数能力；
 *   3. `anchor` —— 以**相匹配**请求的真实 usage 为锚点，只计新增内容；
 *   4. 无端口时走保守估算，并记录方法、误差余量与未计量载荷。
 *
 * 估算永远向上取整。多模态等不透明载荷按**保守地板**计价并写进 `unmeasured`——
 * 未知成本不能记作零（44 §4.2）。
 */

/** 计量口径版本。provider 序列化规则变化后旧锚点必须失效（44 §4.2）。 */
export const CONTEXT_MEASUREMENT_VERSION = "v1";

/** 单张图片的保守 token 地板。没有它时未知成本会被静默记成 0。 */
export const IMAGE_TOKEN_FLOOR = 1_500;

/** 不透明 reasoning 句柄的保守 token 地板。 */
export const REASONING_HANDLE_TOKEN_FLOOR = 64;

/** 每条消息 / 每个 tool item 的协议封装开销（role、分隔符、结构包装）。 */
const ITEM_ENVELOPE_TOKENS = 4;
/** 工具 schema 的固定封装开销（tools 数组、type/name 包装）。 */
const TOOL_SCHEMA_ENVELOPE_TOKENS = 8;
/** 精确计数路径不回加误差余量。 */
const EXACT_ERROR_MARGIN = 0;

/**
 * CJK 与非 CJK 的保守比例。
 *
 * 现役路由（qwen3.8-flash / muse-spark / GLM / bge 系列）里中文占绝大多数。
 * 对中文按 1 token/字符（多数分词器实际略低于 1，这里向上取整保证不低估）；
 * 对非 CJK 按 1 token / 3 字符——真实值接近 1/4，取 1/3 留出约 25% 的向上余量。
 * 比例只是估算依据：provider 返回的真实 usage 用于校准，不是用于当 tokenizer 用。
 */
const CJK_TOKENS_PER_CHAR = 1;
const OTHER_CHARS_PER_TOKEN = 3;

/** 保守估算一段文本的 token 数。空串返回 0（不按 1 收，避免给零内容加地板）。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // CJK 统一表意文字扩展 A、全角标点与假名；其余按非 CJK 计。
    if ((code >= 0x3040 && code <= 0x30ff)
      || (code >= 0x3400 && code <= 0x9fff)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x20000 && code <= 0x2ebef)) cjk += 1;
  }
  const other = text.length - cjk;
  return cjk * CJK_TOKENS_PER_CHAR + Math.ceil(other / OTHER_CHARS_PER_TOKEN);
}

export interface ContextTokenCountingPorts {
  /** 适配当前模型的 tokenizer。抛错或返回 null 时退回下一优先级。 */
  countTokens?(text: string): number | null | Promise<number | null>;
  /**
   * provider 自带的计数能力。调用方闭包持有自己的完整请求，这里只取数字——
   * core 不该知道 provider 的序列化对象长什么样。
   */
  providerCount?(): number | null | Promise<number | null>;
  /**
   * 以相匹配请求的真实 usage 为锚点。
   *
   * `matches` 由调用方判定——模型路由、前缀内容、工具集与序列化版本任一不同，
   * 锚点就失效（44 §4.2）。锚点只计前缀，**新增内容另计**；已包含的 assistant
   * 输出不重复计算，缓存命中仍占窗口。
   */
  anchor?(): { inputTokens: number; matches: boolean } | null | Promise<{ inputTokens: number; matches: boolean } | null>;
}

interface RawCost {
  system: number;
  messages: number;
  tools: number;
  multimodal: number;
  unmeasured: string[];
  /** 结构化文本：走 tokenizer/端口时逐段计数。 */
  segments: string[];
}

/**
 * 记下「这一类载荷没法精确计量」。
 *
 * `unmeasured` 记的是**种类**，不是份数（合同限 12 条）：一份请求里 13 张图仍然是
 * 「含图片」这一种，按 part 累加会把它撑破合同，让一个本来装得下的请求直接报错。
 * 份数不丢——成本按每个 part 的地板价累加进 `multimodal`。
 */
function markUnmeasured(raw: RawCost, kind: string): void {
  if (!raw.unmeasured.includes(kind)) raw.unmeasured.push(kind);
}

/** 把一条消息的 content 拆成「可直接计数的文本段」与「不透明载荷」。 */
function readContent(content: AgentTurnRequest["messages"][number]["content"] | ChatMessage["content"], raw: RawCost): void {
  if (typeof content === "string") {
    raw.segments.push(content);
    return;
  }
  for (const part of content) {
    if (part.type === "text") raw.segments.push(part.text);
    else {
      raw.multimodal += IMAGE_TOKEN_FLOOR;
      markUnmeasured(raw, "image");
    }
  }
}

function readTools(tools: AgentTurnRequest["tools"], raw: RawCost): void {
  if (!tools.length) return;
  raw.tools += TOOL_SCHEMA_ENVELOPE_TOKENS * tools.length;
  for (const tool of tools) {
    raw.segments.push(tool.name, tool.description, JSON.stringify(tool.parameters));
  }
}

function readAgentTurnRequest(request: AgentTurnRequest): RawCost {
  const raw: RawCost = { system: 0, messages: 0, tools: 0, multimodal: 0, unmeasured: [], segments: [] };
  if (request.systemPrompt) {
    raw.system += ITEM_ENVELOPE_TOKENS;
    raw.segments.push(request.systemPrompt);
  }
  for (const message of request.messages) {
    raw.messages += ITEM_ENVELOPE_TOKENS;
    readContent(message.content, raw);
    if (message.toolCallId) raw.segments.push(message.toolCallId);
    for (const call of message.toolCalls ?? []) {
      raw.messages += 2;
      raw.segments.push(call.name, JSON.stringify(call.arguments));
    }
    for (const handle of message.reasoning ?? []) {
      // 句柄由 provider 回放，结构不透明；记地板而不是零。
      void handle;
      raw.messages += 1;
      raw.multimodal += REASONING_HANDLE_TOKEN_FLOOR;
      markUnmeasured(raw, "reasoning_handle");
    }
  }
  readTools(request.tools, raw);
  return raw;
}

function readChatMessages(messages: readonly ChatMessage[], tools?: ChatOptions["tools"]): RawCost {
  const raw: RawCost = { system: 0, messages: 0, tools: 0, multimodal: 0, unmeasured: [], segments: [] };
  for (const message of messages) {
    if (message.role === "system") {
      raw.system += ITEM_ENVELOPE_TOKENS;
    } else {
      raw.messages += ITEM_ENVELOPE_TOKENS;
    }
    readContent(message.content, raw);
  }
  if (tools?.length) readTools(tools, raw);
  return raw;
}

/**
 * 启发式估算的总开销：各段文本估算 + 固定结构开销 + 不透明载荷地板。
 *
 * 估算路径必须给误差余量（44 §4.2）。余量按估算体量的 12% 并设下限 256——
 * 没有下限的话，一个「system 很短但工具 schema 很大」的请求会拿到 0 余量，
 * 恰好是 44 §8.1 要验收的那种形状。
 */
function heuristicTotal(raw: RawCost): { total: number; margin: number } {
  const textTokens = raw.segments.reduce((sum, segment) => sum + estimateTextTokens(segment), 0);
  const fixed = raw.system + raw.messages + raw.tools;
  const total = textTokens + fixed + raw.multimodal;
  return { total, margin: Math.max(256, Math.ceil((textTokens + fixed) * 0.12)) };
}

function proportional(raw: RawCost, total: number): ContextRequestMeasurementV1["parts"] {
  const fixed = raw.system + raw.messages + raw.tools;
  const scalable = total - raw.multimodal;
  if (scalable <= 0 || fixed <= 0) {
    return { system: raw.system, messages: raw.messages, tools: raw.tools, multimodal: raw.multimodal };
  }
  const scale = scalable / fixed;
  return {
    system: Math.round(raw.system * scale),
    messages: Math.round(raw.messages * scale),
    tools: Math.round(raw.tools * scale),
    multimodal: raw.multimodal,
  };
}

async function finish(raw: RawCost, ports: ContextTokenCountingPorts): Promise<ContextRequestMeasurementV1> {
  const heuristic = heuristicTotal(raw);
  // provider 自带计数能力：直接吃完整请求结构，最高优先级。
  const providerTotal = ports.providerCount ? await ports.providerCount() : null;
  if (typeof providerTotal === "number" && Number.isSafeInteger(providerTotal) && providerTotal >= 0) {
    return contextRequestMeasurementV1Schema.parse({
      version: 1,
      inputTokens: providerTotal,
      method: "provider_count",
      parts: proportional(raw, providerTotal),
      unmeasured: raw.unmeasured,
      errorMarginTokens: EXACT_ERROR_MARGIN,
      measurementVersion: CONTEXT_MEASUREMENT_VERSION,
    });
  }
  // 精确 tokenizer：逐段计数，结构开销照加。
  if (ports.countTokens) {
    let exact: number | null = null;
    for (const segment of raw.segments) {
      const counted = await ports.countTokens(segment);
      if (typeof counted !== "number" || !Number.isSafeInteger(counted) || counted < 0) {
        exact = null;
        break;
      }
      exact = (exact ?? 0) + counted;
    }
    if (exact !== null) {
      const total = exact + raw.system + raw.messages + raw.tools + raw.multimodal;
      return contextRequestMeasurementV1Schema.parse({
        version: 1,
        inputTokens: total,
        method: "tokenizer",
        parts: proportional(raw, total),
        unmeasured: raw.unmeasured,
        errorMarginTokens: EXACT_ERROR_MARGIN,
        measurementVersion: CONTEXT_MEASUREMENT_VERSION,
      });
    }
  }
  // usage 锚点：前缀已知，只计新增内容的增量估算。
  const anchor = ports.anchor ? await ports.anchor() : null;
  if (anchor?.matches && Number.isSafeInteger(anchor.inputTokens) && anchor.inputTokens >= 0) {
    const margin = heuristic.margin;
    const total = anchor.inputTokens + heuristic.total + margin;
    return contextRequestMeasurementV1Schema.parse({
      version: 1,
      inputTokens: total,
      method: "usage_anchor",
      parts: proportional(raw, total),
      unmeasured: raw.unmeasured,
      errorMarginTokens: margin,
      measurementVersion: CONTEXT_MEASUREMENT_VERSION,
    });
  }
  return contextRequestMeasurementV1Schema.parse({
    version: 1,
    inputTokens: heuristic.total + heuristic.margin,
    method: "heuristic",
    parts: proportional(raw, heuristic.total),
    unmeasured: raw.unmeasured,
    errorMarginTokens: heuristic.margin,
    measurementVersion: CONTEXT_MEASUREMENT_VERSION,
  });
}

/** 计量一次 agent turn 的完整请求（P）。 */
export async function measureAgentTurnRequest(
  request: AgentTurnRequest,
  ports: ContextTokenCountingPorts = {},
): Promise<ContextRequestMeasurementV1> {
  return finish(readAgentTurnRequest(request), ports);
}

/**
 * 计量一次 chat / stream 请求的完整请求（P）。
 *
 * options.tools 属于真实序列化内容（chat 路径同样下发 tools），必须计入——这是
 * 44 §8.1「system 很短但工具 schema 很大也能触发治理」的那一半。
 */
export async function measureChatRequest(
  messages: readonly ChatMessage[],
  options: ChatOptions = {},
  ports: ContextTokenCountingPorts = {},
): Promise<ContextRequestMeasurementV1> {
  return finish(readChatMessages(messages, options.tools), ports);
}