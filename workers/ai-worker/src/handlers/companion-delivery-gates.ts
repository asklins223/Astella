/**
 * 交付闸的后果判定：一道闸判错之后，这一整轮该**作废**还是该**降级交付**。
 *
 * 形状是 2026-10-16 定下来的：**补正按判据，销毁按权威事实。**
 * 判据（这句话是不是半截、引用对不对得上原文、点名的动作有没有回执）一律留在调用方，
 * 一个字不改；这里只回答后果。三处调用点见 `companion-agent-runtime.ts` 的
 * `output_truncated` / `unverified_quote` / `action_not_executed`。
 *
 * 为什么要有这个模块：这三道闸原来是各自 `throw` 的三份复制品，每加一道就多一处
 * "一次判错吃掉整条消息"。用户口径是「我做的是 agent 不是工作流，要允许 AI 犯错几次」
 * （见 feedback-no-hard-output-caps），而 2026-10-16 生产实测到两起代价：
 *   · run `fb2da98f`：三篇笔记全部 `succeeded`，因为分类器点名的是 `agent_start_goal`，
 *     12 步 8 分 22 秒的正文一个字都不许发，界面上只剩「这一轮没能说完」。
 *   · run `df40b8a9`：用户发「哈哈哈」，她回了一个 `[neutral]`，被判 `INTERNAL_ERROR`。
 * 判据本身两次都没错——错的是后果。所以这里把"销毁"单独拿出来，让它必须引用一个
 * 权威事实（本轮是否真的落下过写回执），而不是跟着判据一起复制三份。
 *
 * 权威事实只有一个来源：`companionWriteToolNames(definitions)` 配
 * `companionActionResultRecorded(messages, …)`。不许换成模型的说法、不许换成词表、
 * 也不许换成时间或条数上限——那都是又一次猜测。
 */

export type CompanionDeliveryGate = "output_truncated" | "unverified_quote" | "action_not_executed";

/** 绕过销毁时写进步骤记录里的错误码：痕迹要留在**这一步**，不能整轮一起抹掉。 */
const GATE_STEP_ERROR_CODE: Record<CompanionDeliveryGate, string> = {
  output_truncated: "AGENT_BUDGET_EXCEEDED",
  unverified_quote: "UNVERIFIED_QUOTE",
  action_not_executed: "ACTION_NOT_EXECUTED",
};

/** 绕过销毁时的日志文案。静默放行会让"她这次到底有没有被闸过"无法复盘。 */
const GATE_BYPASS_NOTE: Record<CompanionDeliveryGate, string> = {
  output_truncated: "companion answer truncated but this run has landed writes; delivering instead of discarding",
  unverified_quote: "companion quote unverified but this run has landed writes; delivering instead of discarding",
  action_not_executed: "requested action has no receipt but this run has landed writes; delivering instead of discarding",
};

export interface CompanionDeliveryGateVerdict {
  /** false = 照旧作废整轮（本轮确实没有任何落库成果）。 */
  readonly destroysTurn: boolean;
  /** 不销毁时写进步骤记录的错误码；销毁时由调用方自己决定抛什么。 */
  readonly stepErrorCode: string;
  readonly bypassNote: string;
}

/**
 * 这道闸要不要把整条消息作废。
 *
 * `landedWrites` 必须是权威事实：本轮已经落下写回执。有了它就不销毁——判错的代价
 * 降成"这一步留个 failed 痕迹"，用户仍然能看到她已经做成的事。
 */
export function judgeCompanionDeliveryGate(input: {
  gate: CompanionDeliveryGate;
  landedWrites: boolean;
}): CompanionDeliveryGateVerdict {
  return {
    destroysTurn: !input.landedWrites,
    stepErrorCode: GATE_STEP_ERROR_CODE[input.gate],
    bypassNote: GATE_BYPASS_NOTE[input.gate],
  };
}

/**
 * 一次 steer 到底是为什么补的。
 *
 * 从 `companion-agent-runtime.ts` 搬出（2026-10-16，那条 1500 行阈值）。原来这段
 * 三元链住在 `logger.warn` 的参数里，17 行——它是纯判定，不是日志格式。
 *
 * `by` 是唯一的区分口径（39b §9.6）：正文那句曾经写死成 "answered an action request"，
 * 于是 `unverified-numbers`（编了没出处的数）和 `promise-shape`（承诺了没做事）
 * 也被读成"动作请求"，按日志归因会归错。
 */
export function companionSteerCause(input: {
  correctQuote?: unknown;
  unverifiedClaims: readonly unknown[];
  unverifiedQuotes: readonly unknown[];
  lookupClaim: boolean;
  nothingDueClaim: boolean;
  userAskedForAction: boolean;
}): "unverified-quotes" | "unverified-numbers" | "claimed-nothing-due" | "claimed-lookup"
  | "action-request" | "promise-shape" {
  if (input.correctQuote) return "unverified-quotes";
  if (input.unverifiedClaims.length > 0) return "unverified-numbers";
  if (input.unverifiedQuotes.length > 0) return "unverified-quotes";
  if (input.lookupClaim) return input.nothingDueClaim ? "claimed-nothing-due" : "claimed-lookup";
  return input.userAskedForAction ? "action-request" : "promise-shape";
}
