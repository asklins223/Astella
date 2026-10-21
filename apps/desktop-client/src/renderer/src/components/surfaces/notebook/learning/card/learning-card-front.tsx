import { ArrowLeft, ArrowRight, BookOpen, Check, Clock3, Info, Layers, LoaderCircle, RotateCcw, Sparkles, Star } from "lucide-react";
import { useState } from "react";
import type { LearningCardController } from "./use-learning-card";
import { attemptDate, hasAnswer, isSkipped, outcome, OUTCOME_LABEL, TYPE_LABEL } from "./card-model";

export function CardStars({ value, label = "最佳" }: { value: number | null; label?: string }) {
  return <span className="lc-stars" aria-label={value === null ? "尚无星级" : `${label} ${value} 星`}>
    {[0, 1, 2, 3, 4].map((index) => <Star key={index} aria-hidden="true" data-lit={value !== null && index < value || undefined} />)}
  </span>;
}
function CardFace({ controller: c, title, preview = false, count = 6 }: { controller: LearningCardController; title: string; preview?: boolean; count?: number }) {
  const types = c.card ? [...new Set(c.card.questions.map((question) => question.type))] : [];
  const complete = c.history.filter((item) => item.status === "completed");
  const answered = c.card?.questions.filter((question) => hasAnswer(question, c.drafts[question.questionId]) || isSkipped(c.drafts[question.questionId])).length ?? 0;
  const last = complete[0] ?? null;
  return <div className={`lc-card-stack ${preview ? "lc-card-stack--preview" : ""}`}><article className="lc-card-face" data-lit={Boolean(c.card && c.card.bestStars !== null) || undefined}>
    <div className="lc-card-copy"><div className="lc-eyebrow"><Layers size={16} />学习卡 <span>{c.card?.questions.length ?? count} 道题</span></div>
      <h2>{title}</h2>
      <div className="lc-card-rating"><CardStars value={preview ? null : c.card?.bestStars ?? null} /><small>{preview ? "第一次练习，从这里开始" : c.card?.bestStars === null ? "还未点亮 · 等一次认真尝试" : `最佳 ${c.card?.bestScore ?? 0} 分 · ${c.card?.bestStars ?? 0} 星`}</small></div>
      <div className="lc-type-tags">{preview ? <span>题型随笔记内容搭配</span> : types.map((type) => <span key={type}>{TYPE_LABEL[type]}<b>{c.card?.questions.filter((question) => question.type === type).length}</b></span>)}</div>
      {!preview && (c.card?.omittedQuestionCount ?? 0) > 0 ? <p className="lc-card-omitted"><Info aria-hidden="true" />有 {c.card!.omittedQuestionCount} 道题未通过校验，没有收录</p> : null}
      <div className="lc-card-length"><span>{c.card?.questions.length ?? count} 道题</span><i />一题一页<i />可以跳过，交卷后一起回看</div>
    </div>
    {!preview && c.card ? <ol className="lc-card-contents" aria-label="这张卡的题目">{c.card.questions.map((question, index) => <li key={question.questionId}>
      <span className="lc-contents-number">{String(index + 1).padStart(2, "0")}</span>
      <span className="lc-contents-type">{TYPE_LABEL[question.type]}</span>
      <span className="lc-contents-stem">{question.stem}</span>
      {last ? <span className={`lc-contents-mark lc-contents-mark--${outcome(last, question.questionId)}`} aria-label={OUTCOME_LABEL[outcome(last, question.questionId)]}>{OUTCOME_LABEL[outcome(last, question.questionId)]}</span> : null}
    </li>)}</ol> : null}
    {!preview && <div className="lc-card-cta"><button type="button" className="lc-btn lc-btn--green" data-card-focus="practice" disabled={c.busy} onClick={() => void c.start()}>{c.busy ? <LoaderCircle className="lc-spin" size={17} /> : <ArrowRight size={17} />}{c.attempt?.status === "in_progress" ? `继续作答 · ${answered}/${c.card?.questions.length}` : complete.length ? "再练一次" : "开始练习"}</button><small>星级保留这版笔记的最佳一次</small></div>}
  </article></div>;
}
export function LearningCardFront({ controller: c, title, noteVersionId }: { controller: LearningCardController; title: string; noteVersionId: string | null }) {
  const last = c.history.find((item) => item.status === "completed");
  return <div className="lc-front-scroll">
    <div className="lc-front-layout"><CardFace controller={c} title={title} /><aside className="lc-practice-record"><header><h2><Clock3 size={17} />练习情况</h2><button type="button" className="lc-text-btn" onClick={() => void c.load(true)} aria-label="刷新练习记录"><RotateCcw size={15} /></button></header>
      {last ? <><div className="lc-last-score"><span>最近一次</span><strong>{last.score}<small> / 100</small></strong><small>{attemptDate(last.completedAt ?? last.startedAt)}</small></div><div className="lc-last-questions">{c.card?.questions.map((question, index) => <button type="button" key={question.questionId} className={`lc-result-dot lc-result-dot--${outcome(last, question.questionId)}`} data-card-focus={`question:${question.questionId}`} aria-label={`第 ${index + 1} 题，${OUTCOME_LABEL[outcome(last, question.questionId)]}，查看详情`} onClick={() => c.openResult(last, question.questionId)}>{index + 1}</button>)}</div><button type="button" className="lc-btn lc-btn--soft lc-record-link" data-card-focus="report" onClick={() => c.openResult(last)}>查看本次答题与总结<ArrowRight size={15} /></button></> : <div className="lc-first-record"><BookOpen size={35} strokeWidth={1.3} /><h3>第一份收获，等你写下。</h3><p>先自己想一想。交卷后再一起看答案、原文和伴星的总结。</p></div>}
      {c.history.filter((item) => item.status === "completed").length > 1 && <div className="lc-history-list"><h3>之前的练习</h3>{c.history.filter((item) => item.status === "completed").slice(1, 5).map((item) => <button type="button" key={item.attemptId} data-card-focus={`attempt:${item.attemptId}`} onClick={() => c.openResult(item)}><span>{attemptDate(item.completedAt ?? item.startedAt)}</span><b>{item.score} 分</b><ArrowRight size={13} /></button>)}</div>}
      {c.attempt?.status === "grading_failed" && <div className="lc-grading-retry"><p>上次答案已保存，批改尚未完成。</p><button type="button" className="lc-btn lc-btn--soft" disabled={c.busy} onClick={() => void c.submit()}>重新批改</button></div>}
    </aside></div>
    <div className="lc-front-footer">{c.card?.noteVersionId !== noteVersionId ? <button type="button" className="lc-btn lc-btn--peach" disabled={c.busy || !noteVersionId} onClick={() => c.setScene("setup")}><Sparkles size={16} />按当前版本生成新卡</button> : <p><Check size={15} />学习卡与这版笔记一起保存，重练不会降低已有星级。</p>}</div>
  </div>;
}
export function LearningCardSetup({ controller: c, title, canGenerate }: { controller: LearningCardController; title: string; canGenerate: boolean }) {
  const [count, setCount] = useState<4 | 6 | 8>(6);
  return <div className="lc-setup-scroll"><div className="lc-setup-layout"><section className="lc-setup-paper"><div className="lc-setup-title"><Sparkles size={25} /><div><h2>准备你的配套练习</h2><p>{title}</p></div></div><fieldset><legend>这次准备多少道题？</legend><div className="lc-count-options">{([4, 6, 8] as const).map((value) => <button type="button" key={value} aria-pressed={count === value} onClick={() => setCount(value)}><strong>{value}<small> 题</small></strong><span>{value === 4 ? "轻轻试一试" : value === 6 ? "刚刚好" : "多想深一点"}</span>{count === value && <Check size={15} />}</button>)}</div></fieldset><div className="lc-generation-promises"><p><BookOpen size={17} /><span><strong>围绕已保存的原文出题</strong><small>题型随内容搭配，每道题都有可核对的依据。</small></span></p><p><Layers size={17} /><span><strong>一页一题，保持专注</strong><small>自由跳题；答案、原文和总结在交卷后一起打开。</small></span></p><p><Star size={17} /><span><strong>把每一次认真尝试收好</strong><small>得分按所有题目等权计算，星级保留最佳一次。</small></span></p></div><footer><button type="button" className="lc-btn lc-btn--green" disabled={!canGenerate || c.busy} onClick={() => void c.generate(count)}>{c.busy ? <LoaderCircle size={17} className="lc-spin" /> : <Sparkles size={17} />}{c.busy ? "正在创建…" : "生成这张学习卡"}</button><small>{canGenerate ? "生成需要一点时间，可以先去读别的内容。" : "请先保存笔记，再回来生成。"}</small></footer>{c.card && <button type="button" className="lc-text-btn" onClick={() => c.setScene("front")}><ArrowLeft size={14} />先看已有学习卡</button>}</section><div className="lc-setup-preview"><CardFace controller={{ ...c, card: null }} title={title} preview count={count} /><p>根据已保存的笔记版本生成，完成练习后点亮星级。</p></div></div></div>;
}
export function LearningCardGenerating({ onLeave, onRefresh }: { onLeave: () => void; onRefresh: () => void }) {
  return <div className="lc-state-center"><section className="lc-generation-paper" aria-busy="true"><div className="lc-making-object" aria-hidden="true"><i /><i /><i><Layers size={43} strokeWidth={1.25} /></i></div><span className="lc-eyebrow">把知识，整理成可以练习的样子</span><h1>正在制作你的学习卡</h1><p>读取笔记、搭配题型，再逐题核对原文依据。<br />只有通过校验的题目，才会收进这张卡。</p><div className="lc-generation-progress" role="status"><LoaderCircle size={16} className="lc-spin" />正在生成并核对题目</div><p className="lc-state-small">可以离开这一页，回来后会继续显示实际进度。</p><div className="lc-state-actions"><button type="button" className="lc-btn lc-btn--peach" onClick={onLeave}>先回笔记</button><button type="button" className="lc-text-btn" onClick={onRefresh}><RotateCcw size={14} />刷新状态</button></div></section></div>;
}
