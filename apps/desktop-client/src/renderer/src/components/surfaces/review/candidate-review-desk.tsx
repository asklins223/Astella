import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, Eye, LoaderCircle, RefreshCw, RotateCcw, X } from "lucide-react";
import type { CardGenerationSession } from "./use-card-generation-session";
import { candidateDecisionLabel, exposureLabel, firstValidationLabel, isActionableUndecidedCandidate, revealCooldownHours } from "./candidate-review-model";
import { cardGenerationRecoveryReasonLabel, cardGenerationStatusLabel, cardGenerationSyncReportText } from "./card-generation-status";
import { CardGenerationRecoveryActions } from "./card-generation-recovery-actions";
import { CandidateReviewCard } from "./candidate-review-card";
import { CandidateReviewBox, CandidateReviewCommit } from "./candidate-review-box";
import { useCandidateReviewMotion } from "./use-candidate-review-motion";

export function CandidateReviewDesk({ session }: { readonly session: CardGenerationSession }) {
  const { run, candidates, activeCandidate: card, activeCandidateIndex, reviewOpen, activeReveal, busyAction, revealing, loading,
    failure, actionFailure, revealFailure, exposure, exposureFailure, practiceQuotaView, actionableUndecidedCount, syncReport, resync, returnToNote } = session;
  const motion = useCandidateReviewMotion(card?.candidateRevisionId ?? null);
  const [lastDecisionId, setLastDecisionId] = useState<string | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const currentKey = useRef(card?.candidateRevisionId);
  currentKey.current = card?.candidateRevisionId;
  const locked = busyAction !== null || revealing;
  const lastDecision = candidates.find((candidate) => candidate.candidateId === lastDecisionId && candidate.reviewDecision !== "undecided" && candidate.publishState === "unpublished");
  const undoCard = card?.reviewDecision !== "undecided" && card?.publishState === "unpublished" ? card : lastDecision;

  const onReview: CardGenerationSession["review"] = async (candidate, decision, reason) => {
    const confirmed = await session.review(candidate, decision, reason);
    if (confirmed) {
      motion.setPane("front"); motion.resetTilt();
      if (decision !== "undo") { setLastDecisionId(candidate.candidateId); motion.fly(candidate, decision); }
      else setLastDecisionId(null);
    }
    return confirmed;
  };

  const showAnswers = async () => {
    if (!card) return;
    if (activeReveal) { motion.setPane(motion.pane === "answers" ? "front" : "answers"); return; }
    const key = card.candidateRevisionId;
    if (await session.revealCandidate(card) && currentKey.current === key) motion.setPane("answers");
  };

  return <div className="candidate-review-table" ref={motion.deskRef} data-card-strategy={card?.strategy ?? "none"} data-motion={motion.mode}>
    <header className="candidate-desk__header">
      <div className="candidate-card__meta" role="status" aria-live="polite">
        <span>{card ? `候选 ${activeCandidateIndex + 1} / ${candidates.length}` : "候选卡审核"}<b>{actionableUndecidedCount ? ` · ${actionableUndecidedCount} 张还没决定` : candidates.length ? " · 可审核卡都已决定" : ""}</b>{practiceQuotaView ? <small> · {practiceQuotaView}</small> : null}</span>
        <span className="tag green">{card ? candidateDecisionLabel(card) : run ? cardGenerationStatusLabel(run.status) : "正在接回候选"}</span>
      </div>
      <div className="candidate-desk__tools">
        <div className="candidate-desk__navigation" aria-label="切换候选卡">
          <button type="button" className="button" aria-label="上一张" disabled={locked || !card || activeCandidateIndex === 0} onClick={() => session.moveCandidate(-1)}><ArrowLeft size={17} aria-hidden="true" /></button>
          <span>{card ? `${activeCandidateIndex + 1} / ${candidates.length}` : "—"}</span>
          <button type="button" className="button" aria-label="下一张" disabled={locked || !card || activeCandidateIndex >= candidates.length - 1} onClick={() => session.moveCandidate(1)}><ArrowRight size={17} aria-hidden="true" /></button>
        </div>
        {card ? <button type="button" className="button candidate-flip-toggle" aria-label={motion.pane !== "front" ? "翻回题面" : "翻看卡片档案"} aria-pressed={motion.pane !== "front"} disabled={locked} onClick={() => { motion.resetTilt(); motion.setPane(motion.pane === "front" ? "dossier" : "front"); }}><RotateCcw size={16} aria-hidden="true" /><span className="candidate-desk__label">{motion.pane !== "front" ? "翻回题面" : "翻看卡片档案"}</span><span className="candidate-desk__short-label">{motion.pane !== "front" ? "题面" : "档案"}</span></button> : null}
        {card && reviewOpen ? <button type="button" className="button" disabled={locked} title={`看过答案后，保存进卡组要等 ${revealCooldownHours} 小时才能正式首次验证，期间仍可练习。`} aria-label={activeReveal ? "查看答案与证据" : `查看答案与证据 · 首次验证延后 ${revealCooldownHours} 小时`} onClick={() => void showAnswers()}><Eye size={16} aria-hidden="true" /><span className="candidate-desk__label">{revealing ? "正在读取答案…" : "查看答案与证据"}</span><span className="candidate-desk__short-label">{revealing ? "读取中…" : "答案与证据"}</span></button> : null}
        {!run?.recovery && card && !failure ? <button type="button" className="text-action candidate-desk__return" onClick={returnToNote}>返回笔记</button> : null}
      </div>
      {card ? <p className="candidate-desk__validation"><Eye size={13} aria-hidden="true" /><span>{activeReveal || exposure?.exposureStatus === "exposed" ? firstValidationLabel(exposure, exposureFailure) : `看答案后，首次正式验证延后 ${revealCooldownHours} 小时；翻档案不影响。`}</span>{activeReveal ? <small>{exposureLabel(exposure, exposureFailure)}</small> : null}</p> : null}
    </header>

    {card && !failure ? <CandidateReviewCard session={session} motion={motion} onReview={onReview} /> : <section className="candidate-desk__empty" role={failure ? "alert" : "status"}>
      {loading ? <LoaderCircle size={34} className="run-spinner" aria-hidden="true" /> : <CircleAlert size={34} aria-hidden="true" />}
      <h2>{failure ? "候选暂时读不到" : loading ? "正在接回这一叠卡…" : run?.recovery ? cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode) : "没有可审核候选"}</h2>
      <p>{failure ?? (run?.recovery ? "这次没有读到可以审核的候选。重新检查后，可以继续接回进度。" : "还没有可展示的候选，或者这次生成已经结束。")}</p>
      <div className="actions">{run?.recovery ? <CardGenerationRecoveryActions session={session} /> : <><button type="button" className="button" disabled={loading} onClick={() => void resync()}><RefreshCw size={15} aria-hidden="true" />重新检查</button><button type="button" className="button primary" onClick={returnToNote}>返回笔记</button></>}</div>
    </section>}
    <CandidateReviewBox session={session} motion={motion} />

    <footer className="candidate-desk__footer">
      <div className="candidate-desk__feedback" aria-live="polite">
        {actionFailure ? <p role="alert">这一步没成功：{actionFailure}</p> : null}
        {revealFailure ? <p role="alert">答案读取没有成功：{revealFailure}<button type="button" className="text-action" disabled={locked} onClick={() => void showAnswers()}>重试</button></p> : null}
        {syncReport ? <p role="status">{cardGenerationSyncReportText(syncReport.status, syncReport.changed)}</p> : null}
        {run?.recovery && card ? <p>这次生成有候选没有通过整体检查，通过检查的候选仍然可以保留、丢弃、保存到卡组。</p> : null}
      </div>
      <div className="candidate-desk__decisions" aria-label="决定当前候选卡">
        {card && reviewOpen && isActionableUndecidedCandidate(card) && motion.pane !== "reject" ? <>
          <button type="button" className="button" disabled={locked} onClick={() => { motion.resetTilt(); motion.setPane("reject"); }}><X size={17} aria-hidden="true" />不保留</button>
          {/* 「保留这张」是一次**选择**，不是提交。真正把这叠交出去的动作是右邻那颗
              「保存已保留的 N 张」。这一屏的落点是「把这几张收进卡组」——那才是用户
              从头到尾要的结果，逐张点「保留」只是通往它的一段路。所以重点色放在
              保存那颗上：它一屏只出现一次，而「保留」要在同一叠里被点很多次，
              每次都抢焦点只会让人以为每点一下就结束了。 */}
          <button type="button" className="button" ref={motion.decisionRef} disabled={locked} aria-label="保留（等着保存到卡组）" onClick={() => void onReview(card, "keep")}><Check size={18} aria-hidden="true" />{busyAction === `${card.candidateId}:keep` ? "正在保留…" : "保留这张"}</button>
        </> : null}
        {reviewOpen && undoCard ? <button ref={undoRef} type="button" className="button" disabled={locked} aria-label="撤销决定" title={undoCard.objective.publicSummary} onClick={() => void onReview(undoCard, "undo")}><RotateCcw size={16} aria-hidden="true" /><span className="candidate-desk__label">{busyAction === `${undoCard.candidateId}:undo` ? "正在撤销…" : undoCard === card ? "撤销决定" : "撤销上一张"}</span><span className="candidate-desk__short-label">{busyAction === `${undoCard.candidateId}:undo` ? "撤销中…" : "撤销"}</span></button> : null}
        {run?.recovery && card ? <CardGenerationRecoveryActions session={session} /> : null}
      </div>
      <CandidateReviewCommit session={session} />
    </footer>

  </div>;
}
