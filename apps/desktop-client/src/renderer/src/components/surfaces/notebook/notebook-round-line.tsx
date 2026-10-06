/**
 * 「这一轮」左栏：顺着读的那条线（问题纸签、迟到那句、讲解面、练习面、依据）。
 *
 * ## 抽它的四层根因，没有一层是「依赖多」（2026-09-29）
 *
 * 表面看是 31 个外部符号、像是切不动。真实原因全是**形状没有可引用的名字**：
 *  1. `roundPracticeStateLabelV1` / `roundSubmitLabelV1` 是页面里的纯函数 → 已搬进
 *     `notebook-round-copy.ts`，本文件直接 import；
 *  2. 十来个符号（roundTeaching / roundPractices / openRound / nextStep / gapHelp…）
 *     全从 `data` 派生 → 只传一个 `data`；
 *  3. `data` 的类型本来没名字 → `NotebookProjection` 其实一直是完整的、只是模块私有，
 *     改成 export 并把泛型钉住（纯类型、零行为变化）；
 *  4. `StructureQuestionCandidateV1` 与 `RoundNotice` 同样只在页面里可见 → 前者导出、
 *     后者本来就是独立模块，直接 import。
 *
 * **教训：拆不动时先问「它引用的形状有没有名字、在不在能 import 到的地方」，
 * 不要数依赖。** 前三次尝试分别停在第 1、2、3 层，每次都归因成「依赖多」——那是症状。
 *
 * ⚠️ JSX 逐字搬。两处不能动：
 *  - 那颗提交按钮的禁用判据（`roundBusy !== null || saving || (有轮次且草稿为空)`）——
 *    「点两下发出两发」的防线就在这里；
 *  - 迟到那句话（§16.39）的带载荷写入与「先替你留着」那一行。
 */
import type { Dispatch, ReactElement, SetStateAction } from "react";
import type { DesktopRouteV1 } from "@astella/shared/desktop-ipc-contracts";
import type { RoundPracticeV1 } from "@astella/shared/note-learning-round-contracts";
import type { GatewayFailureKind } from "../../../app/desktop-client";

/** 这一屏三处「失败」共用同一个形状。起个名是为了页面与组件引用同一份。 */
type RoundFailureV1 = { readonly kind: GatewayFailureKind; readonly message: string } | null;
import { RoundNotice } from "./round-notice.tsx";
import { LearningRunBody } from "../run/learning-run-surface.tsx";
import { ROUND_PRESETS_V1 } from "./notebook-surface.tsx";
import {
  ROUND_COPY,
  roundPracticeStateLabelV1,
  roundSubmitLabelV1,
  type RoundBusyV1,
} from "./notebook-round-copy.ts";
import { notePracticeResultCopy, roundTrackNextV1 } from "./note-learning-flow.ts";
import { roundRecordDayV1 } from "./round-record-copy.ts";
import type { NotebookProjection, StructureQuestionCandidateV1 } from "./notebook-surface.tsx";

