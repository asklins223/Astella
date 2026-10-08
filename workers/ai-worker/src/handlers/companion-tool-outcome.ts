import { CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { TOOL_FAILURE_SAFE_SUMMARY } from "./companion-step-plan.ts";
import {
  CompanionToolBlockedError,
  CompanionToolError,
  CompanionToolNotExecutedError,
  CompanionToolUnavailableError,
} from "./companion-tool-result.ts";
import type { CompanionToolReportedStatus } from "@astella/shared";
import { isVisionGatedCompanionTool } from "@astella/shared";

export {
  CompanionToolBlockedError,
  CompanionToolError,
  CompanionToolNotExecutedError,
  CompanionToolUnavailableError,
};

export const TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY =
  "这项操作可能已经发生，但暂时没有确定回执；请先核对状态，不要重复操作。";

/** 从未开始执行时的兜底文案（参数没对上 / 屏障 / 取消 / 预算在派发前用完）。 */
export const TOOL_NOT_EXECUTED_SAFE_SUMMARY =
  "这一步没有执行：派发前就被拦下了（参数没对上、预算或时间用完、或这一轮已被取消）。";

/**
 * 可选能力不可用时的兜底文案（40b §3.2 `unavailable` 要求「指出实际影响及可用替代」）。
 *
 * 通用兜底只能说"做不到"——而那会让用户以为整个功能没了。真正写入这一档的地方
 * （读图的外发门禁）会带上具体影响与开关位置，这里只保证最坏情况下不落回空话。
 */
export const TOOL_UNAVAILABLE_SAFE_SUMMARY =
  "这项能力这一轮没有开：能做的部分仍然做了，做不到的部分请直接说看不了，不要猜。";

/**
 * 读图不可用时的**报告面**文案（40b §3.2 `unavailable` 的两条要求：影响 + 可用替代）。
 *
 * 与执行层那道 `VISION_EGRESS_DENIED_MESSAGE`（`companion-read-tools.ts`）是同一件事的两面：
 * 那一条是**执行器**对直接调用方的兜底，这一条是**账本与模型**看到的事实。
 * 两边都提到同一个开关名，所以用户在任一处看到的话都能对上；
 * 漂移由 `companion-tool-status-vocabulary.test.ts` 里那条对照用例守住。
 */
export const VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY =
  "这一轮看不了图片：「允许发送图片内容」没有开启，图片字节不能交给外部模型。"
  + "这篇的标题和正文仍然可以读；需要看图时先在设置里打开那个开关。";

/**
 * 这个工具这一轮是不是**能力不可用**（而不是"不获准"）。
 *
 * 纯函数放在这里而不是内联在 runtime 里，是因为它是 40b §3.2 那一档的**判据**：
 * 一旦内联，它就只会被"看起来对不对"驱动，而不是被"这一类状态到底指什么"驱动。
 *
 * 注意它**只**认外发政策这一种。权限档不足仍然是 `blocked`——那是"这条动作不获准"，
 * 与"这个能力没有"的用户含义、下一步都不同，混成一句话会让用户分不清该改权限还是该开开关。
 */
export function unavailableCompanionToolSummary(
  toolName: string,
  constraints: { visionEnabled?: boolean; webSearchEnabled?: boolean },
  execution: { searchLimitReached?: boolean } = {},
): string | null {
  if (toolName === "agent_web_search" && constraints.webSearchEnabled !== true) return "联网搜索已关闭或暂时不可用，请继续回答并说明未能联网核实。";
  if (toolName === "agent_web_search" && execution.searchLimitReached) return "本轮搜索次数已用完，这次没有执行。请根据已取得的网页资料回答；资料不足的部分直接说明，继续补搜需等下一轮。";
  return isVisionGatedCompanionTool(toolName) && constraints.visionEnabled !== true
    ? VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY
    : null;
}

/**
 * 40b §3.2 的**状态词表**（模型可见的表达面）。
 *
 * 直接取共享合同里的那个枚举而不是在这里再写一遍：两处各写一份时，
 * 词表迟早会走偏，而走偏的代价是**模型收到一个它不认识的失败**——
 * 它会照着"失败"去重调，那正是 §3.2 禁止的动作。
 */
export type CompanionToolFailureStatus = CompanionToolReportedStatus;

/**
 * 账本列（`companion_agent_tool_calls.status`）能落的词，与**报告给模型**的词不是同一个集合。
 *
 * ## 为什么要做这一次映射
 *
 * 数据库那一列有 CHECK 约束，值域停在 0331 迁移写下的八个词
 * （`apps/api/src/db/migrations/0331_companion_agent_tool_outcome_unknown.sql`）。
 * 往里写第六类的 `not_executed` / `unavailable` 会在**运行期**抛约束违例——
 * 那不是"多了一个词"，是整轮工具链断掉。
 *
 * 放宽那条约束属于迁移，而这一轮不动迁移。所以这里显式落一份映射：
 * 账本与 SSE 事件写**表达力最强的既有词**（`not_executed` → `failed`、
 * `unavailable` → `blocked`），精确词只给**模型**——它才是要据此决定下一步的那一方，
 * 也正是 40b §3.2 说的「模型可见的标记在上下文中」。账本那一行仍然带着说清原因的
 * `safeSummary`，所以 doctor 那边不会把「参数没对上」读成一次真实执行。
 *
 * 顺带说明为什么 SSE 事件**不**带精确词：客户端 `companion-agent-nodes.ts` 的
 * `TOOL_STATE` 只认那八个词，收到不认识的一律显示「工具状态无法识别，操作结果待核对」。
 * 让用户看到那句比让他看到 `failed` 更糟，所以这一面先不动，等客户端给出确定性文案。
 *
 * 迁移与客户端都补上之后，这里连同 `companionAgentToolStatusSchema` 一起放宽即可，
 * 映射函数是唯一的收敛点。
 */
/**
 * Keep known-safe domain failures distinct from errors that may follow a write.
 *
 * `status` 现在**同时**是账本/SSE 与模型侧要用的那个词：0349 把 CHECK 放宽、
 * 客户端 `TOOL_STATE` 补了两个条目之后，此处曾存在的降级映射
 * （not_executed→failed、unavailable→blocked）已经删除。
 *
 * 删它的理由不是"能删"，是**它本来就是错的**：把 unavailable 写成 blocked，
 * 用户看到的是「被拒绝」，而实际是「这一轮没有这个能力，且有替代路径」。
 */
export function classifyCompanionToolFailure(
  error: unknown,
  riskClass: string,
  executionStarted: boolean,
): { status: CompanionToolFailureStatus; safeSummary: string } {
  if (error instanceof CompanionToolBlockedError) {
    return { status: "blocked", safeSummary: error.message.slice(0, 240) };
  }
  // 这两级必须排在下面的 `CompanionToolError` 之前：它们**继承**自它，
  // 顺序一颠倒就永远只会读到 failed，等于把 40b §3.2 的两类重新吞掉。
  if (error instanceof CompanionToolUnavailableError) {
    return { status: "unavailable", safeSummary: error.message.slice(0, 240) };
  }
  if (error instanceof CompanionToolNotExecutedError) {
    return { status: "not_executed", safeSummary: error.message.slice(0, 240) };
  }
  if (error instanceof CompanionToolError) {
    return { status: "failed", safeSummary: error.message.slice(0, 240) };
  }
  // 压根没进执行体（屏障/取消/预算在派发前耗尽）就是 40b §3.2 说的
  // 「从未开始执行」。原来这里落 failed，而 failed 在 doctor 与页面上会被读成
  // 「跑过了、失败了」——用户据此重试一次，账本里就多出一条假执行。
  if (!executionStarted) {
    return { status: "not_executed", safeSummary: TOOL_NOT_EXECUTED_SAFE_SUMMARY };
  }
  if (error instanceof CompanionAgentBudgetExceededError || riskClass === "read") {
    return { status: "failed", safeSummary: TOOL_FAILURE_SAFE_SUMMARY };
  }
  return { status: "outcome_unknown", safeSummary: TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY };
}
