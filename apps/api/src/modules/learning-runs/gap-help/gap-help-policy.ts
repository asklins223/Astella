/**
 * 缺口帮助停止规则（39d W4-6 刀四；PRD §5.3 那句「同一关键缺口**连续两次**帮助后
 * 仍没有改善 ⇒ 停止自动加题，呈现换解释／补前置／回材料核对／先结束，由用户选」）。
 *
 * 两条形状上的硬约束：
 *
 *  1. **判据是纯函数**（设计件 §5 明写）：输入是"这条缺口上发生过什么"的时间线
 *     （一次帮助 / 一次结论），输出是"该不该停"。DB、计数、拦截点都在调用方那一侧，
 *     这一份只做决定——所以它可被单测钉死、可被变异验。
 *  2. **「两次」这个数不在逻辑里**：它是 §18.4 的试用前冻结项（产品参数，不是物理常数），
 *     由 `gapHelpStopThresholdV1()` 签发（env 可覆盖），逻辑只拿它比大小。
 *
 * 为什么"改善"要分三类而不是两类：`not_assessable`（判不了）既不是改善、也不是"没弄通"
 * ——把它算成"没改善"就等于替系统自己的无能去下用户有缺口的结论（§3.2 那条老规矩：
 * 判不了不是没弄通）。所以它单独成"unknown"一类：**不重置计数**（这一次确实没带来
 * 改善的证据），但**也不因此说用户有缺口**。
 */
import { learningRunOutcomeSchema } from "@astella/shared/learning-run-contracts";

export type LearningRunOutcomeNameV1 = (typeof learningRunOutcomeSchema)["_output"];

/** 这条缺口上发生过的一件事（时间升序喂进来）。 */
export type GapHelpTimelineEntryV1 =
  | { readonly kind: "help" }
  | { readonly kind: "outcome"; readonly outcome: LearningRunOutcomeNameV1 };

/** 结论对"有没有改善"意味着什么。 */
export type GapOutcomeClassV1 = "improved" | "not_improved" | "unknown";

/**
 * 七档结论各自属于哪一类。**一档也不许漏**：漏一档就会让它静默落进某个默认类，
 * 而"这次算不算改善"是这套规则的分母。
 *
 *  - `demonstrated`：做出来了 ⇒ 改善（计数清零）；
 *  - `partial` / `needs_repair`：做出了一部分／还有要补的 ⇒ 明说的没有改善；
 *  - `not_assessable`：判不了 ⇒ 不知道（见文件头）；
 *  - `practice_completed`：练完了但没有掌握证据 ⇒ 不知道（练习本来就不判分，§4.2）；
 *  - `skipped` / `declared_unable`：跳过了／说没想起来 ⇒ 不知道
 *    ——"说没想起来"是用户的诚实自述，不是系统判出的缺口。
 */
export const GAP_OUTCOME_CLASS_V1: Record<LearningRunOutcomeNameV1, GapOutcomeClassV1> = {
  demonstrated: "improved",
  partial: "not_improved",
  needs_repair: "not_improved",
  not_assessable: "unknown",
  practice_completed: "unknown",
  skipped: "unknown",
  declared_unable: "unknown",
};

export function classifyGapOutcomeV1(outcome: LearningRunOutcomeNameV1 | null | undefined): GapOutcomeClassV1 | null {
  if (!outcome) return null;
  const parsed = learningRunOutcomeSchema.safeParse(outcome);
  if (!parsed.success) return null;
  return GAP_OUTCOME_CLASS_V1[parsed.data];
}

/**
 * 「连续帮助次数」：从时间线**从后往前**数，数到最近一次"改善"为止。
 *
 * 没改善的两类（`not_improved` / `unknown`）都**不重置**计数——它们只是"这一次没带来
 * 改善"，而这条规则问的正是"帮了几次、还是没改善"。带一条改善进来（`demonstrated`）
 * 就从那里清零：那之后的帮助才开始重新累计。
 */
export function consecutiveHelpCountWithoutImprovementV1(
  timeline: readonly GapHelpTimelineEntryV1[],
): number {
  let count = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (!entry) continue;
    if (entry.kind === "help") {
      count += 1;
      continue;
    }
    if (classifyGapOutcomeV1(entry.outcome) === "improved") break;
  }
  return count;
}

/**
 * 该不该停（停止自动加题）。
 *
 * `stopped = 连续帮助次数 >= 阈值 **且** 最近一次结论不是"改善"`。
 *
 * 最后一格为什么是"不是改善"而不是"是没改善"：到了阈值又没有任何改善的证据时，
 * 该做的是**把选择权交回用户**（呈现那四档），而不是继续默默加题。其中：
 *  - `not_improved`：明说的没有改善 ⇒ 停；
 *  - `unknown`：没有证据 ⇒ 也停（停的是"自动加题"这件事，不是对用户下判断；
 *    话术里不许出现"你没有改善"）。
 *
 * 没有任何结论（`lastOutcome === null`）时同样按"没有改善的证据"算——两次帮助之间
 * 一次结论都没产生，继续加题就是拿用户的时间赌。
 */
export function shouldStopAutoAddingQuestionsV1(input: {
  readonly timeline: readonly GapHelpTimelineEntryV1[];
  readonly threshold: number;
}): { readonly stopped: boolean; readonly consecutiveHelpCount: number } {
  const consecutiveHelpCount = consecutiveHelpCountWithoutImprovementV1(input.timeline);
  const lastOutcome = [...input.timeline].reverse().find((entry) => entry.kind === "outcome");
  const lastClass = lastOutcome && lastOutcome.kind === "outcome"
    ? classifyGapOutcomeV1(lastOutcome.outcome)
    : null;
  const stopped = consecutiveHelpCount >= input.threshold && lastClass !== "improved";
  return { stopped, consecutiveHelpCount };
}

// ─── 冻结值（§18.4）────────────────────────────────────────────────────

/**
 * 「两次」的起点值（PRD §5.3 的"连续两次"）。它是**产品参数**、试用前冻结项：
 * 环境变量是给那一次冻结留的口，不是界面设置项。坏值回落默认并留一条**可见**的
 * 运行期痕迹（返不回去的那一类），而不是让"停不下来"变成静默行为。
 */
export const DEFAULT_GAP_HELP_STOP_THRESHOLD_V1 = 2;

const ENV_GAP_HELP_STOP_THRESHOLD = "NOTE_ROUND_GAP_HELP_STOP_THRESHOLD";

export function gapHelpStopThresholdV1(): number {
  const raw = process.env[ENV_GAP_HELP_STOP_THRESHOLD]?.trim();
  if (!raw) return DEFAULT_GAP_HELP_STOP_THRESHOLD_V1;
  const parsed = Number(raw);
  // `1` 是合法值（"帮一次就停"），只有非正整数才按坏值处理。
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_GAP_HELP_STOP_THRESHOLD_V1;
  return parsed;
}

/** 触发之后摆给用户的那四档（PRD §5.3 逐字；顺序就是呈现顺序）。 */
export const GAP_HELP_STOP_OPTIONS_V1 = [
  "switch_explanation",
  "add_prerequisite",
  "back_to_material",
  "end_round",
] as const;
export type GapHelpStopOptionV1 = (typeof GAP_HELP_STOP_OPTIONS_V1)[number];
