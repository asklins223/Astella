import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { runWithAbortBudget } from "../../lib/handler-timeout.ts";
import { logger } from "../../lib/logger.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";

/**
 * 退化回复的修复阶梯（2026-10-13 从 `companion-agent-runtime.ts` 搬出，判据一字未改）。
 *
 * 退化回复闸（2026-09-20 重写）：正文短得不正常、**这一步一个字都没真正下发**、
 * 模型也没要调工具——换**另一个模型**把这一步重跑一次，取更长者。
 *
 * 此前它形同虚设，两个原因：
 *   1. 判据 `!stepEmitted` 在流式路径恒不成立（吐过字就置位），实机连续四轮
 *      落库 `现在是`(3)/`今天`(2)/`最近`(2)/`你`(1) 全是流式，闸一次没拦；
 *      现在 `onTextEmitted` 只在**真的下发**时触发（见 holdUntilChars），语义回到位。
 *   2. `currentUserPromptLen >= 8` 把"哈哈"这类短输入整个排除，而那正是坍缩最
 *      严重的地方。去掉它——反正每轮至多重跑一次，最坏成本一次调用。
 * 重跑若带回工具调用则弃用（那是要走工具循环的信号，不是能直接落库的正文）。
 */

export type CompanionAnswerRepairInput = {
  result: AgentTurnResult;
  calls: NonNullable<AgentTurnResult["toolCalls"]>;
  stepRequest: AgentTurnRequest;
  /** 这一步是否真的往用户那边下发过字（坍缩闸攒住的不算）。 */
  stepEmitted: boolean;
  /** 退化回复闸每轮至多触发一次（2026-09-19 深夜，tokenrhythm 退化窗口实测）。 */
  alreadyRetried: boolean;
  deadlineAt: number;
  stepCount: number;
  runId: string;
  fallbackProvider: AIProvider | null | undefined;
  ctxSignal: AbortSignal;
  /** 「这句话在语法上说完了吗」的唯一实现留在运行时侧（输出闸棘轮 G5 认那一处调用）。 */
  isTruncated: (text: string) => boolean;
  /** 由运行侧提供「拿这个 provider 把这一步再跑一次」，含超时与租约那一套。 */
  invokeProvider: (args: { provider: AIProvider; request: AgentTurnRequest; signal: AbortSignal; timeoutMs: number }) => Promise<AgentTurnResult>;
};

export type CompanionAnswerRepairOutcome = {
  result: AgentTurnResult;
  calls: NonNullable<AgentTurnResult["toolCalls"]>;
  retried: boolean;
};

export async function repairDegenerateCompanionAnswer(input: CompanionAnswerRepairInput): Promise<CompanionAnswerRepairOutcome> {
  const { result, calls } = input;
  const canRepair = typeof input.fallbackProvider?.executeAgentTurn === "function";
  if (!(canRepair
    && !input.alreadyRetried
    && calls.length === 0
    && !input.stepEmitted
    && Date.now() < input.deadlineAt
    && typeof result.content === "string"
    && input.isTruncated(result.content)))
    return { result, calls, retried: false };

  // 降级阶梯（方案 29 §9.6）：只换**另一个模型/provider**——实测主模型退化窗口里
  // 同模型重跑同样会退化（连着两次都吐半截话），唯一有效的是换一个模型。
  const repairLadder: Array<{ label: string; provider: AIProvider }> = [];
  if (input.fallbackProvider) repairLadder.push({ label: "fallback-model", provider: input.fallbackProvider });
  logger.warn(
    { runId: input.runId, stepCount: input.stepCount, chars: String(result.content).trim().length,
      ladder: repairLadder.map(step => step.label) },
    "companion agent produced a degenerate answer; walking the repair ladder",
  );
  let repaired = result, repairedCalls = calls;
  for (const rung of repairLadder) {
    if (Date.now() >= input.deadlineAt) break;
    // 已经拿到结构完整的答案就停——不为"更长"再花一次调用。
    if (!input.isTruncated(String(repaired.content ?? ""))) break;
    try {
      const retryTimeoutMs = Math.min(resolveProviderCallTimeout("companion_agent"), Math.max(1, input.deadlineAt - Date.now()));
      const retryRequest = { ...input.stepRequest,
        maxTokens: Math.min(input.stepRequest.maxTokens, companionStepOutputCeiling(rung.provider)) };
      const retryResult = await runWithAbortBudget(
        signal => input.invokeProvider({ provider: rung.provider, request: retryRequest, signal, timeoutMs: retryTimeoutMs }),
        input.ctxSignal, retryTimeoutMs);
      const retryCalls = retryResult.toolCalls ?? [];
      const retryText = typeof retryResult.content === "string" ? retryResult.content.trim() : "";
      // 重跑值不值：**结构上补全了**就算值，哪怕只多一个字。实机退化形态是
      // `今天已经学了1` → `今天已经学了18分钟啦`，长度差不到 10 字，
      // 但前者是个说了一半的句子。只比长度会把这种修复判成"没变好"而丢掉。
      const retryIsWhole = retryText.length > 0 && !input.isTruncated(retryText);
      const retryIsLonger = retryText.length > String(repaired.content ?? "").trim().length;
      if (retryCalls.length === 0 && (retryIsWhole || retryIsLonger)) {
        logger.info({ runId: input.runId, stepCount: input.stepCount, rung: rung.label,
          chars: retryText.length, whole: retryIsWhole },
        "companion degenerate-answer repair rung produced a better answer");
        repaired = retryResult;
        repairedCalls = retryCalls;
      }
    } catch (retryError) {
      logger.warn({ err: retryError, stepCount: input.stepCount, rung: rung.label },
        "companion degenerate-answer repair rung failed; trying the next one");
    }
  }
  return { result: repaired, calls: repairedCalls, retried: true };
}
