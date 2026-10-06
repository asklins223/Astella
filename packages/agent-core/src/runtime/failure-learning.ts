import type { AgentOperationStatusV1, AgentRunStatusV1 } from "@astella/shared/agent-contracts";

/**
 * 方案 44 §6.2：失败运行也能贡献可核对经验——但**不能凭一次失败把能力永久判死**。
 *
 * ## 为什么要分类而不是「失败了就记一条教训」
 *
 * 三种「没做成」的下一步完全不同，混成一条规则会把临时故障写成永久结论：
 *   - **临时供应商故障**：这次是网络/限流/超时。它不是关于这套做法的任何知识，
 *     沉淀成规则等于把一次抖动钉成「这招不行」。
 *   - **结果待核对**（outcome_unknown）：副作用可能已经发生但没有确定回执。它既不是
 *     成功也不是失败，规则只能记「要先核对」，绝不能写成完成或没做。
 *   - **确定不适用**：这条路在当前材料/条件下走不通。这才是真正值得留下的：
 *     它带**适用条件**与**替代路径**，而不是一句「不行」。
 *
 * 用户取消不是失败，也不产生规则——那是他改了主意。
 */

export type AgentFailureClassV1 =
  | "transient_provider"
  | "outcome_unknown"
  | "not_applicable"
  | "cancelled"
  | "incomplete"
  | "unclassified";

export interface AgentFailureOperationV1 {
  status: AgentOperationStatusV1;
  capability: string;
  error: string | null;
}

export interface AgentFailureClassificationV1 {
  failureClass: AgentFailureClassV1;
  /** 可以写进方法例外的那一句；不成规则时为空。 */
  note: string;
  /**
   * 这件事是否值得沉淀成一条做法。
   *
   * 临时故障与用户取消一律 false——不是「这次不值得记」，而是「记下来就是错的」。
   */
  contributesRule: boolean;
  /** 这次最该被引用的那一条操作（失败/待核对的那一条），没有则为 null。 */
  citedOperation: AgentFailureOperationV1 | null;
  /**
   * 认识状态：一次失败只能支持**暂定**，除非它是确定不适用这种可核对的条件。
   * 这条直接决定候选能不能被采用（§6.2「模型推断仍保留其认识状态」）。
   */
  epistemicStatus: "tentative" | "supported";
}

/** 临时故障的特征。与 `non-retryable-errors` 的判据方向相反：这里是**可重试**那一类。 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(?:429|408|5\d\d)\b/,
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i,
  /rate.?limit/i,
  /temporar(?:ily|y) unavailable|service unavailable/i,
  /aborted|abort/i,
];

function looksTransient(error: string | null): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some(pattern => pattern.test(error));
}

/**
 * 判定一次没跑成的运行能贡献什么。
 *
 * 只看 status 与 error，不看模型自评——§6.2：「模型自评、沉默与提交成功不自动记质量正反馈」。
 */
export function classifyAgentRunFailure(input: {
  runStatus: AgentRunStatusV1;
  operations: readonly AgentFailureOperationV1[];
}): AgentFailureClassificationV1 {
  const { runStatus, operations } = input;
  const none: AgentFailureClassificationV1 = {
    failureClass: "cancelled", note: "", contributesRule: false, citedOperation: null,
    epistemicStatus: "tentative",
  };
  if (runStatus === "cancelled" || operations.some(operation => operation.status === "cancelled")) {
    return { ...none, note: "用户中途改了主意，这不是一次失败，不构成任何做法。" };
  }

  // 待核对优先于失败：副作用可能已经发生，写成「没做成」是错的（40b §3.2）。
  const unknown = operations.find(operation => operation.status === "outcome_unknown");
  if (unknown) {
    return {
      failureClass: "outcome_unknown",
      note: `这一步的结果待核对（${unknown.capability}）：副作用可能已经发生但没有确定回执，`
        + "先核对再决定重做还是继续，不要直接说成完成或没做。",
      contributesRule: true,
      citedOperation: unknown,
      // 待核对本身是可核对的事实，但仍不足以把这条路判成「不行」。
      epistemicStatus: "tentative",
    };
  }

  const failed = operations.filter(operation => operation.status === "failed");
  if (failed.length === 0) {
    return {
      failureClass: "incomplete",
      note: "这次没有走到确定交付，现有步骤不足以整理成做法。",
      contributesRule: false,
      citedOperation: null,
      epistemicStatus: "tentative",
    };
  }

  // 全部失败都是临时故障 → 不成规则。只要有**一条**不是临时的，它就值得留下。
  const substantive = failed.find(operation => !looksTransient(operation.error));
  if (!substantive) {
    const first = failed[0]!;
    return {
      failureClass: "transient_provider",
      note: `这次是临时故障（${first.capability}），不是这套做法本身的问题；不要因此停用相关能力。`,
      contributesRule: false,
      citedOperation: first,
      epistemicStatus: "tentative",
    };
  }

  return {
    failureClass: "not_applicable",
    note: `${substantive.capability} 在这次的材料或条件下没有做成`
      + `${substantive.error ? `（${substantive.error.slice(0, 120)}）` : ""}：`
      + "记下适用条件，下次先核对条件再走这条路；这不是「这项能力不行」。",
    contributesRule: true,
    citedOperation: substantive,
    // 具体条件 + 具体错误是可核对的事实，可以支撑一条有边界的做法。
    epistemicStatus: substantive.error ? "supported" : "tentative",
  };
}

