import type { ProviderCapability } from "@astella/shared";
import {
  contextBudgetSnapshotV1Schema,
  contextPressureDecisionV1Schema,
  type ContextBudgetSnapshotV1,
  type ContextPressureDecisionV1,
} from "@astella/shared/context-budget-contracts";

/**
 * 方案 44 §4：完整模型请求的预算解析与调用前压力判定。
 *
 * **这里是唯一的预算权威**（44 §7）。core 不导入 provider、数据库、worker handler
 * 或 UI，只吃一份能力快照与本轮生效参数，吐出一份可落库的回执。任何入口（伴星、
 * 持续目标、制卡/拓展、后台整理）都走这一条，不另建 companion 专属预算。
 *
 * 三条口径（44 §4.1），每条都对应一个已知的重复折扣错误：
 *   1. 80% 只作用于触发线 T，不再先对 B_hard 乘一次 0.8；
 *   2. 系统协议／人格／工具定义已计入 P，不作为固定 RESERVED_TOKENS 再扣一遍——
 *      这里的 M 只覆盖**未完全可计量**的部分（协议封装、估算误差）；
 *   3. I 为 null 时，「窗口 − 最大输出」的派生约束已经由 C − O 表达，不再二次扣减。
 */

/** 默认压缩触发线（44 §4.1）。 */
export const CONTEXT_TRIGGER_RATIO = 0.8;
/** 初始压缩目标（44 §4.1）。按真实样本再调整，不用于证明「必须删到什么程度」。 */
export const CONTEXT_TARGET_RATIO = 0.6;

/**
 * 协议开销与估算误差余量 M 的登记默认值。
 *
 * 数值依据：Responses / chat-completions 每次请求的 envelope 与 role/tool item 包装，
 * 外加保守 token 估算的典型误差。**不含**系统提示、人格或工具 schema 本身——那三项
 * 已在 P 里（44 §4.1 明确禁止重复扣减）。
 */
export const CONTEXT_OVERHEAD_TOKENS = 2_048;

/** 能力不可获知时使用的登记保守窗口。宁可提前压缩，也不发一个必然被上游拒的请求。 */
export const REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * 请求**没有**声明输出上限、且 provider 也未强制下发时的保守输出预留。
 *
 * 上游默认通常远小于平台最大值（openai-compatible 注释记录：不传 max_tokens 时
 * 默认只有 8192）。但预算不能因此假定「输出很小」——预留必须覆盖实际可能被执行的上限。
 */
export const CONSERVATIVE_DEFAULT_OUTPUT_TOKENS = 16_384;

export type AgentContextBudgetErrorCode =
  | "budget_unresolved"
  | "invalid_budget_input";

export class AgentContextBudgetError extends Error {
  constructor(readonly code: AgentContextBudgetErrorCode, message: string) {
    super(message);
    this.name = "AgentContextBudgetError";
  }
}

export interface ContextBudgetInput {
  /** 本次实际路由的能力快照。缺能力时用 registeredCapability 兜底。 */
  capability?: ProviderCapability | null;
  /** provider 明确未实现 getCapabilities 时的登记保守能力。 */
  registeredCapability?: Pick<ProviderCapability, "contextWindowTokens" | "reservedOutputTokens" | "maxOutputTokens"> & {
    inputHardLimitTokens?: number;
  };
  /** 本次请求声明的输出上限（agent turn 的 maxTokens / chat 的 maxTokens）。 */
  requestedOutputTokens?: number | null;
  /**
   * provider 是否真的把输出上限下发给上游。
   *
   * `disableMaxTokens` 的平台就是 false——此时 requestedOutputTokens **不代表**
   * 实际会执行的上限，必须退回已知默认或保守预留（44 §4.1）。
   */
  outputLimitEnforced?: boolean;
  /** 供应商独立声明的输入硬上限（仅在非派生时提供）。 */
  inputHardLimitTokens?: number | null;
  /** 未完全可计量的协议开销与估算误差余量。 */
  overheadTokens?: number;
  triggerRatio?: number;
  targetRatio?: number;
}

