/**
 * 生成学习卡那一档的**选项形状、候选表与会话间的默认值**。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * `GenerationOptions`、几张候选表（`STRATEGIES` / `LEARNING_GOALS` /
 * `DETAIL_THRESHOLDS` / 那组反馈理由）与那份**记忆在会话间的默认值**原先都是页面里的
 * 模块级声明。`generation-setup` 那个对话框要用其中几张表和这个形状，可它在
 * `notebook-surface.tsx` 之外——于是组件只能自己重新声明一遍类型，或者把 `unknown`
 * 塞过去。**那正是「切不动」的一个根因**：不是依赖多，是形状没有名字、
 * 也不在一个可引用的地方。
 *
 * 抽出来之后对话框直接 `import { useEffect, useState } from "react";
import`，页面也直接 `import`，两边不再各持一份。
 *
 * ⚠️ `persistedGenerationOptions` 是**模块级可变状态**（上一次会话记住的选择）。
 * 它跟着搬过来了，行为不变；下一次真要动它，得先想清楚「谁负责在设置里清掉它」。
 */
import { useEffect, useState } from "react";
import type {
  DesktopCardDetailThresholdV2,
  DesktopCardGenerationFeedbackReasonV2,
  DesktopCardLearningGoalV2,
  DesktopCardStrategyV2,
} from "@astella/shared/card-generation-desktop-contracts";

export type GenerationOptions = {
  readonly learningGoal: DesktopCardLearningGoalV2;
  readonly detailThreshold: DesktopCardDetailThresholdV2;
  readonly hardMaxCards: number;
  readonly preferredStrategies: readonly DesktopCardStrategyV2[];
};

/**
 * 题型是「系统按知识形态分配」的候选集合，不是优先级：勾掉某种即表示不要它，
 * 全勾即完全交给 planner 决定（planner-service.allocateStrategies）。
 * 默认值必须是全集——曾经默认 ["recall","why"] 时，即便题型真正生效，
 * 事实类知识也会被压成清一色的回忆题。
 */
export const STRATEGIES: readonly { readonly value: DesktopCardStrategyV2; readonly label: string }[] = [
  { value: "recall", label: "主动回忆" },
  { value: "cloze", label: "关键补全" },
  { value: "compare", label: "对比辨析" },
  { value: "sequence", label: "顺序重建" },
  { value: "why", label: "机制解释" },
  { value: "boundary", label: "边界判断" },
  { value: "application", label: "情境应用" },
];

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  learningGoal: "understand",
  detailThreshold: "balanced",
  hardMaxCards: 8,
  preferredStrategies: STRATEGIES.map((item) => item.value),
};

/** Session scope, like the library's view choice: a page visit keeps the writer's pick. */
export let persistedGenerationOptions: GenerationOptions = DEFAULT_GENERATION_OPTIONS;

export const LEARNING_GOALS: readonly { readonly value: DesktopCardLearningGoalV2; readonly label: string }[] = [
  { value: "remember", label: "记住" },
  { value: "understand", label: "理解" },
  { value: "apply", label: "应用" },
  { value: "exam", label: "应试" },
];

export const DETAIL_THRESHOLDS: readonly { readonly value: DesktopCardDetailThresholdV2; readonly label: string }[] = [
  { value: "concise", label: "精简" },
  { value: "balanced", label: "均衡" },
  { value: "deep", label: "深入" },
];

/**
 * 卡片上限**只给真正到得了的档**。
 *
 * Worker 那一侧有硬顶：`card-generation-v3/handler.ts` 把客户端的 `hardMaxCards`
 * 收进 `Math.min(8, …)`，那是激活预算的实数（超出的原子由 planner 记
 * `omit_over_budget`，不进候选）。这里原来给到 12，于是用户选「12 张」、请求里
 * 也真的发了 12，**而整条流程没有任何一处说它只可能出 8 张**——一个给不了的选项。
 * 契约层（`card-generation-v2-contracts`）允许 50，那是服务端给脚本用的，
 * 与「屏上摆几颗 chip」不是同一件事。
 */
export const CARD_LIMITS = [4, 8] as const;

/** Statuses where the run has stopped; only those can be answered with feedback. */
export const FINISHED_RUN_STATUSES = new Set(["activated", "closed_without_activation", "cancelled", "failed", "stale"]);

export const FEEDBACK_REASONS: readonly { readonly value: DesktopCardGenerationFeedbackReasonV2; readonly label: string }[] = [
  { value: "too_many", label: "卡片太多" },
  { value: "missing_key_objective", label: "漏掉关键目标" },
  { value: "surface_paraphrase", label: "只是换了个说法" },
  { value: "wrong_learning_goal", label: "学习卡不符" },
  { value: "duplicate_existing_card", label: "与已有卡片重复" },
  { value: "not_worth_reviewing", label: "不值得复习" },
];

export function generationOptionSummary(options: GenerationOptions): string {
  const goal = LEARNING_GOALS.find((item) => item.value === options.learningGoal)?.label ?? options.learningGoal;
  const detail = DETAIL_THRESHOLDS.find((item) => item.value === options.detailThreshold)?.label ?? options.detailThreshold;
  const strategies = options.preferredStrategies
    .map((value) => STRATEGIES.find((item) => item.value === value)?.label ?? value)
    .join("+");
  return `${goal} · ${detail} · 最多 ${options.hardMaxCards} 张 · ${strategies}`;
}

/**
 * 记住这一档选择，供下一个会话用。
 *
 * 为什么要包一层函数而不是让页面直接赋值：`persistedGenerationOptions` 现在是**导出
 * 的绑定**，ES 模块的导入是只读的，页面再写它 typecheck 会红（TS2632）。这层封装
 * 让「谁能改这份会话记忆」只有一处。
 */
export function rememberGenerationOptions(next: GenerationOptions): void {
  persistedGenerationOptions = next;
}

/**
 * 生成设置那两格状态，以及**会话记忆**的读与写。
 *
 * 2026-09-29 从 `notebook-surface.tsx` 收进来：那两个 `useState` 散在页面里，而它们
 * 依赖的 `persistedGenerationOptions` 本来就在这个模块——**状态与它的持久化分居两处**
 * 是这一族最容易出的错（改了一份忘了另一份，关掉再打开就退回旧档）。
 */
export function useNotebookGenerationOptions() {
  const [options, setOptions] = useState<GenerationOptions>(persistedGenerationOptions);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    persistedGenerationOptions = options;
  }, [options]);
  return { options, setOptions, optionsOpen, setOptionsOpen };
}
