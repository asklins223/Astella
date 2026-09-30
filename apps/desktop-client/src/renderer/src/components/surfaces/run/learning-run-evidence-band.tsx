/**
 * 结算纸上那条「学习证据」带：这次做对了什么、本次掌握、还差什么、学习状态变化。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件，整体不可切；但里面**有几块是自足的**
 * ——这块 5 个外部符号。
 *
 * ## ⚠️ 四条不许动
 *
 *  1. **审计 F30：没有具体缺口时「还差什么」整块不渲染。** 原来会印一句
 *     「按下一步建议继续即可。」，而这句在旁白里又把读者推回本页的「下一步」——
 *     等于什么都没说；同一句话还会被印两遍。
 *  2. **「做对了什么」与「本次判定」是同一格的两个名字**：`tone === "neutral"` 时
 *     整格不画（那不是「做对了什么」也不是「没做对」，是「这次只作记录」）。
 *  3. **提升项是列表，缺口是句子。** 有具体提升项时逐条列，没有时才退回那句概括——
 *     反过来写会让「读了没印象」与「真的没有」读起来一样。
 *  4. **「学习状态变化」那一格永远在**：它是这一次与复习安排之间唯一的联系。
 *     它说复习排到了什么时候，而不只是「已记录」。
 */
import type { ReactElement } from "react";

/** 一条反馈的形状。**只声明这一格真正要读的五项**，多写一格就多一处与源头分叉的地方。 */
type EvidenceFeedbackV1 = {
  readonly tone: string;
  readonly achievement: string;
  readonly strengths: readonly string[];
  readonly improvements: readonly string[];
  readonly gap: string | null;
};

export function LearningRunEvidenceBand(props: {
  readonly hasResult: boolean;
  readonly feedback: EvidenceFeedbackV1 | null;
  /** 练习完成且这次没覆盖任何考点时，「做对了什么」要说「本次判定」。 */
  readonly practiceWithoutCoverage: boolean;
  readonly provenText: string;
  readonly scheduleText: string;
  /** 没有结果时（提前结束）改印「结束原因」那一格。 */
  readonly terminalReasonLine: string | null;
}): ReactElement {
  const {
    hasResult, feedback, practiceWithoutCoverage,
    provenText, scheduleText, terminalReasonLine,
  } = props;
  if (!hasResult) {
    return (
      <div className="learning-run-result-evidence learning-run-result-evidence--single">
        <b>结束原因</b>
        <p>{terminalReasonLine ?? "这一轮没有形成可记录的结论。"}</p>
      </div>
    );
  }
  return (
    <div className="learning-run-result-evidence">
      {feedback && feedback.tone !== "neutral" ? (
        <div data-role="proved-this-time">
          <b>{practiceWithoutCoverage ? "本次判定" : "做对了什么"}</b>
          {feedback.strengths.length ? (
            <ul>{feedback.strengths.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : <p>{feedback.achievement}</p>}
        </div>
      ) : null}
      <div>
        <b>本次掌握</b>
        <p>{provenText}</p>
      </div>
      {/* 审计 F30：没有具体缺口时这一块整块不渲染——原来会印一句
          "按下一步建议继续即可。"，而这句在旁白里又把读者推回本页的
          "下一步"，等于什么都没说；同一句话还会被印两遍。 */}
      {feedback?.improvements.length || feedback?.gap ? (
        <div>
          <b>还差什么</b>
          {feedback.improvements.length
            ? <ul>{feedback.improvements.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            : <p>{feedback.gap}</p>}
        </div>
      ) : null}
      <div>
        <b>学习状态变化</b>
        <p>{scheduleText}</p>
      </div>
    </div>
  );
}