export type AgentMethodProposalModeV1 = "success" | "failure_candidate";

export interface AgentMethodProposalPlanV1 {
  /** 这次运行能不能整理出一条做法。 */
  allowed: boolean;
  /** 不允许时给用户看的原因（已经是可读的一句话）。 */
  reason: string;
  mode: AgentMethodProposalModeV1;
  /** 失败贡献的那条例外；成功路径为 null。 */
  failureNote: string | null;
  epistemicStatus: "tentative" | "supported";
}

/**
 * 组织一次「从这次合作整理做法」。
 *
 * 抽成纯函数是因为这条判据有两处容易写错、而写错了都不会报错：
 *   1. 把 `status !== "completed"` 当成「不能整理」——于是失败运行一个字都留不下，
 *      而「这次为什么没做成、替代路径是什么」恰恰最该被记住（§6.2）；
 *   2. 反过来把任何没跑成都收下——于是临时故障与用户取消也会变成规则。
 *
 * 它同时决定**用哪种形态**写：有成功步骤就照常提候选；只有失败没有成功步骤时，
 * 写成一条带失败例外的待核对候选——步骤仍然只能来自真发生过的能力调用。
 */
export function planAgentMethodProposal(input: {
  runStatus: AgentRunStatusV1;
  operations: readonly AgentFailureOperationV1[];
  /** 其中 status === "succeeded" 的那些（由调用方筛好，避免这里再猜一次口径）。 */
  succeededCapabilities: readonly string[];
}): AgentMethodProposalPlanV1 {
  if (input.runStatus === "completed") {
    if (input.succeededCapabilities.length === 0) {
      return {
        allowed: false,
        reason: "这次没有可核对的执行步骤，暂时不能整理成做事方法。",
        mode: "success", failureNote: null, epistemicStatus: "tentative",
      };
    }
    return { allowed: true, reason: "", mode: "success", failureNote: null, epistemicStatus: "supported" };
  }
  const failure = classifyAgentRunFailure({ runStatus: input.runStatus, operations: input.operations });
  if (!failure.contributesRule) {
    return {
      allowed: false, reason: failure.note, mode: "failure_candidate",
      failureNote: null, epistemicStatus: failure.epistemicStatus,
    };
  }
  if (input.succeededCapabilities.length === 0 && input.operations.length === 0) {
    return {
      allowed: false,
      reason: "这次没有可核对的执行步骤，暂时不能整理成做事方法。",
      mode: "failure_candidate", failureNote: null, epistemicStatus: failure.epistemicStatus,
    };
  }
  return {
    allowed: true,
    reason: "",
    // 有成功步骤时照常走成功形态：失败只是附加的一条适用条件。
    mode: input.succeededCapabilities.length > 0 ? "success" : "failure_candidate",
    failureNote: failure.note,
    epistemicStatus: input.succeededCapabilities.length > 0 ? "supported" : failure.epistemicStatus,
  };
}
