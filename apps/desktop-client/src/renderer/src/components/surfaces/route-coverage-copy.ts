/**
 * 跨轮聚合在屏上的那几句话（39d W4-5 ③；PRD §4.4、§5.6）。
 *
 * **为什么单独一份**：§4.4 要屏上把四种"没走到"说成**四句不同的话**——
 * 「你跳过了」「材料自己矛盾」「我们判不了」「还没练过」——而它们背后是四种
 * 处境。把它们写在渲染层就会有一天首页说"还差着"、记录页说"没覆盖"、
 * 而屏上第三处又说"跳过"，读的人会以为系统自己都不知道发生了什么。
 *
 * 一条纪律跟着 §4.4：**任何一档都不许被说成「你不会」**（§4.1「不将沉默与跳过
 * 记作能力不足」）。`declared_unable`（用户明说不会）落在「还差着」那一档，
 * 而「系统判不了」落在自己那一档——两句对用户完全不同的话。
 */

/** 一档状态在屏上的那一句（短签，摆在册页的每一格旁边）。 */
export const ROUTE_QUESTION_STATE_COPY_V1 = {
  learned_independently: { label: "独立做过", tone: "green" },
  learned_with_help: { label: "借助完成的", tone: "mint" },
  still_needs_help: { label: "还差着", tone: "peach" },
  help_condition_unknown: { label: "帮助条件没法确认", tone: "plain" },
  not_assessable: { label: "我们判不了", tone: "plain" },
  skipped_by_user: { label: "你跳过了", tone: "plain" },
  blocked_by_material_conflict: { label: "材料自己矛盾", tone: "red" },
  not_attempted: { label: "还没练过", tone: "plain" },
  in_progress: { label: "正在进行", tone: "mint" },
} as const satisfies Record<string, { label: string; tone: "green" | "mint" | "peach" | "plain" | "red" }>;

/**
 * 整条路线那句结论（§4.4 的门槛）。
 *
 * 四个档各有一句，**没有**"完成度 80%"那类说法：§4.1 明写目录不可靠时不承诺
 * 完整覆盖，而一个百分比会把"我们没敢承诺"读成"我们承诺了八成"。
 *
 * `assistedCount` 那一格是 §4.4「借助完成另外列出」：已走完时要说清其中几个是
 * 借着帮助完成的，**而不是**笼统一句"已走完"让读者以为每一个都是独立做的。
 */
export function routeVerdictCopyV1(input: {
  kind: "no_questions" | "route_complete" | "route_complete_within_adjusted_scope" | "route_incomplete";
  totalCount: number;
  coveredCount: number;
  assistedCount: number;
  scopeAdjustmentReason: string | null;
  /** 按状态分组后的条数，键是 `ROUTE_QUESTION_STATE_COPY_V1` 的档位。 */
  uncoveredByState: Partial<Record<keyof typeof ROUTE_QUESTION_STATE_COPY_V1, number>>;
}): string {
  const { kind, totalCount, coveredCount, assistedCount, scopeAdjustmentReason, uncoveredByState } = input;
  if (kind === "no_questions") {
    // §4.1：目录还不可靠时"不承诺完整覆盖"，所以这一句**不是**"还没开始"，而是
    // "现在还不承诺覆盖"——后者告诉读者这不是"她没学"，是"我们还没整理出路线"。
    return "这一篇还没有整理出核心路线，所以现在不谈走完没走完。";
  }
  const assistedTail = assistedCount > 0 ? `其中 ${assistedCount} 个是借着帮助完成的。` : "";
  if (kind === "route_complete") {
    return `纳入的 ${totalCount} 个核心问题都学过一遍了。${assistedTail}`;
  }
  if (kind === "route_complete_within_adjusted_scope") {
    // §4.4 末句：缩小范围时**注明按调整后的范围完成**，并把理由念出来。
    return `按后来调整过的范围完成了：${scopeAdjustmentReason ?? "范围被缩小过"}。${assistedTail}`;
  }
  const parts = (Object.keys(uncoveredByState) as Array<keyof typeof ROUTE_QUESTION_STATE_COPY_V1>)
    .filter((state) => (uncoveredByState[state] ?? 0) > 0)
    .map((state) => `${uncoveredByState[state]} 个${ROUTE_QUESTION_STATE_COPY_V1[state].label}`);
  return `纳入的 ${totalCount} 个核心问题里，${coveredCount} 个学过，${parts.join("、") || "还有没走到的"}。`;
}
