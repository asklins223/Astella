import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NoteLearningCardAttemptV1, NoteLearningCardV1 } from "@astella/shared/note-learning-card-contracts";
import { answerText, feedbackText, outcome, OUTCOME_LABEL, resultCounts, rubricText, summaryText, TYPE_LABEL, type Outcome } from "./card-model";
import { openExternalLink } from "../../../../../app/client/external-link";
import { previewCompanionNote } from "../../../../companion/journal/companion-result-preview";
import { isWebLinkUrl } from "@astella/shared/desktop-ipc-contracts";
import { OperationAnswer } from "./learning-card-answer";
import { record } from "./card-model";
import { CardStars } from "./learning-card-front";

export function LearningCardResults({ card, result, title, initialQuestionId, onCard, onStart, onCelebrate, onRetrySummary, summaryPending = false, busy = false }: { card: NoteLearningCardV1; result: NoteLearningCardAttemptV1; title: string; initialQuestionId?: string | null; onCard: () => void; onStart: () => void; onCelebrate: () => void; onRetrySummary?: () => void; summaryPending?: boolean; busy?: boolean }) {
  const [filter, setFilter] = useState<Outcome | "all">("all");
  const [tab, setTab] = useState<"answers" | "summary">("answers");
  const [replay, setReplay] = useState<string | null>(null);
  const hasSummary = typeof result.summary === "string" ? Boolean(result.summary.trim()) : typeof record(result.summary).text === "string" && Boolean(String(record(result.summary).text).trim());
  const summaryFailed = record(result.summary).status === "failed";
  const heading = useRef<HTMLHeadingElement>(null);
  const paper = useRef<HTMLElement>(null);
  const totals = resultCounts(result, card.questions);
  useEffect(() => {
    const target = initialQuestionId ? [...paper.current?.querySelectorAll<HTMLDetailsElement>(".lc-review-item") ?? []]
      .find(item => item.dataset.questionId === initialQuestionId) : undefined;
    if (!target) { heading.current?.focus({ preventScroll: true }); return; }
    target.open = true;
    target.querySelector("summary")?.focus({ preventScroll: true });
    target.scrollIntoView?.({ behavior: "instant", block: "start" });
  }, [initialQuestionId]);
  return <div className="lc-results"><section ref={paper} className="lc-report-paper" data-directory-content aria-label="练习报告" tabIndex={0}>
    <header className="lc-report-header">
      <div><button type="button" className="lc-text-btn" onClick={onCard}><ArrowLeft size={15} />回到学习卡</button><h1 ref={heading} tabIndex={-1}>{title}</h1><p>本次练习报告 · {card.questions.length} 道题</p></div>
      <div className="lc-report-actions"><button type="button" className="lc-text-btn" onClick={onCelebrate}><Sparkles size={15} />重看庆祝</button><button type="button" className="lc-btn lc-btn--peach" onClick={onStart}>再练一次<ArrowRight size={15} /></button></div>
    </header>
    <div className="lc-report-scroll" tabIndex={0} aria-label="练习报告正文">
      <section className="lc-report-summary" aria-label="得分与答题统计"><div className="lc-report-score"><strong>{result.score}<small> 分</small></strong><CardStars value={result.stars} label="本次" /><p>最佳 {card.bestScore ?? result.score} 分 · {card.bestStars ?? result.stars} 星</p></div>{(["correct", "partial", "wrong", "skipped"] as const).map((type) => <div key={type} className={`lc-summary-stat lc-summary-stat--${type}`}><strong>{totals[type]}</strong><span>{OUTCOME_LABEL[type]}</span></div>)}</section>
      <nav className="lc-report-tabs" aria-label="结果视图"><button type="button" aria-pressed={tab === "answers"} onClick={() => setTab("answers")}>逐题回看</button><button type="button" aria-pressed={tab === "summary"} onClick={() => setTab("summary")}><Sparkles size={15} />伴星总结</button><small>答案、评分与原文依据</small></nav>
      <div className="lc-report-layout" data-view={tab}>
        {tab === "answers" && <aside className="lc-review-sidebar"><h2>答题情况</h2><nav className="lc-review-filters" aria-label="筛选答题情况">{(["all", "correct", "partial", "wrong", "skipped"] as const).map((type) => <button type="button" key={type} aria-pressed={filter === type} onClick={() => setFilter(type)}><span>{type === "all" ? "全部" : OUTCOME_LABEL[type]}</span><b>{type === "all" ? card.questions.length : totals[type]}</b></button>)}</nav><p>展开题目，核对这一次的答案与原文。</p><button type="button" className="lc-text-btn" onClick={() => setTab("summary")}><Sparkles size={14} />阅读完整总结<ArrowRight size={13} /></button></aside>}
        <section className="lc-answer-review">
          {tab === "answers" ? <>{card.questions.filter((question) => filter === "all" || outcome(result, question.questionId) === filter).map((question) => {
            const answer = result.answers.find((item) => item.questionId === question.questionId);
            const state = outcome(result, question.questionId), index = card.questions.indexOf(question);
            const feedback = feedbackText(answer?.feedback), rubric = rubricText(answer?.rubric), grounding = answer?.grounding ?? question.grounding;
            return <details className={`lc-review-item lc-review-item--${state}`} key={question.questionId} data-question-id={question.questionId}>
              <summary><span className="lc-review-number">{String(index + 1).padStart(2, "0")}</span><div><small>{TYPE_LABEL[question.type]}</small><h2>{question.stem}</h2></div><span className={`lc-outcome lc-outcome--${state}`}>{OUTCOME_LABEL[state]}<small>{answer?.score ?? 0} 分</small></span><ChevronDown size={17} /></summary>
              <div className="lc-review-detail"><div className="lc-answer-comparison"><div><small>你的作答</small><p>{answerText(question, answer?.answer)}</p></div><div><small>{rubric ? "评分要点" : "参考答案"}</small><p>{rubric || (answer?.referenceAnswer != null ? answerText(question, answer.referenceAnswer) : "请结合下方原文依据核对。")}</p></div></div>
                {feedback && <p className="lc-question-feedback"><Sparkles size={14} />{feedback}</p>}
                <section className="lc-source-evidence"><header><BookOpen size={15} />原文依据<span>学习卡所用的笔记版本</span></header>{grounding.note.map((passage, i) => <blockquote key={i}><p>{passage.quote}</p><cite>原文第 {passage.blockOrdinal + 1} 段</cite><button type="button" className="lc-text-btn" onClick={(event) => previewCompanionNote({ noteId: card.noteId, noteVersionId: card.noteVersionId, title, blockOrdinal: passage.blockOrdinal, sourceOnly: true }, event.currentTarget)}><BookOpen size={14} />查看当时原文</button></blockquote>)}{grounding.extension && <div className="lc-extension-evidence"><small>{grounding.extension.kind === "ai_generated" ? "AI 补充" : grounding.extension.kind === "web" ? "联网资料" : "已有资料"} · {grounding.extension.title}</small><p>{grounding.extension.quote}</p><p>{grounding.extension.relation}</p>{grounding.extension.kind === "web" && grounding.extension.url && isWebLinkUrl(grounding.extension.url) && <a className="lc-evidence-url" href={grounding.extension.url} onClick={(event) => { event.preventDefault(); void openExternalLink(grounding.extension!.url!); }}>{grounding.extension.url}</a>}</div>}</section>
              {question.type === "operation" && <div><button type="button" className="lc-text-btn" aria-expanded={replay === question.questionId} onClick={() => setReplay(replay === question.questionId ? null : question.questionId)}>回看当时的操作（只读）</button>{replay === question.questionId && <OperationAnswer question={question} value={answer?.answer} readOnly />}</div>}</div>
            </details>;
          })}{filter !== "all" && totals[filter] === 0 && <div className="lc-review-empty">这次没有{OUTCOME_LABEL[filter]}的题目。</div>}</> : <section className="lc-ai-summary"><span className="lc-eyebrow"><Sparkles size={17} />本次练习小结</span><h2>给认真练习的你</h2>{(hasSummary || !summaryPending) && <p>{summaryText(result.summary, card.questions.map((question) => question.questionId))}</p>}{summaryPending && <p role="status">正在重新整理总评，分数、星级与原总评均保留。</p>}{summaryFailed && !summaryPending && <p role="status">这次总评未能更新，可以重试。{hasSummary ? "上方仍是原来的总评。" : "分数和星级已经保留。"}</p>}{onRetrySummary && <button type="button" className="lc-btn lc-btn--soft" disabled={summaryPending || busy} onClick={onRetrySummary}>{summaryPending ? <LoaderCircle size={15} className="lc-spin" /> : <RotateCcw size={15} />}{summaryPending ? "正在生成总评…" : hasSummary ? "重新生成总评" : "重试总评"}</button>}<small>结合这次作答生成，不代表对整体学习水平的判断。</small><button type="button" className="lc-btn lc-btn--soft" onClick={() => { setTab("answers"); setFilter("wrong"); }}>回看答错的题<ArrowRight size={15} /></button></section>}
        </section>
      </div>
    </div>
  </section></div>;
}
