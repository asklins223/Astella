import {
  evaluateContextPressure,
  resolveContextBudget,
  REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS,
  CONSERVATIVE_DEFAULT_OUTPUT_TOKENS,
  type ContextTokenCountingPorts,
} from "@astella/agent-core";
import {
  contextPressureReceiptV1Schema,
  type ContextBudgetSnapshotV1,
  type ContextPressureDecisionV1,
  type ContextPressureReceiptV1,
  type ContextRequestMeasurementV1,
} from "@astella/shared/context-budget-contracts";
import { DomainError, type ProviderCapability } from "@astella/shared";
import { logger } from "./logger.ts";
import type { AIProvider } from "./ai-provider.ts";

/**
 * 方案 44 §4.3：每次真实模型调用前的统一检查。
 *
 * 接线点是 `createGovernedProvider`——**所有**外发模型的唯一边界（伴星对话、持续
 * 目标、制卡/拓展、后台整理、视觉理解都从这里出去）。此前 companion-dialogue 只在
 * 入口查了一次 80,000 字符的 system 限制，于是「system 很短但工具 schema／单次工具
 * 结果很大」这类请求完全没人管；工具回合、补取材料、后台继续、重试与备用模型切换
 * 更是连一次检查都没有（44 §2／§4.3）。
 *
 * 这一层做三件事，不多也不少：
 *   1. 从**本次实际路由**的能力快照解析预算（不读任何固定数字）；
 *   2. 计量实际送出的完整请求（system + 历史 + 当前输入 + 工具 schema + 工具结果）；
 *   3. 判定并回执。触发线是治理线，超硬上限才是拒绝线。
 *
 * 它**不删内容**。压缩要由持有工作上下文的那一层执行（有界、至多一次、可失败），
 * 这里的职责是判定与如实记录（44 §5.4）。
 */

/** 能力不可获知时的登记保守能力（provider 未实现 getCapabilities 的场景）。 */
export const REGISTERED_FALLBACK_CAPABILITY = {
  contextWindowTokens: REGISTERED_FALLBACK_CONTEXT_WINDOW_TOKENS,
  reservedOutputTokens: CONSERVATIVE_DEFAULT_OUTPUT_TOKENS,
  maxOutputTokens: CONSERVATIVE_DEFAULT_OUTPUT_TOKENS,
} as const;

export interface ContextGateReceipt {
  providerId: string;
  modelId: string;
  operation: string;
  budget: ContextBudgetSnapshotV1;
  measurement: ContextRequestMeasurementV1;
  decision: ContextPressureDecisionV1;
}

/**
 * 完整请求装不进硬上限，且本轮没有可用的压缩路径。
 *
 * 不可重试：重投同一个请求只会再撞一次同一条上限（44 §5.4「不能无限重发」）。
 * 也不能降级成「沿用旧摘要直接发」——那正是把一个必然被上游拒的请求送出去。
 * 调用方拿到的是一条真实、可行动的限制说明。
 */
export class AIContextOverflowError extends DomainError {
  readonly code = "ai_context_overflow";

  constructor(readonly receipt: ContextGateReceipt) {
    super({
      name: "AIContextOverflowError",
      code: "ai_context_overflow",
      message: receipt.decision.detail
        ?? `context overflow: ${receipt.measurement.inputTokens} > ${receipt.budget.hardInputTokens} input tokens`,
      statusCode: 413,
    });
  }
}

/**
 * 本次请求超触发线，且调用方声明了仍有一次有界压缩的额度。
 *
 * 与 {@link AIContextOverflowError} 是两件事：这一次**不是**装不下，而是应该先压。
 * 因此它不拦截调用链的失败语义——持有工作上下文的那一层捕获它、做一次有界压缩、
 * 重新装配并重新计量，然后重发本次请求（44 §4.3／§5.4）。
 *
 * 压缩本身的有界、原子提交与失败冷却属于工作上下文所有者，本层不代劳也不隐藏。
 */
export class AIContextCompactionRequiredError extends Error {
  readonly code = "AI_CONTEXT_COMPACTION_REQUIRED" as const;

  constructor(readonly receipt: ContextGateReceipt) {
    super(receipt.decision.detail
      ?? `context pressure: ${receipt.measurement.inputTokens} > ${receipt.budget.triggerTokens} trigger tokens`);
    this.name = "AIContextCompactionRequiredError";
  }
}

/**
 * 把一份回执投影成可落库的形状（44 §3.3）。
 *
 * 走一次 zod parse 是刻意的：落库的那一列就是合同的一部分，字段名漂移会在写入前
 * 报错，而不是半年后从库里的 JSON 里读出一个没人认得的键。
 */
