/**
 * 结算里的「缺口」只能来自真实判定，不能由「这次答的是哪个 facet」推定。
 *
 * 练习结算此前无条件写 `[task.intent]`，于是四条 rubric 全 covered 的作答会同时
 * 得到「还需补上：回忆」和四行「回忆 · 说清了」——同一屏自相矛盾
 * （原据 learning-companion/31-objective-flow-ui-review-2026-09-21.md，2026-09-29 已归档）§P1）。
 *
 * facet 保持字符串：调用方两侧（critic 与 structured）各自的枚举在这里同形。
 */
export function uncoveredFacets(
  rubricResults: readonly { readonly facet: string; readonly verdict: string }[],
): string[] {
  return [...new Set(
    rubricResults.filter((item) => ["partial", "missing", "contradicted"].includes(item.verdict)).map((item) => item.facet),
  )];
}
