/**
 * 「本轮学习 · 一次尝试」那张收据。
 *
 * ## 为什么它和结果板是两个东西
 *
 * 结算屏有**两张纸**，不要合：
 * - 这一张 —— 走**本轮**（`note_round`）的返回目标时给。它比结果板短得多：
 *   只说「这次留下了什么」和「回到本轮后可以对照讲解、再试一次」。
 * - `learning-run-result-board` —— 走学习卡/复习队列时给，带印章、伴星回话、
 *   逐条判定与证据带。
 *
 * 两条路的内容差得很远（一张说「回到本轮」，一张说「复习记录已就绪」），
 * 合成一张纸会让两边的措辞互相污染——那正是 §9.1「不制造用户没做过的选择」的反面。
 *
 * ## 三条不许动
 *
 *  1. **`data-outcome` 那一列**是 CSS 与测试的抓手；没有它，「这次先标记为需要帮助」
 *     和「这次尝试已记录」在屏上分不出来。
 *  2. **那唯一的主动作**写的是「回到本轮学习」并带 `reflectionRoundId`——
 *     少传那个 id，回去之后接不上是哪一轮（这一条由
 *     `renderer-primary-action-guard` 盯写法）。
 *  3. `declared_unable` 时那句「你标记了暂时不会；这一道还没有形成独立使用的证据」
 *     **不能省略**：省略就变成一次没有反馈的提交。
 */
import type { ReactElement, RefObject } from "react";
import { ArrowLeft } from "lucide-react";

/** 一行的 `returnTarget`，只取本组件要用的两格。 */
export type NoteRoundReturnTargetV1 = {
  readonly kind: string;
  readonly noteId?: string;
  readonly roundId?: string;
};

export function NoteRunReceipt(props: {
  readonly target: NoteRoundReturnTargetV1;
  /** `null` = 这次暂未形成结果。 */
  readonly declaredUnable: boolean;
  readonly hasResult: boolean;
  readonly targetSummary: string;
  readonly feedbackAchievement: string | null;
  readonly feedbackGap: string | null;
  readonly hasGapFacets: boolean;
  readonly onExit: (request: {
    readonly route: { readonly kind: "note.detail"; readonly noteId: string };
    readonly reflectionRoundId: string;
  }) => void;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}): ReactElement {
  const {
    target, declaredUnable, hasResult, targetSummary,
    feedbackAchievement, feedbackGap, hasGapFacets, onExit, headingRef,
  } = props;
  return (
    <section className="note-run-receipt" data-outcome={declaredUnable ? "declared_unable" : hasResult ? "has_result" : "no_result"}>
      <header>
        <span>本轮学习 · 一次尝试</span>
        <h2 ref={headingRef} tabIndex={-1} data-surface-initial-focus="true">{declaredUnable ? "这次先标记为需要帮助" : hasResult ? "这次尝试已记录" : "这次尝试暂未形成结果"}</h2>
        <p>{targetSummary}</p>
      </header>
      <div className="note-run-receipt__body">
        <strong>这次留下了什么</strong>
        <p>{declaredUnable ? "你标记了暂时不会；这一道还没有形成独立使用的证据。" : feedbackAchievement ?? "作答状态已保存，结果仍需核对。"}</p>
        {hasGapFacets && feedbackGap ? <p><b>还需帮助：</b>{feedbackGap}</p> : null}
        <p className="small">回到本轮后可以对照讲解、再试一次，或结束这一轮。</p>
      </div>
      <div className="actions note-run-receipt__actions">
        <button
          type="button"
          className="button primary"
          onClick={() => onExit({
            route: { kind: "note.detail", noteId: target.noteId ?? "" },
            reflectionRoundId: target.roundId ?? "",
          })}
        >
          <ArrowLeft size={15} aria-hidden="true" />回到本轮学习
        </button>
      </div>
    </section>
  );
}