export function toContextPressureReceipt(receipt: ContextGateReceipt): ContextPressureReceiptV1 {
  const { budget, measurement, decision } = receipt;
  return contextPressureReceiptV1Schema.parse({
    version: 1,
    providerId: receipt.providerId,
    modelId: receipt.modelId,
    operation: receipt.operation,
    contextWindowTokens: budget.contextWindowTokens,
    outputReservationTokens: budget.outputReservationTokens,
    providerInputLimitTokens: budget.providerInputLimitTokens,
    inputLimitSource: budget.inputLimitSource,
    overheadTokens: budget.overheadTokens,
    hardInputTokens: budget.hardInputTokens,
    triggerTokens: budget.triggerTokens,
    targetTokens: budget.targetTokens,
    confidence: budget.confidence,
    inputTokens: measurement.inputTokens,
    method: measurement.method,
    unmeasured: measurement.unmeasured,
    errorMarginTokens: measurement.errorMarginTokens,
    outcome: decision.outcome,
    reason: decision.reason,
  });
}

export interface ContextBudgetGateOptions {
  /**
   * 本次调用是否还有一次有界压缩的额度。
   *
   * `true` → 超过触发线时判定为 `compact`（调用方压缩后重新装配并重新计量）。
   * `false` → 本轮额度已用尽，带着有效上下文继续。
   * `undefined` → 这条工作上下文没有压缩路径，带着有效上下文继续。
   */
  compactionAvailable?: () => boolean | undefined;
  /** 判定回执。落库、观测或透传给 run meta 都走这里。 */
  onDecision?: (receipt: ContextGateReceipt) => void;
}

export interface ContextPressureRequest {
  provider: Pick<AIProvider, "id" | "modelId" | "getCapabilities">;
  operation: string;
  /** 本次请求声明的输出上限（agent turn 的 maxTokens / chat 的 maxTokens）。 */
  requestedOutputTokens?: number | null;
  measure: (ports: ContextTokenCountingPorts) => Promise<ContextRequestMeasurementV1>;
}

/**
 * 一份能力快照是否足以解析预算。
 *
 * 能力快照是可选实现（`getCapabilities?`），而且真实调用方——包括测试桩与旧
 * provider——完全可能返回一个**不完整**的形状（只有 providerId）。此时不能直接把
 * 调用打死：那会把「这个 provider 没声明窗口」变成「用户这次永远失败」。按 44 §4.1
 * 退回已登记的保守能力，并把 confidence 如实记成 registered_default。
 */
function usableCapability(capability: ProviderCapability | null | undefined): capability is ProviderCapability {
  return typeof capability?.contextWindowTokens === "number"
    && Number.isSafeInteger(capability.contextWindowTokens)
    && capability.contextWindowTokens > 0;
}

/**
 * 执行一次调用前检查。返回回执；判定为 reject 时抛 {@link AIContextOverflowError}。
 *
 * 计量是对内存结构的解析，不吞异常：端口自身出错说明代码有 bug，让它响比换一个
 * 更宽松的路径静默放行要好。
 */
export async function governContextPressure(
  request: ContextPressureRequest,
  options: ContextBudgetGateOptions = {},
): Promise<ContextGateReceipt> {
  const declared = request.provider.getCapabilities?.() ?? null;
  if (declared && !usableCapability(declared)) {
    logger.warn(
      { operation: request.operation, providerId: request.provider.id, modelId: request.provider.modelId },
      "provider capability snapshot has no usable context window; using the registered conservative capability",
    );
  }
  const capability = usableCapability(declared) ? declared : null;
  const budget = resolveContextBudget({
    capability,
    registeredCapability: capability ? undefined : REGISTERED_FALLBACK_CAPABILITY,
    requestedOutputTokens: request.requestedOutputTokens ?? null,
    outputLimitEnforced: capability?.outputLimitEnforced ?? true,
    inputHardLimitTokens: capability?.inputHardLimitTokens ?? null,
  });

  const measurement = await request.measure({});

  const decision = evaluateContextPressure({
    budget,
    inputTokens: measurement.inputTokens,
    compactionAvailable: options.compactionAvailable?.(),
  });
  const receipt: ContextGateReceipt = {
    providerId: request.provider.id,
    modelId: request.provider.modelId,
    operation: request.operation,
    budget,
    measurement,
    decision,
  };
  options.onDecision?.(receipt);
  if (decision.outcome !== "send") {
    logger.warn(
      {
        operation: request.operation,
        providerId: receipt.providerId,
        modelId: receipt.modelId,
        inputTokens: measurement.inputTokens,
        hardInputTokens: budget.hardInputTokens,
        triggerTokens: budget.triggerTokens,
        targetTokens: budget.targetTokens,
        method: measurement.method,
        outcome: decision.outcome,
        reason: decision.reason,
      },
      decision.outcome === "compact"
        ? "context pressure: bounded compaction required before this call"
        : "context pressure: request exceeds the hard input limit for this route",
    );
  }
  if (decision.outcome === "reject") throw new AIContextOverflowError(receipt);
  if (decision.outcome === "compact") throw new AIContextCompactionRequiredError(receipt);
  return receipt;
}