export function RoundDeskLine(props: {
  readonly data: NotebookProjection | null;
  readonly roundDraft: string;
  readonly setRoundDraft: (value: string) => void;
  readonly roundBusy: RoundBusyV1;
  readonly roundFailure: RoundFailureV1 | null;
  readonly roundLostDraft: { readonly question: string; readonly starter: string | null } | null;
  readonly setRoundLostDraft: (value: { readonly question: string; readonly starter: string | null } | null) => void;
  readonly roundEditing: boolean;
  readonly setRoundEditing: (value: boolean) => void;
  readonly teachingBusy: boolean;
  readonly teachingFailure: RoundFailureV1 | null;
  readonly practiceBusy: boolean;
  readonly reviewingTeaching: boolean;
  readonly setReviewingTeaching: (value: boolean) => void;
  readonly learningScene: string;
  readonly inFlightStep: string | null;
  readonly inlineRoundRunId: string | null;
  readonly setInlineRunPage: (page: "assessment" | "result") => void;
  readonly structureQuestions: readonly StructureQuestionCandidateV1[];
  readonly teachingReferences: readonly { readonly ordinal: number; readonly label: string }[];
  readonly roundArtifact: { readonly artifactId: string } | null;
  readonly artifactState: string;
  readonly onLocateReference: (ordinal: number) => void;
  readonly onSubmitQuestion: (target: "start" | "revise", snapshot?: "current" | "last_saved") => Promise<void>;
  readonly onStartRoundTeaching: (regenerate?: boolean, personalReflectionIds?: string[]) => Promise<void>;
  readonly onStartRoundPractice: () => Promise<void>;
  readonly onPrepareRoundPractice: () => Promise<void>;
  readonly onEndNoteRound: (outcome?: "completed" | "partial") => Promise<void>;
  /** 「先到这里」那一片另有两条退出路径，outcome 的判定留在页面，所以这里收一个无参的。 */
  readonly onEndNoteRoundHere: () => Promise<void>;
  readonly onExitInlineRun: (request?: { route: DesktopRouteV1; objectiveId?: string; reflectionRoundId?: string }) => Promise<void>;
  readonly onReload: (options?: { silent?: boolean }) => Promise<void>;
  readonly onGoToReading: () => void;
  readonly onApplyLostDraft: () => void;
  /** 「依据变了」那一块由页面渲染——它是页面级组件（`notebook-surface.tsx:538`），不进本组件。 */
  readonly noteChangeImpactNotice: ReactElement | null;
  /* —— 以下几样是同一屏里「正在做哪一步」的分档，页面持有它们才有一致判据 —— */
  readonly setRoundStarter: Dispatch<SetStateAction<string | null>>;
  readonly setRoundFailure: Dispatch<SetStateAction<RoundFailureV1>>;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly saveState: string;
  readonly practiceFailure: RoundFailureV1 | null;
  readonly latestRoundPractice: { readonly startedAt: string } | null;
  readonly teachingReflectionIds: string[];
  readonly teachingSnapshotIsReadVersion: boolean;
  readonly openRoundPractice: (roundId: string) => Promise<void>;
}): ReactElement {
  const {
    data, roundDraft, setRoundDraft, roundBusy, roundFailure, roundLostDraft, setRoundLostDraft,
    roundEditing, setRoundEditing, teachingBusy, teachingFailure, practiceBusy,
    reviewingTeaching, setReviewingTeaching, learningScene, inFlightStep, inlineRoundRunId,
    setInlineRunPage, structureQuestions, teachingReferences,
    roundArtifact, artifactState,
    onLocateReference: locateTeachingReference,
    onSubmitQuestion: submitRoundQuestion,
    onStartRoundTeaching: startRoundTeaching,
    onStartRoundPractice: startRoundPractice,
    onPrepareRoundPractice: prepareRoundPractice,
    onEndNoteRoundHere: endNoteRoundHere,
    onExitInlineRun: exitInlineRoundRun,
    onReload: reload,
    onGoToReading: setLeaf,
    onApplyLostDraft: applyLostDraft,
    noteChangeImpactNotice,
    setRoundStarter, setRoundFailure, saving, saveState, practiceFailure,
    latestRoundPractice, teachingReflectionIds, teachingSnapshotIsReadVersion, openRoundPractice, dirty,
  } = props;
  const openRound = data?.openRound ?? null;
  const openRoundContentMoved = data?.openRoundContentMoved ?? false;
  const openRoundNoteChangeImpact = data?.openRoundNoteChangeImpact ?? null;
  const roundTeaching = data?.roundTeachingView?.teaching ?? null;
  const roundTeachingFailure = data?.roundTeachingFailure ?? null;
  const roundPractices = (data?.roundTeachingView?.practices ?? []) as readonly RoundPracticeV1[];
  const roundNextStep = data?.roundTeachingView?.nextStep ?? null;
  const roundGapHelp = data?.roundTeachingView?.gapHelp ?? null;
  const roundResultCopy = notePracticeResultCopy({
    question: openRound?.drivingQuestion ?? null,
    practices: roundPractices,
    nextStep: roundNextStep,
  });
  return (
    <div className="round-desk__line">
      {openRound ? (
        <figure className="round-slip round-slip--question" data-round-question>
          <span className="round-tape" aria-hidden="true" />
          <figcaption>这一轮要弄懂</figcaption>
          <h2 className="round-slip__question">{openRound.drivingQuestion}</h2>
        </figure>
      ) : (
        <h2 className="round-desk__ask">想弄懂这篇里的哪一件事？</h2>
      )}

      {inFlightStep ? <RoundNotice kind="pending" message={inFlightStep} testId="round-inflight" /> : null}

      {learningScene === "unavailable" ? (
        <div className="round-slip round-slip--muted" aria-label="读取本轮状态失败">
          <p>{roundTeachingFailure || "这一轮的当前步骤没有读到，暂时无法确定该从哪里继续。"}</p>
          <p className="round-slip__aside">已经存下的讲解与作答都还在，不会被当成未开始。</p>
        </div>
      ) : null}

      {learningScene === "paused" ? (
        <div className="round-slip round-slip--paused" aria-label="这一轮暂停了">
          <p className="round-slip__lead">这一轮停在这儿，留下的都还在。</p>
          <dl className="round-ledger">
            <div><dt>讲解</dt><dd>{roundTeaching ? `讲过 · ${roundRecordDayV1(roundTeaching.createdAt)}` : "还没讲过"}</dd></div>
            <div><dt>练习</dt><dd>{roundPractices.length > 0
              ? `做过 ${roundPractices.length} 次 · 最近一次 ${roundRecordDayV1(latestRoundPractice?.startedAt ?? roundPractices[0]!.startedAt)}`
              : "还没试过"}</dd></div>
            <div><dt>接下来</dt><dd>{roundNextStep ? roundTrackNextV1(roundNextStep.kind) : "这一轮的下一步暂时读不到"}</dd></div>
          </dl>
          <p className="round-slip__aside">接着学会接着原来的记录，不会重讲一遍，也不会让你从头再答。</p>
          {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重新读取这一轮" /> : null}
        </div>
      ) : null}

      {learningScene === "question" ? (
        openRound && !roundEditing ? (
          <>
            {openRoundContentMoved ? <p className="round-slip__aside" data-round-content-moved="true">{ROUND_COPY.contentMoved}</p> : null}
            {noteChangeImpactNotice}
            {/* 这一轮的两个岔口**只给按钮**。上一版在这里还写了一句"围绕这个问题，
                可以直接看讲解，也可以先试一个小问题"——按钮自己已经把话说完了，
                再复述一遍只是把纸面撑长（39f UI-4）。 */}
            <div className="round-forks">
              {roundNextStep?.kind === "explain"
                ? <button type="button" className="round-stamp" disabled={practiceBusy || teachingBusy} onClick={() => void prepareRoundPractice()}>
                    {practiceBusy ? "正在准备…" : "先试一小问"}
                  </button>
                : null}
              {roundNextStep?.kind === "attempt" && !roundTeaching
                ? <button type="button" className="round-stamp" disabled={teachingBusy} onClick={() => void startRoundTeaching(false)}>看讲解</button>
                : null}
              {roundNextStep?.kind === "explain" || (roundNextStep?.kind === "attempt" && !roundTeaching)
                ? <button type="button" className="round-tab" disabled={practiceBusy || teachingBusy} onClick={() => {
                    const other = roundNextStep?.kind === "explain"
                      ? () => void startRoundTeaching(false)
                      : () => void prepareRoundPractice();
                    other();
                  }}>{roundNextStep?.kind === "explain" ? "改成先看讲解" : "改成先试一小问"}</button>
                : null}
            </div>
            {data?.roundTeachingView?.plans.length ? (
              <details className="round-flap">
                <summary>这次会讲到哪</summary>
                <div className="round-flap__sheet">
                  <ol>{data.roundTeachingView.plans.at(-1)!.plan.steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol>
                  <p className="round-slip__aside">{data.roundTeachingView.plans.at(-1)!.plan.expectedScale}</p>
                </div>
              </details>
            ) : null}
          </>
        ) : (
          <div className="round-ask">
            <label htmlFor="notebook-round-question">写一句就行</label>
            <input id="notebook-round-question" aria-label={ROUND_COPY.ask} className="round-ask__line" value={roundDraft} maxLength={500} placeholder={ROUND_COPY.ask} disabled={roundBusy !== null} onChange={(event) => setRoundDraft(event.target.value)} />
            <p className="round-slip__aside">下面几颗给的是问的方向，不是答案——挑一个，再改成你自己的话。</p>
            {structureQuestions.length > 0 ? (
              <div className="round-ask__from">
                <span>从这篇的小节里挑</span>
                {structureQuestions.map((candidate) => (
                  <button key={candidate.ordinal} type="button" className="round-tab round-tab--section" disabled={roundBusy !== null} onClick={() => { setRoundStarter(candidate.question); setRoundDraft(candidate.question); setRoundFailure(null); }}>
                    {candidate.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="round-ask__presets">
              {ROUND_PRESETS_V1.map((preset) => (
                <button key={preset.key} type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => { setRoundStarter(preset.starter); setRoundDraft(preset.starter); setRoundFailure(null); }}>
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="round-forks">
              <button type="button" className="round-stamp" disabled={roundBusy !== null || saving || (openRound !== null && roundDraft.trim().length === 0)} onClick={() => void submitRoundQuestion(openRound ? "revise" : "start")}>
                {roundSubmitLabelV1(roundBusy, openRound !== null)}
              </button>
              {!openRound && (dirty || saveState === "error")
                ? <button type="button" className="round-tab" disabled={roundBusy !== null || saving} onClick={() => void submitRoundQuestion("start", "last_saved")}>按上次已保存内容开始</button>
                : null}
              {openRound ? <button type="button" className="round-tab" onClick={() => setRoundEditing(false)}>不改了</button> : null}
            </div>
          </div>
        )
      ) : null}

      {roundTeaching && (learningScene === "teaching" || reviewingTeaching || learningScene === "result") ? (
        <article className="round-prose" data-round-section="teaching" aria-label="本轮讲解">
          <p className="round-prose__body">{roundTeaching.content.explanation}</p>
          {roundTeaching.content.example ? (
            <aside className="round-slip round-slip--example">
              <p className="round-slip__label">看一个例子</p>
              <p>{roundTeaching.content.example}</p>
            </aside>
          ) : null}
          {roundTeaching.content.suspectClaims?.length ? (
            <div className="round-slip round-slip--flag" aria-label="需要核对的事实主张">
              <p className="round-slip__label">有几处说法要核对</p>
              {roundTeaching.content.suspectClaims.map((claim, index) => (
                <div key={`${claim.unitIds.join("-")}-${index}`} className="round-slip__item">
                  {claim.sourceQuote ? <blockquote>{claim.sourceQuote}</blockquote> : <p className="round-slip__aside">原文位置还没能可靠定位</p>}
                  <p>{claim.reason}</p>
                </div>
              ))}
              <p className="round-slip__aside">核对前，这些说法不会成为正式的学习目标。</p>
            </div>
          ) : null}
          {teachingReferences.length ? (
            <details className="round-flap">
              <summary>回到笔记里那句话</summary>
              <div className="round-flap__sheet">{teachingReferences.map((item) => (
                <button key={item.ordinal} type="button" className="round-tab" onClick={() => locateTeachingReference(item.ordinal)}>{item.label}</button>
              ))}</div>
            </details>
          ) : !teachingSnapshotIsReadVersion ? <p className="round-slip__aside">{ROUND_COPY.teaching.staleVersion}</p> : null}
          {roundTeaching.personalSources?.length ? (
            <details className="round-flap">
              <summary>这次参考的个人理解</summary>
              <div className="round-flap__sheet">
                <ul>{roundTeaching.personalSources.map((item) => <li key={item.reflectionId}>{item.source.question} · 私有备注第 {item.revision} 版</li>)}</ul>
                <p className="round-slip__aside">这些内容只作本人理解背景，不作笔记依据或正式判定。</p>
              </div>
            </details>
          ) : null}
        </article>
      ) : null}

      {learningScene === "practice" && !reviewingTeaching ? (
        <div className="round-bench" aria-label="继续练习">
          {/* 就地作答，不跳页（2026-09-28 用户裁决）。挂的是同一个
              `LearningRunBody`——状态机、草稿自动保存、闸门与结算一条没改，
              改的只是它在树上挂在哪里；离开这一轮走的也是同一个 `onExit`
              （含主进程那道 `FormalAssessmentGuard` 释放），两条路不会长出两套收尾。 */}
          {inlineRoundRunId ? (
            <>
              <p className="round-slip__aside">写下的内容会自己存着，中途离开也能接着做。</p>
              <LearningRunBody
                runId={inlineRoundRunId}
                onExit={(request) => { void exitInlineRoundRun(request); }}
                onPageChange={setInlineRunPage}
              />
            </>
          ) : <p>这一道已经在答了。回到那道题作答，结果会自动接回这一轮。</p>}
          {roundPractices.length > 1 ? (
            <details className="round-flap">
              <summary>这一轮之前做过的 {roundPractices.length - 1} 道</summary>
              <div className="round-flap__sheet">
                <ol className="round-runlist">{roundPractices.slice(0, -1).map((practice) => (
                  <li key={practice.runId}>
                    <span>{roundRecordDayV1(practice.startedAt)} · {roundPracticeStateLabelV1(practice)}</span>
                    <button type="button" className="round-tab" onClick={() => { void openRoundPractice(practice.runId); }}>看这一次</button>
                  </li>
                ))}</ol>
              </div>
            </details>
          ) : null}
          {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重试这一步" /> : null}
        </div>
      ) : null}

      {learningScene === "result" && !reviewingTeaching ? (
        <div className="round-receipt" aria-label="本轮结果">
          <p className="round-slip__label">这一轮的收获</p>
          <p className="round-receipt__today">{roundResultCopy.today}</p>
          <p className="round-receipt__gap">{roundResultCopy.gap}</p>
          <p className="round-receipt__next">{roundResultCopy.next}</p>
          <p className="round-slip__aside">这里说的是这一道题的证据；它不代替整篇笔记的掌握判断。</p>
          {roundPractices.length ? (
            <details className="round-flap">
              <summary>这一轮的 {roundPractices.length} 次作答</summary>
              <div className="round-flap__sheet">
                <ol className="round-runlist">{roundPractices.map((practice) => (
                  <li key={practice.runId}>
                    <span>{roundRecordDayV1(practice.startedAt)} · {roundPracticeStateLabelV1(practice)}</span>
                    <button type="button" className="round-tab" onClick={() => { void openRoundPractice(practice.runId); }}>看这一次</button>
                  </li>
                ))}</ol>
              </div>
            </details>
          ) : null}
          {roundGapHelp?.stopped ? (
            <details className="round-flap">
              <summary>这次需要换一种帮助</summary>
              <div className="round-flap__sheet">
                <p className="round-slip__aside">{ROUND_COPY.teaching.stopLead(roundGapHelp.consecutiveHelpCount)}</p>
                <button type="button" className="round-stamp" disabled={teachingBusy || roundBusy !== null} onClick={() => { setReviewingTeaching(true); void startRoundTeaching(true, teachingReflectionIds); }}>
                  {teachingBusy ? ROUND_COPY.teaching.starting : ROUND_COPY.teaching.switchExplanation}
                </button>
                {teachingReferences[0] ? <button type="button" className="round-tab" onClick={() => locateTeachingReference(teachingReferences[0]!.ordinal)}>{ROUND_COPY.teaching.backToMaterial}</button> : null}
                {data?.roundTeachingView?.prerequisite.kind === "candidate" ? (
                  <p className="round-slip__aside">可能需要先补：{data.roundTeachingView.prerequisite.label}（约 {data.roundTeachingView.prerequisite.estimatedSteps} 步）。
                    <button type="button" className="round-tab" onClick={() => { setRoundDraft(data.roundTeachingView!.prerequisite.kind === "candidate" ? data.roundTeachingView!.prerequisite.label : openRound?.drivingQuestion ?? ""); setRoundStarter(null); setRoundEditing(true); }}>改为先学这个</button>
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {learningScene === "question" ? (
        <>
          {roundFailure ? <RoundNotice kind={roundFailure.kind} message={roundFailure.message} onRetry={() => void reload({ silent: true })} retryLabel="重试这一步" secondary={<button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRoundHere()}>先到这里</button>} /> : null}
          {teachingFailure ? <RoundNotice kind={teachingFailure.kind} message={teachingFailure.message} onRetry={() => { void startRoundTeaching(true, teachingReflectionIds); }} retryLabel="换一种讲解" /> : null}
          {practiceFailure ? <RoundNotice kind={practiceFailure.kind} message={practiceFailure.message} onRetry={() => void startRoundPractice()} retryLabel="再试一次" secondary={<button type="button" className="round-tab" disabled={roundBusy !== null} onClick={() => void endNoteRoundHere()}>先到这里</button>} /> : null}
          {roundLostDraft ? (
            <div className="round-slip round-slip--muted" data-round-lost>
              <p>{ROUND_COPY.lostDraft(roundLostDraft.question)}</p>
              <div className="round-forks">
                <button type="button" className="round-stamp" onClick={() => { setRoundDraft(roundLostDraft.question); setRoundStarter(roundLostDraft.starter); setRoundLostDraft(null); setRoundEditing(true); }}>{ROUND_COPY.applyLost}</button>
                <button type="button" className="round-tab" onClick={() => setRoundLostDraft(null)}>{ROUND_COPY.dropLost}</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
