/**
 * 结算纸上的抬头（印章那一张）与它下面那条「本次学习反馈」。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件（`result || terminal ? … : …`），
 * 整体 70 个外部符号、不可切；但里面**有几块是自足的**——抬头 7 个符号、反馈条 2 个。
 *
 * ## ⚠️ 抬头有**两档**，不是一档——那是有裁决的
 *
 * - `SEALLESS_OUTCOMES` 里的 outcome（`declared_unable` 等）**不盖印章**。
 *   说「不会」不是成就，给它盖一个印就是把一次诚实的求助包装成了一次成绩。
 *   那一档印的是 `learning-run-arrival__quiet`：**这次说了暂时不会 / 这次先放着**。
 * - 其余 outcome 盖 `learning-run-arrival__seal`，文案取 `feedback.seal`，
 *   服务端没给就回退到 `outcomeSeal[outcome]` 的兜底。
 *
 * 这条由 `objective-flow-css-guard` 盯：它断言「每个 outcome 的印章文案都还在表里，
 * 分档不许把谁漏成空白」。
 */
import type { ReactElement, RefObject } from "react";
import { SEALLESS_OUTCOMES, outcomeSeal, formatClock, runOriginLabel } from "./learning-run-copy.tsx";
import { ObjectiveProgressBand } from "./ObjectiveProgressBand.tsx";
import { progressSegmentForOutcome } from "./objective-progress-band.ts";

export function LearningRunArrival(props: {
  readonly outcome: string | undefined;
  readonly seal: string | null;
  readonly headline: string | null;
  /** 练习完成且这次没覆盖任何考点时，「做对了什么」要说「本次判定」而不是「做对了什么」。 */
  readonly practiceWithoutCoverage: boolean;
  readonly targetSummary: string;
  readonly origin: Parameters<typeof runOriginLabel>[0];
  readonly elapsedSeconds: number;
  /**
   * 进度带**在本组件里查表**，不收一个算好的数。
   *
   * `objective-progress-band-guard` 盯的是「每一屏都要走
   * `progressSegmentForOutcome(...)` / `progressSegmentForState(...)`」——
   * 搬组件时如果把结果当 prop 传进来，守卫就盯不到这一步了（实测：它会报
   * 「调用点没走查表」）。所以这里**接 outcome、自己在里面查**。
   */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}): ReactElement {
  const {
    outcome, seal, headline, practiceWithoutCoverage, targetSummary,
    origin, elapsedSeconds, headingRef,
  } = props;
  return (
    <header className="learning-run-arrival">
      <div className="learning-run-arrival__topline">
        <span>{outcome === "practice_completed" ? "练习旅程完成" : "本次挑战记录"}</span>
        <span>{runOriginLabel(origin)} · {formatClock(elapsedSeconds)}</span>
      </div>
      {outcome && !SEALLESS_OUTCOMES.has(outcome as never) ? (
        <strong className="learning-run-arrival__seal">{seal ?? outcomeSeal[outcome as never]}</strong>
      ) : (
        <strong className="learning-run-arrival__quiet">{outcome === "declared_unable" ? "这次说了暂时不会" : "这次先放着"}</strong>
      )}
      <h2 ref={headingRef} tabIndex={-1} data-surface-initial-focus="true">
        {headline ?? "这次旅程没有形成新的学习结果"}
      </h2>
      <p className="learning-run-arrival__target">{targetSummary}</p>
      <ObjectiveProgressBand segment={progressSegmentForOutcome(outcome)} />
    </header>
  );
}

/**
 * 一条反馈。它由 `learningDiscoveryCard` 那族函数算出，`tone` 的取值不是任意字符串。
 * **只声明这一条真正要读的三格**——多写一格就多一处可能与源头分叉的地方。
 */
type ArrivalFeedbackV1 = {
  readonly tone: string;
  readonly achievement: string;
  readonly gap: string | null;
};

export function LearningRunArrivalEvidence(props: {
  readonly feedback: ArrivalFeedbackV1;
  readonly practiceWithoutCoverage: boolean;
  readonly nextChallengeLabel: string;
}): ReactElement {
  const { feedback, practiceWithoutCoverage, nextChallengeLabel } = props;
  return (
    <section className="learning-run-arrival-evidence" aria-label="本次学习反馈">
      <div><span>{feedback.tone === "neutral" ? "本次记录" : practiceWithoutCoverage ? "本次判定" : "做对了什么"}</span><p>{feedback.achievement}</p></div>
      {feedback.gap ? <div><span>还差什么</span><p>{feedback.gap}</p></div> : null}
      <div><span>下一步</span><p>{nextChallengeLabel}</p></div>
    </section>
  );
}
