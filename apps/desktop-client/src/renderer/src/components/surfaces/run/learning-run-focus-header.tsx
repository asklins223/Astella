/**
 * 作答工位的顶栏与题面抬头：模式 / 目标 / 资格 / 计时，以及那道题。
 *
 * ## 为什么从 `learning-run-surface.tsx` 拆出来（2026-09-29）
 *
 * `LearningRunBody` 剩下 1800 行是一整个巨型条件，整体不可切；但里面**有几块是自足的**
 * ——顶栏 7 个外部符号、题面抬头 4 个。
 *
 * ## ⚠️ 三条不许动（都是踩过才发现的）
 *
 *  1. **`data-surface-initial-focus` 那个 `h2` 是旅程页的初始焦点落点。**
 *     此前这一屏只有纸外那颗「返回书房」胶囊，于是键盘用户一进作答页，
 *     焦点停在「离开」上而不是题目上。**别把它换成提示句**。
 *  2. **主位是主题不是指令。** recall 题的 prompt 为 §7.3 泄题防护**故意不含内容**
 *     （`run-planner.ts:210`，全仓一字不变），所以本轮那档印的是「用自己的话试一试」
 *     而不是 prompt——把一个零信息的句子放大成全屏最大的字，是在浪费主位。
 *  3. **「本轮」那档不印目标句**。`originV2.kind === "note_round"` 时右侧那颗
 *     目标摘要是空的：那一轮的目标是「用自己的话试一试」，再念一遍题面只会重复。
 */
import type { ReactElement, RefObject } from "react";
import type { LearningRunPublicSnapshotV2 } from "@ailearn/shared/learning-run-v2-contracts";
import type { LearningTaskPublic } from "@ailearn/shared/learning-run-contracts";
import { eligibilityLabel, formatClock, phaseLabels } from "./learning-run-copy.tsx";

/** 这一步的题面形状。**只声明顶栏与抬头真正要读的那几格。 */
type FocusHeaderV1 = {
  readonly modeLabel: string;
  readonly phase: LearningRunPublicSnapshotV2["phase"];
  readonly eligibility: LearningRunPublicSnapshotV2["publishedTargetEligibility"];
  readonly targetSummary: string;
  readonly isNoteRound: boolean;
};

export function LearningRunFocusRail(props: {
  readonly header: FocusHeaderV1;
  readonly activeTask: { readonly sequence: number } | null;
  readonly interactionLabel: string | null;
  readonly elapsedSeconds: number;
  readonly clockPaused: boolean;
}): ReactElement {
  const { header, activeTask, interactionLabel: interaction, elapsedSeconds, clockPaused } = props;
  return (
    <header className="learning-run-focus__rail">
      <strong className="learning-run-focus__mode">{header.modeLabel}</strong>
      <div className="learning-run-focus__target">
        <span>{activeTask ? header.isNoteRound ? "这轮的一次尝试" : `问题 ${activeTask.sequence ?? "?"} · ${interaction ?? ""}` : phaseLabels[header.phase]}</span>
        {header.isNoteRound ? null : <strong title={header.targetSummary}>{header.targetSummary}</strong>}
      </div>
      <span className="learning-run-focus__eligibility">{eligibilityLabel(header.eligibility)}</span>
      <div className="learning-run-focus__clock"><b>{formatClock(elapsedSeconds)}</b><small>{clockPaused ? "已暂停计时" : "专注时间"}</small></div>
    </header>
  );
}

export function LearningRunQuestionHeading(props: {
  /** `null` = 这一步还没有具体题目（还在准备下一步）。 */
  readonly activeTask: LearningTaskPublic | null;
  readonly interactionLabel: string | null;
  readonly isAnswering: boolean;
  readonly isNoteRound: boolean;
  readonly draftStatus: string;
  readonly targetSummary: string;
  readonly processingHeadline: string;
  readonly phase: LearningRunPublicSnapshotV2["phase"];
  readonly prompt: string | null;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  /** 题面「意图」那一小行的中文名。页面从 `facetLabels` 查好传进来。 */
  readonly intentLabel: string | null;
}): ReactElement {
  const {
    activeTask, interactionLabel: interaction, isAnswering, isNoteRound, draftStatus,
    targetSummary, processingHeadline, phase, prompt, headingRef, intentLabel,
  } = props;
  return (
    <header className="learning-run-paper__question">
      <div>
        <span>{activeTask ? `${intentLabel ?? activeTask.intent} · ${interaction ?? ""}` : phaseLabels[phase]}</span>
        <small>{activeTask && isAnswering ? draftStatus : "进度"}</small>
      </div>
      {/* 旅程页的初始焦点落点。此前它只有纸外那颗「返回书房」胶囊，
          于是键盘用户一进作答页，焦点停在"离开"上而不是题目上。 */}
      {/* 主位是主题不是指令：recall 题的 prompt 为 §7.3 泄题防护故意不含内容
          （run-planner.ts:210），全仓一字不变，把它放大等于把最大的字给零信息。 */}
      <h2 ref={headingRef} tabIndex={-1} data-surface-initial-focus="true">
        {activeTask && isAnswering ? isNoteRound ? "用自己的话试一试" : targetSummary : processingHeadline}
      </h2>
      {activeTask && isAnswering && prompt ? <p>{prompt}</p> : null}
    </header>
  );
}
