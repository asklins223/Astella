/**
 * 「这条边到底是哪一种语义关系」的**唯一**读法（39 §11.3）。
 *
 * ## 为什么必须是这一个函数
 *
 * 拓扑那一层把语义关系投影成边时，`kind` 只有 `relates_to`（总称："这两个目标之间
 * 有一条语义关系"），**具体是哪一种在 `reasonCodes[0]`**。于是同一件事有三个地方
 * 各自推导了一遍：写侧（客户端 `graph-surface`）、层二读侧（`note-deepening-service`）、
 * 层三读侧（`personal-relation-decision-service`）。
 *
 * 代价已经付过一次：读侧拿 `edge.kind` 去查排除表，而写侧按 `reasonCodes` 里的具体
 * 那一档写进库。键永远对不上——用户按了「确认」，接口回 200、行写进去了，重新读回来
 * 那条边**仍然是"系统猜的一条"**。结构上就问不到，不是偶发。
 *
 * 三个地方必须问出同一个答案，否则表态与展示就是两套世界。
 */

/** 语义关系的四档。`relates_to` 是兜底（确实只是"有关系"，说不出是哪一种）。 */
export const SEMANTIC_RELATION_VALUES_V2 = [
  "prerequisite",
  "explains",
  "contrasts",
  "relates_to",
] as const;

export type SemanticRelationV2 = (typeof SEMANTIC_RELATION_VALUES_V2)[number];

const SEMANTIC_RELATION_SET: ReadonlySet<string> = new Set(SEMANTIC_RELATION_VALUES_V2);

/**
 * 从一条边的 `reasonCodes` 里取出它真正是的那一种语义关系。
 *
 * 取**第一个**命中的；一个都没有（真正的"有关系但说不出是哪一种"）就落到
 * `relates_to`——那正是这一档存在的意义，它不是"不知道"，是"就是泛泛有关系"。
 */
export function semanticRelationOfV2(reasonCodes: readonly unknown[] | null | undefined): SemanticRelationV2 {
  if (!reasonCodes) return "relates_to";
  for (const code of reasonCodes) {
    if (typeof code === "string" && SEMANTIC_RELATION_SET.has(code)) return code as SemanticRelationV2;
  }
  return "relates_to";
}
