import { Check, CircleAlert, Layers3, X } from "lucide-react";
import { CandidateAnswerPaper } from "./candidate-answer-paper";
import { CandidateText } from "./candidate-text";
import { cardStrategyPresentation } from "./card-strategy-presentation";
import { candidateDecisionLabel, exposureLabel, practiceItemLabel, REJECT_REASONS } from "./candidate-review-model";
import type { CardGenerationSession } from "./use-card-generation-session";
import type { CandidateReviewMotion } from "./use-candidate-review-motion";
import { CandidateCardSpace } from "./candidate-card-space";
import { CandidateCardFace } from "./candidate-card-face";

export function CandidateReviewCard({ session, motion, onReview }: {
  readonly session: CardGenerationSession;
  readonly motion: CandidateReviewMotion;
  readonly onReview: CardGenerationSession["review"];
}) {
  const { activeCandidate: card, activeCandidateIndex, candidates, activeReveal, busyAction, revealing, exposure, exposureFailure, setActiveCandidateId } = session;
  if (!card) return null;
  const { pane, setPane } = motion;
  const strategy = cardStrategyPresentation[card.strategy];
  const suspect = card.qualityIssues.filter((issue) => issue.code === "suspect_claim" || issue.code === "suspect_claim_location_missing");
  const kept = card.reviewDecision === "keep" || card.publishState === "activated";
  const locked = busyAction !== null || revealing;

  return <section className="candidate-study-card" aria-label="当前候选卡">
    <CandidateCardSpace motion={motion} locked={locked} candidateKey={card.candidateRevisionId} front={<>
            <header className="candidate-card__header">
              <span className="candidate-card__strategy"><i aria-hidden="true">{strategy.symbol}</i><span>{strategy.label}</span></span>
              <span className="candidate-card__number">{String(activeCandidateIndex + 1).padStart(2, "0")}<small> / {String(candidates.length).padStart(2, "0")}</small></span>
            </header>
            <CandidateCardFace label="候选卡题面">
              <p className="candidate-card__kicker">这张卡问你</p>
              <h2 className="candidate-card__prompt"><CandidateText text={card.front.prompt} /></h2>
              {card.front.cue ? <p className="candidate-card__cue"><b>线索</b><CandidateText text={card.front.cue} /></p> : null}
              {card.front.context ? <p className="candidate-card__context"><b>情境</b><CandidateText text={card.front.context} /></p> : null}
              <div className="candidate-card__objective"><span>准备验证这个目标</span><h3 id="candidate-card-title"><CandidateText text={card.objective.statement} /></h3></div>
              {suspect.length ? <section className="candidate-suspect-note" aria-label="待核对的可疑主张" role="note">
                <h3><CircleAlert size={17} aria-hidden="true" />待核对的可疑主张</h3>
                <p>这是待核对提示，不是系统断言原句一定错误。核对清楚前，它不能成为标准答案、正式能力判断或复习卡依据。</p>
                <ul>{suspect.map((issue, index) => <li key={`${issue.code}:${index}`}>
                  <blockquote>{issue.sourceQuote ? `“${issue.sourceQuote}”` : "原文位置还没能可靠定位，请回到这条笔记核对。"}</blockquote><p>{issue.detail}</p>
                </li>)}</ul>
                <p>这张候选已被质量检查拦下，不能保存为标准复习卡；其它候选仍分别审核。</p>
              </section> : null}
              {card.front.mediaRefs?.length ? <p className="candidate-card__refs">素材引用：{card.front.mediaRefs.join(" · ")}</p> : null}
              {kept ? <span className="candidate-card__stamp"><Check size={19} aria-hidden="true" />{card.publishState === "activated" ? "已入卡组" : "已保留"}</span> : null}
              {card.reviewDecision === "reject" ? <span className="candidate-card__stamp candidate-card__stamp--rejected">已拒绝</span> : null}
            </CandidateCardFace>
            <footer className="candidate-review-slip__formats">
              <span>正式验证用自己的话，文字或口述</span>
              <span>附带练习：<b>{practiceItemLabel(card.practiceItem)}</b></span>
              <small>客观题用于练习，不能单独证明掌握。</small>
            </footer>
          </>} back={<>
            <header className="candidate-card__header">
              <span className="candidate-card__strategy"><i aria-hidden="true">{pane === "stack" ? <Layers3 size={21} /> : strategy.symbol}</i><span>{pane === "answers" ? "答案与证据" : pane === "reject" ? "让这张卡退场" : pane === "stack" ? "这一叠候选" : "卡片档案"}</span></span>
              <span className="candidate-card__number">{String(activeCandidateIndex + 1).padStart(2, "0")}</span>
            </header>
            <CandidateCardFace label={pane === "answers" ? "答案阅读区" : "卡片背面"}>
              {pane === "dossier" ? <>
                <p className="candidate-card__kicker">{card.recommendation.recommended ? "建议保留这张" : "逐张做判断"}</p>
                <h3 className="candidate-dossier__title">{strategy.cue}</h3>
                <p className="candidate-dossier__summary"><CandidateText text={card.objective.publicSummary} /></p>
                <dl className="candidate-dossier__facts">
                  <div><dt>预计用时</dt><dd>约 {card.estimatedReviewSeconds} 秒</dd></div>
                  <div><dt>看过答案</dt><dd>{exposureLabel(exposure, exposureFailure)}</dd></div>
                </dl>
                <p className="candidate-dossier__notice">翻面只看公开档案，不会展示答案或记录你看过答案。</p>
              </> : null}
              {pane === "answers" && activeReveal ? <CandidateAnswerPaper reveal={activeReveal} /> : null}
              {pane === "reject" ? <div className="reject-reasons" role="group" aria-label="不保留的原因">
                <h3>为什么不要这张卡？</h3>
                {/* 退场本身不需要理由。原先这一格只有六颗原因按钮，想丢掉一张卡
                    就得先替它编一个说法——而「不保留」是审核里最高频的动作之一。
                    会话层本来就备着兜底（`review()` 的 `reasonCode ?? "not_useful"`），
                    只是 UI 永远走不到：这里补一颗直接退场的按钮，原因收进下面那组，
                    选了照样跟着走，只是不再是必经的一步。 */}
                <button type="button" className="button" disabled={locked} onClick={() => void onReview(card, "reject")}><X size={16} aria-hidden="true" />不保留这张</button>
                <p className="small">下面这些是可选的，写下来能帮下一次制卡更贴近你。</p>
                <div className="reject-reasons__choices">{REJECT_REASONS.map((reason) => <button key={reason.value} type="button" className="button" disabled={locked} onClick={() => void onReview(card, "reject", reason.value)}>{reason.label}</button>)}</div>
                <button type="button" className="text-action" disabled={locked} onClick={() => setPane("front")}>取消不保留</button>
              </div> : null}
              {pane === "stack" ? <nav className="candidate-stack-list" aria-label="选择候选卡">{candidates.map((candidate, index) => <button key={candidate.candidateId} type="button" disabled={locked} aria-current={candidate.candidateId === card.candidateId ? "true" : undefined} onClick={() => { setActiveCandidateId(candidate.candidateId); setPane("front"); }}>
                <span>{String(index + 1).padStart(2, "0")}</span><span><strong><CandidateText text={candidate.objective.publicSummary} /></strong><small>{candidateDecisionLabel(candidate)}</small></span>
              </button>)}</nav> : null}
            </CandidateCardFace>
            <footer className="candidate-card__back-footer">{pane === "answers" ? "查看过的答案会计入首次验证的等待期" : pane === "reject" ? "提交成功后，这张卡才会退场" : "决定由你做，保存后才进入学习卡组"}</footer>
          </>} />
  </section>;
}
