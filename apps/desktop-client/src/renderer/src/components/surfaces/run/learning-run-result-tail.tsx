/**
 * 结算纸上最后那两块：逐条判定的折叠表，和「接下来」那一段。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件（`result || terminal ? … : …`），
 * 整体 70 个外部符号、不可切；但里面**有几块是自足的**——这两块各只依赖 2~3 个外部符号。
 *
 * ## 「接下来」那一段的三档措辞不是装饰
 *
 * 它回答的是**「我刚才那一下到底改变了什么」**，而答案取决于两件事：
 * 这一轮是不是「声明不会」，以及**复习安排有没有确认**。所以有四档而不是一档：
 * - `declared_unable` —— 说不会不扣任何东西，这条已排到最近的复习；
 * - `projection_pending` —— 返回后读取最新学习记录；不暗示练习改变了复习安排；
 * - `ready` —— 学习记录已保存，返回路径已就绪；
 * - 其余 —— 回去之后会接着真正要练的那一条。
 *
 * ⚠️ 三条不许动：
 *  1. **`returnContract` 为 null 时走最后那档**，不是「还在确认」——「还没读到」与
 *     「读到了、正在确认」是两件事，混起来会让用户以为系统出问题了。
 *  2. 折叠表**默认收起**：逐条判定是「我要自己核对」时才看的，主位不该是它。
 *  3. `data-verdict` 是 CSS 与测试的抓手（`data-verdict` 三个档各有配色）。
 */
import type { ReactElement } from "react";
import { facetLabels, verdictLabels } from "./learning-run-copy.tsx";

/** 一条判定。形状取自服务端那一份 rubric（`item.rubricItemId` / `verdict` / `userFacingReason`）。 */
type RubricRowV2 = {
  readonly rubricItemId: string;
  readonly facet: string;
  readonly verdict: string;
  readonly userFacingReason: string;
};

/**
 * 复习安排读到哪一档。
 *
 * 真实的返回体比「投影中 / 就绪」两档大——它还有 `run_active` 等分支。
 * **不要在这里另写一份窄的**：写窄了页面传进来就会报错，而报错指向的是这里。
 * 这里只收**这一段真正要读的那两档**，其余按 `unknown` 放行。
 */
type ReturnContractV1 = null | { readonly status: string };

export function LearningRunResultRubric(props: {
  readonly rows: readonly RubricRowV2[];
}): ReactElement {
  const { rows } = props;
  return (
    <details className="learning-run-result-rubric">
      <summary>查看逐条判定 · {rows.length} 条</summary>
      <ul>
        {rows.map((item) => (
          <li key={item.rubricItemId} data-verdict={item.verdict}>
            <span className="learning-run-result-rubric__head">
              {facetLabels[item.facet] ?? item.facet} · {verdictLabels[item.verdict] ?? item.verdict}
            </span>
            <p>{item.userFacingReason}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function LearningRunNextStep(props: {
  readonly nextChallengeLabel: string;
  readonly declaredUnable: boolean;
  readonly returnContract: ReturnContractV1;
}): ReactElement {
  const { nextChallengeLabel, declaredUnable, returnContract } = props;
  return (
    <section className="learning-run-next-step">
      <span>接下来</span>
      <strong>{nextChallengeLabel}</strong>
      <p>
        {declaredUnable
          ? "说不会不扣任何东西：这条已排到最近的复习。回研究册看懂之后再来一次，就当第一次见。"
          : returnContract?.status === "projection_pending"
            ? "返回后会显示最新的学习记录。"
            : returnContract?.status === "ready"
              ? "这次的学习记录已保存，可以沿着当前路径继续。"
              : "回去之后会接着你真正要练的那一条。"}
      </p>
    </section>
  );
}
