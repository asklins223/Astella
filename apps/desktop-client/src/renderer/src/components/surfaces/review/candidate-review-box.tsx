import { useLayoutEffect, useRef } from "react";
import { Archive, ArrowRight, Check, Layers3 } from "lucide-react";
import type { CardGenerationSession } from "./use-card-generation-session";
import type { CandidateReviewMotion } from "./use-candidate-review-motion";

export function CandidateReviewBox({ session, motion }: { readonly session: CardGenerationSession; readonly motion: CandidateReviewMotion }) {
  const { activatableCount, candidates, receipt } = session;
  const keptCount = candidates.filter((candidate) => candidate.reviewDecision === "keep" || candidate.publishState === "activated").length;
  return <aside className="candidate-review-slip" aria-label="候选卡收纳盒">
    <button type="button" className="candidate-box" ref={motion.boxRef} disabled={session.busyAction !== null || session.revealing || !session.activeCandidate} aria-label={`查看这一叠候选 · 已保留 ${keptCount} 张`} aria-pressed={motion.pane === "stack"} onClick={() => motion.setPane(motion.pane === "stack" ? "front" : "stack")}>
      <span className="candidate-box__art" aria-hidden="true"><i /><i /><i /><span><Archive size={30} /></span></span>
      <span className="candidate-box__label"><Layers3 size={17} aria-hidden="true" /><strong>{keptCount}</strong><span>张{receipt ? "已保存" : "已保留"}</span></span>
      <small>{activatableCount > 0 ? "待保存到卡组" : "点开查看这一叠"}</small>
    </button>
    <CandidateReviewCommit session={session} />
  </aside>;
}

export function CandidateReviewCommit({ session }: { readonly session: CardGenerationSession }) {
  const { reviewOpen, activatableCount, actionableUndecidedCount, busyAction, revealing, activate, receipt, schedulingNotice, openCards, close } = session;
  const locked = busyAction !== null || revealing;
  const viewCardsRef = useRef<HTMLButtonElement>(null);
  const saved = Boolean(receipt);
  useLayoutEffect(() => {
    if (saved) viewCardsRef.current?.focus({ preventScroll: true });
  }, [saved]);
  return <div className="candidate-review-slip__actions" aria-label="保存这一批学习卡">
    {receipt ? <p className="candidate-review-slip__receipt" role="status"><Check size={15} aria-hidden="true" />已收好 {receipt.mappings.length} 张学习卡{schedulingNotice ? <span>{` · ${schedulingNotice}`}</span> : null}</p> : null}
    {reviewOpen && actionableUndecidedCount > 0
      ? <p className="candidate-commit__remaining">{activatableCount > 0 ? `还有 ${actionableUndecidedCount} 张没决定。保存会结束本次审核，只收下已保留的卡。` : "先保留想学的卡，再保存到卡组。可以随时返回笔记，稍后继续挑选。"}</p>
      : null}
    <div className="candidate-commit__buttons">
      {reviewOpen && activatableCount > 0 ? <>
        <button type="button" className="button primary" data-candidate-save disabled={locked} onClick={() => void activate(false)}>{busyAction === "activate" ? "正在保存…" : `保存已保留的 ${activatableCount} 张`}<ArrowRight size={14} aria-hidden="true" /></button>
        <button type="button" className="button" disabled={locked} onClick={() => void activate(true)}>{busyAction === "activate-scheduling" ? "正在保存并开启复习…" : `保存并开启复习（${activatableCount} 张）`}</button>
      </> : null}
      {receipt ? <button ref={viewCardsRef} type="button" className="button green" onClick={openCards}>查看学习卡</button> : null}
      {reviewOpen ? <button type="button" className="text-action" disabled={locked} onClick={() => void close()}>{busyAction === "close" ? "正在结束…" : "结束本次审核"}</button> : null}
    </div>
  </div>;
}
