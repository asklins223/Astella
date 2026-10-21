import { ArrowLeft, ArrowRight, Check, CornerDownLeft, Layers, Pause, Send, SkipForward } from "lucide-react";
import { useEffect, useRef } from "react";
import type { LearningCardController } from "./use-learning-card";
import { answerDraft, hasAnswer, isSkipped, skipAnswer, TYPE_LABEL } from "./card-model";
import { LearningCardAnswer } from "./learning-card-answer";

export function LearningCardPractice({ controller: c, title, onExit, onSubmit }: { controller: LearningCardController; title: string; onExit: () => void; onSubmit: () => void }) {
  const card = c.card!, question = card.questions[c.index] ?? card.questions[0]!;
  const heading = useRef<HTMLHeadingElement>(null), scroll = useRef<HTMLDivElement>(null);
  const answered = card.questions.filter((item) => hasAnswer(item, c.drafts[item.questionId])).length;
  const skipped = card.questions.filter((item) => isSkipped(c.drafts[item.questionId])).length;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); if (scroll.current) scroll.current.scrollTop = 0; }, [question.questionId]);
  const next = () => { if (c.index < card.questions.length - 1) c.setIndex(c.index + 1); else onSubmit(); };
  return <div className="lc-practice" onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); next(); return; }
    if (event.metaKey || event.target instanceof Element && event.target.closest("input,textarea,select,button,[contenteditable]")) return;
    if (event.key === "ArrowRight" && c.index < card.questions.length - 1) { event.preventDefault(); c.setIndex(c.index + 1); }
    if (event.key === "ArrowLeft" && c.index > 0) { event.preventDefault(); c.setIndex(c.index - 1); }
    if (/^[1-9]$/.test(event.key) && ["single_choice", "multi_choice", "true_false"].includes(question.type)) {
      const option = document.querySelectorAll<HTMLButtonElement>(".lc-answer-option")[Number(event.key) - 1]; if (option) { event.preventDefault(); option.click(); }
    }
  }}>
    <header className="lc-practice-header"><div className="lc-exercise-icon"><Layers size={24} /></div><div><h1>{title}</h1><p>学习卡练习 · 一次只想一道题</p></div><span className={`lc-save-label lc-save-label--${c.saveState}`} role="status">{c.saveState === "saving" ? "正在保存…" : c.saveState === "failed" ? "尚未保存，点击重试" : "作答已保存"}{c.saveState === "failed" ? <button type="button" className="lc-text-btn" onClick={() => void c.flush().catch(() => {})}>重试</button> : c.saveState === "saved" ? <Check size={13} /> : null}</span><button type="button" className="lc-text-btn" onClick={onExit}><Pause size={15} />暂时离开</button></header>
    <div className="lc-practice-board"><div className="lc-practice-body"><article className="lc-question-workspace"><div className="lc-question-scroll" ref={scroll}><div className="lc-question-top"><span>{TYPE_LABEL[question.type]}</span><small>第 {String(c.index + 1).padStart(2, "0")} / {String(card.questions.length).padStart(2, "0")} 题</small></div><h2 ref={heading} tabIndex={-1} className="lc-question-stem">{question.stem}</h2><p className="lc-question-hint">{question.type === "multi_choice" ? "选择所有符合题意的答案。" : question.type === "operation" ? "在下方操作区域完成题目要求。" : question.type === "single_choice" || question.type === "true_false" ? "选择你认为正确的答案。" : "按你的理解完成这道题。"}</p>
      {isSkipped(c.drafts[question.questionId]) && <p className="lc-skipped-notice"><SkipForward size={14} />这题暂时跳过了，原有草稿仍为你保留。{hasAnswer(question, answerDraft(c.drafts[question.questionId])) && <button type="button" className="lc-text-btn" onClick={() => c.changeAnswer(question.questionId, answerDraft(c.drafts[question.questionId]))}>使用这份回答</button>}</p>}
      <LearningCardAnswer key={question.questionId} question={question} value={c.drafts[question.questionId]} onChange={(answer) => c.changeAnswer(question.questionId, answer)} />
    </div></article>
    <aside className="lc-answer-sheet" aria-label="答题卡"><header><h2>答题卡</h2><span>{answered + skipped}/{card.questions.length}</span></header><div className="lc-sheet-progress"><i style={{ width: `${(answered + skipped) / card.questions.length * 100}%` }} /></div><nav aria-label="跳转到题目" className="lc-sheet-grid">{card.questions.map((item, index) => {
      const status = isSkipped(c.drafts[item.questionId]) ? "skipped" : hasAnswer(item, c.drafts[item.questionId]) ? "answered" : "empty";
      return <button type="button" key={item.questionId} className={`lc-sheet-cell lc-sheet-cell--${status}`} aria-current={c.index === index ? "step" : undefined} aria-label={`第 ${index + 1} 题，${status === "answered" ? "已作答" : status === "skipped" ? "已跳过" : "未作答"}`} onClick={() => c.setIndex(index)}>{index + 1}<i /></button>;
    })}</nav><div className="lc-sheet-legend"><span><i />未答</span><span><i className="answered" />已答</span><span><i className="skipped" />跳过</span><span><i className="current" />当前</span></div><p className="lc-sheet-tip">点题号自由切换，草稿自动保存。<br />答案与原文在交卷后打开。</p><div className="lc-sheet-submit"><button type="button" className="lc-btn lc-btn--soft" disabled={c.busy} onClick={onSubmit}><Send size={15} />结束并交卷</button><small>已答 {answered} · 跳过 {skipped}</small></div></aside></div>
    <footer className="lc-answer-dock"><div><button type="button" className="lc-btn lc-btn--soft" disabled={c.index === 0 || c.busy} onClick={() => c.setIndex(c.index - 1)}><ArrowLeft size={15} />上一题</button><button type="button" className="lc-text-btn" disabled={c.busy} onClick={() => { c.changeAnswer(question.questionId, skipAnswer(c.drafts[question.questionId])); if (c.index < card.questions.length - 1) c.setIndex(c.index + 1); }}><SkipForward size={15} />先跳过</button></div><span className="lc-keyboard-hint">第 {c.index + 1} / {card.questions.length} 题<span><CornerDownLeft size={12} /> Ctrl / ⌘ + Enter 继续</span></span><button type="button" className="lc-btn lc-btn--peach" disabled={c.busy} onClick={next}>{c.index === card.questions.length - 1 ? "检查并交卷" : "下一题"}<ArrowRight size={16} /></button></footer></div>
  </div>;
}