function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function ratio(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved < 0 || resolved > 1)
    throw new AgentContextBudgetError("invalid_budget_input", `${field} must be a ratio in [0, 1]`);
  return resolved;
}

/**
 * 解析一次请求的预算快照。
 *
 * B_hard = max(0, min(C - O, I) - M)；T = floor(B_hard × 0.80)；G = floor(B_hard × 0.60)。
 *
 * I 缺省时视为「无额外限制」，由 C − O 单独表达——这正是避免重复折扣的地方。
 * 能力完全不可获知时抛 `budget_unresolved`：上层据此给出真实限制，而不是沿用一个
 * 与本路由无关的旧字符护栏（44 §4.1）。
 */
export function resolveContextBudget(input: ContextBudgetInput): ContextBudgetSnapshotV1 {
  const provenance: ContextBudgetSnapshotV1["provenance"] = [];
  const capability = input.capability ?? input.registeredCapability ?? null;
  const declared = Boolean(input.capability);

  let contextWindowTokens: number;
  if (capability && positiveInt(capability.contextWindowTokens)) {
    contextWindowTokens = capability.contextWindowTokens;
    provenance.push({ field: "C", source: declared ? "provider_capability" : "registered_default" });
  } else {
    throw new AgentContextBudgetError(
      "budget_unresolved",
      "context window is unknown for this route and no registered conservative capability was supplied",
    );
  }

  // O：本轮实际采用的输出预留。
  //
  // 请求声明了上限**且**provider 真的下发时用它；否则用平台声明的最大输出，
  // 再否则退回登记保守值。请求声明被忽略时绝不能因为「数值很小」就假定输出也很小。
  const platformOutput = capability && positiveInt(capability.maxOutputTokens)
    ? capability.maxOutputTokens
    : null;
  let outputReservationTokens: number;
  let outputSource: string;
  if (input.outputLimitEnforced === false || !positiveInt(input.requestedOutputTokens)) {
    outputReservationTokens = platformOutput ?? CONSERVATIVE_DEFAULT_OUTPUT_TOKENS;
    outputSource = input.outputLimitEnforced === false
      ? "conservative_default_output_not_enforced"
      : "requested_output_absent";
  } else {
    outputReservationTokens = Math.min(input.requestedOutputTokens!, platformOutput ?? input.requestedOutputTokens!);
    outputSource = "requested_output";
  }
  provenance.push({ field: "O", source: outputSource });

  // I：供应商独立的输入硬上限。派生值不在这里表达——C − O 已经覆盖它。
  const declaredInputLimit = positiveInt(input.inputHardLimitTokens) ? input.inputHardLimitTokens! : null;
  const capabilityInputLimit = capability && positiveInt(capability.inputHardLimitTokens)
    ? capability.inputHardLimitTokens
    : null;
  const independentInputLimit = declaredInputLimit ?? capabilityInputLimit;
  const inputLimitSource = independentInputLimit === null
    ? "none" as const
    : "independent" as const;
  provenance.push({ field: "I", source: independentInputLimit === null ? "derived_by_context_minus_output" : "vendor_declared_input_limit" });

  // M：未完全可计量的协议开销与估算误差余量。
  const overheadTokens = input.overheadTokens ?? CONTEXT_OVERHEAD_TOKENS;
  if (!Number.isSafeInteger(overheadTokens) || overheadTokens < 0)
    throw new AgentContextBudgetError("invalid_budget_input", "overheadTokens must be a non-negative integer");
  provenance.push({ field: "M", source: "registered_protocol_overhead" });

  const triggerRatio = ratio(input.triggerRatio, CONTEXT_TRIGGER_RATIO, "triggerRatio");
  const targetRatio = ratio(input.targetRatio, CONTEXT_TARGET_RATIO, "targetRatio");
  provenance.push({ field: "trigger", source: "fixed_ratio_of_hard_budget" });
  provenance.push({ field: "target", source: "fixed_ratio_of_hard_budget" });

  const windowAfterOutput = Math.max(0, contextWindowTokens - outputReservationTokens);
  const hardInputTokens = Math.max(0, Math.min(windowAfterOutput, independentInputLimit ?? Infinity) - overheadTokens);

  return contextBudgetSnapshotV1Schema.parse({
    version: 1,
    contextWindowTokens,
    outputReservationTokens,
    providerInputLimitTokens: independentInputLimit,
    inputLimitSource,
    overheadTokens,
    hardInputTokens,
    triggerTokens: Math.floor(hardInputTokens * triggerRatio),
    targetTokens: Math.floor(hardInputTokens * targetRatio),
    triggerRatio,
    targetRatio,
    confidence: declared ? "declared" : "registered_default",
    provenance,
  });
}

export interface ContextPressureInput {
  budget: ContextBudgetSnapshotV1;
  inputTokens: number;
  /** 本轮是否还有一次有界压缩的额度（44 §5.4：一次实际请求默认至多一次）。 */
  compactionAvailable?: boolean;
  /** 必要内容（当前请求、明确操作、必要协议与事实引用）自身就装不下。 */
  requiredContentOverflows?: boolean;
  /** 无法给出可行动方案时的真实限制说明。 */
  detail?: string | null;
}

/**
 * 调用前判定：发送 / 先压缩 / 拒绝。
 *
 * 顺序不可调换：必要内容装不下时必须先报 `required_content_overflows`，因为那时的
 * 正确处置是分段或如实说明限制，而不是先试一次注定失败的压缩。
 */
export function evaluateContextPressure(input: ContextPressureInput): ContextPressureDecisionV1 {
  const { budget } = input;
  const base = {
    version: 1 as const,
    inputTokens: input.inputTokens,
    hardInputTokens: budget.hardInputTokens,
    triggerTokens: budget.triggerTokens,
    targetTokens: budget.targetTokens,
  };
  if (input.requiredContentOverflows) {
    return contextPressureDecisionV1Schema.parse({
      ...base,
      outcome: "reject",
      reason: "required_content_overflows",
      detail: input.detail
        ?? `必要内容本身超过可用输入预算（${input.inputTokens} > ${budget.hardInputTokens} tokens）；`
        + "需要分段或缩小这次请求的范围，而不是静默截断。",
    });
  }
  if (input.inputTokens <= budget.triggerTokens) {
    return contextPressureDecisionV1Schema.parse({ ...base, outcome: "send", reason: "within_budget", detail: null });
  }
  if (input.inputTokens > budget.hardInputTokens && input.compactionAvailable !== true) {
    // 没有压缩额度时才拒绝；有额度则先要求压缩，重测仍超限再拒绝。
    return contextPressureDecisionV1Schema.parse({
      ...base,
      outcome: "reject",
      reason: "over_hard_limit",
      detail: input.detail
        ?? `本次完整请求 ${input.inputTokens} tokens 超过可用输入上限 ${budget.hardInputTokens}`
        + `（窗口 ${budget.contextWindowTokens} − 输出预留 ${budget.outputReservationTokens}`
        + ` − 开销余量 ${budget.overheadTokens}）；本轮没有可用的压缩路径。`,
    });
  }
  if (input.compactionAvailable !== true) {
    // 压不动就带有效上下文继续（44 §5.4）——触发线是治理线，不是硬拒绝线。
    // 区分两种「压不动」：根本没接压缩端口，与本轮压缩额度已用尽。两者的后续处置不同。
    const spent = input.compactionAvailable === false;
    return contextPressureDecisionV1Schema.parse({
      ...base,
      outcome: "send",
      reason: spent ? "compaction_budget_spent" : "over_trigger_line",
      detail: input.detail ?? (spent
        ? "已超过压缩触发线，本轮压缩额度已用尽，按有效上下文继续发送。"
        : "已超过压缩触发线；这条工作上下文没有可用的压缩路径，按有效上下文继续发送。"),
    });
  }
  return contextPressureDecisionV1Schema.parse({
    ...base,
    outcome: "compact",
    reason: "over_trigger_line",
    detail: input.detail ?? `已超过压缩触发线（${input.inputTokens} > ${budget.triggerTokens} tokens），先做一次有界压缩。`,
  });
}