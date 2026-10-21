import { ArrowLeft, BookOpen, Layers, LoaderCircle, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRoomStore } from "../../../../../app/home/room-store";
import { stopCompanionSpeech } from "../../../../../app/companion-session/companion-voice-playback";
import { stopCompanionNotificationSpeech } from "../../../../companion/voice/companion-notification-voice";
import { hasAnswer, isSkipped } from "./card-model";
import { LearningCardFront, LearningCardGenerating, LearningCardSetup } from "./learning-card-front";
import { LearningCardPractice } from "./learning-card-practice";
import { LearningCardCelebration } from "./learning-card-celebration";
import { LearningCardResults } from "./learning-card-results";
import { useLearningCard } from "./use-learning-card";
import { isImmersiveCardScene, useLearningCardPresentation } from "./learning-card-presentation";

function CardDialog({ children, label, onClose }: { children: ReactNode; label: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const origin = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="lc-dialog" aria-label={label} onCancel={(event) => { event.preventDefault(); onClose(); }}><button type="button" className="lc-dialog-close" aria-label="关闭" onClick={onClose}><X size={19} /></button>{children}</dialog>;
}
export function LearningCardPage({ noteId, noteVersionId, title, onClose }: { noteId: string; noteVersionId: string | null; title: string; onClose: () => void }) {
  const c = useLearningCard(noteId, noteVersionId);
  const [dialog, setDialog] = useState<"leave" | "submit" | null>(null);
  const page = useRef<HTMLElement>(null);
  const frontFocus = useRef("practice");
  const motionMode = useRoomStore((state) => state.motionMode), reducedMotion = useRoomStore((state) => state.reducedMotion);
  const isolated = c.scene === "practice" || c.scene === "grading";
  const immersive = isImmersiveCardScene(c.scene);
  const owner = useRef({});
  useLayoutEffect(() => { useLearningCardPresentation.setState({ owner: owner.current, scene: c.scene }); }, [c.scene]);
  useLayoutEffect(() => () => {
    if (useLearningCardPresentation.getState().owner === owner.current) useLearningCardPresentation.setState({ owner: null, scene: null, reward: { active: false, at: 0 } });
  }, []);
  useLayoutEffect(() => {
    if (!immersive) return;
    const app = document.querySelector<HTMLElement>(".desktop-app");
    const elements = app ? [...app.querySelectorAll<HTMLElement>(isolated ? ".room-chrome,#main-content,.skip-link,.hud-rail" : "#main-content,.skip-link"), ...(isolated ? document.querySelectorAll<HTMLElement>(".companion-notifications") : [])] : [document.getElementById("root")].filter((element): element is HTMLElement => Boolean(element));
    const prior = elements.map((element) => ({ element, inert: element.inert }));
    const focus = document.activeElement;
    prior.forEach(({ element }) => { element.inert = true; });
    document.body.dataset.learningCardImmersive = "true";
    if (isolated) document.body.dataset.learningCardFocus = "true";
    page.current?.focus({ preventScroll: true });
    return () => {
      prior.forEach(({ element, inert }) => { element.inert = inert; });
      delete document.body.dataset.learningCardImmersive;
      delete document.body.dataset.learningCardFocus;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true });
    };
  }, [immersive, isolated]);
  const previousScene = useRef(c.scene);
  const returningFocus = c.scene === "front" && isImmersiveCardScene(previousScene.current)
    ? previousScene.current === "practice" ? "practice" : frontFocus.current : null;
  useLayoutEffect(() => { previousScene.current = c.scene; }, [c.scene]);
  useLayoutEffect(() => {
    if (!returningFocus) return;
    const restore = () => {
      if (page.current?.dataset.scene !== "front") return;
      const active = document.activeElement;
      if (active !== document.body && active !== document.documentElement && active !== page.current) return;
      const target = [...page.current.querySelectorAll<HTMLButtonElement>("button[data-card-focus]")]
        .find(button => button.dataset.cardFocus === returningFocus)
        ?? page.current.querySelector<HTMLButtonElement>(".lc-card-cta button");
      target?.focus({ preventScroll: true });
    };
    // Cleanup has restored inert and the desk's explicit visibility already.
    // Focus now so the next Tab need not wait for a timer or an animation.
    restore();
    // Some native portal transitions briefly retain inherited visibility. Retry
    // only if focus did not take; a new user focus still wins in restore().
    const pending = document.activeElement === document.body || document.activeElement === document.documentElement
      ? window.setTimeout(restore, 0) : undefined;
    return () => window.clearTimeout(pending);
  }, [c.scene]);
  useEffect(() => {
    if (!isolated) return;
    const room = useRoomStore.getState(), previous = room.companionFocusUntilTaskEnd;
    room.setCompanionFocusUntilTaskEnd(true); stopCompanionSpeech(); stopCompanionNotificationSpeech();
    return () => useRoomStore.getState().setCompanionFocusUntilTaskEnd(previous);
  }, [isolated]);
  const unanswered = c.card?.questions.filter((question) => !hasAnswer(question, c.drafts[question.questionId]) && !isSkipped(c.drafts[question.questionId])).length ?? 0;
  const skipped = c.card?.questions.filter((question) => isSkipped(c.drafts[question.questionId])).length ?? 0;
  const background = c.scene === "setup" || !c.card || c.loadState === "generating" ? "atelier" : c.scene === "front" ? "sunroom" : "focus";
  const content = <section ref={page} className="learning-card-page" data-presentation={immersive ? "immersive" : "desk"} data-scene={c.scene} data-motion={motionMode === "full" && !reducedMotion ? "full" : "off"} data-background={background} data-platform={window.astellaDesktop?.platform ?? "web"} tabIndex={-1} aria-label={immersive ? "学习卡作答与结算" : "这篇的学习卡"} onClickCapture={(event) => {
    if (c.scene !== "front" || !(event.target instanceof Element)) return;
    const key = event.target.closest<HTMLElement>("[data-card-focus]")?.dataset.cardFocus;
    if (key) frontFocus.current = key;
  }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape" && !dialog && c.scene === "practice") { event.preventDefault(); setDialog("leave"); } }}>
    {immersive && <div className="lc-window-drag" aria-hidden="true" />}
    {(c.scene === "results" || c.scene === "celebrate") && <header className="task-title lc-result-page-title"><h1>{c.scene === "results" ? "练习结果" : "练习完成"}</h1><p>这次的作答与收获</p></header>}
    {!immersive && <header className="lc-page-header"><button type="button" className="lc-text-btn" onClick={onClose}><ArrowLeft size={15} />返回笔记</button>{c.versions.length > 1 || (!c.card && c.versions.length > 0) ? <label className="lc-version-picker">学习卡版本<select aria-label="学习卡版本" value={c.card?.cardId ?? ""} disabled={c.busy || c.loadState === "loading"} onChange={(event) => void c.selectVersion(event.currentTarget.value)}>{!c.card && <option value="">{c.loadState === "generating" ? "新版正在生成" : "选择已有版本"}</option>}{c.versions.map((version) => <option key={version.cardId} value={version.cardId}>笔记 v{version.versionNo}{version.noteVersionId === noteVersionId ? " · 当前版" : " · 历史版"}</option>)}</select></label> : <span>{c.card ? c.card.noteVersionId === noteVersionId ? "基于当前笔记版本" : "基于之前的笔记版本" : "笔记配套练习"}</span>}</header>}
    {c.message && <div className="lc-message" role="alert"><p>{c.message}</p><button type="button" aria-label="收起提示" onClick={() => c.setMessage(null)}><X size={16} /></button></div>}
    {c.loadState === "loading" ? <div className="lc-state-center"><section className="lc-state-paper"><LoaderCircle size={31} className="lc-spin" /><h1>正在取回这篇的学习卡</h1><p>题目和之前的练习，会一起放回桌上。</p></section></div>
      : c.loadState === "failed" ? <div className="lc-state-center"><section className="lc-state-paper"><BookOpen size={34} /><h1>这张卡暂时没能打开</h1><p>可以重新读取，或先回笔记继续阅读。</p><button type="button" className="lc-btn lc-btn--green" onClick={() => void c.load()}><RotateCcw size={15} />重新读取</button></section></div>
      : c.loadState === "generating" ? <LearningCardGenerating onLeave={onClose} onRefresh={() => void c.load(true)} />
      : c.scene === "practice" && c.card ? <LearningCardPractice controller={c} title={title} onExit={() => setDialog("leave")} onSubmit={() => setDialog("submit")} />
      : c.scene === "grading" ? <div className="lc-state-center"><section className="lc-state-paper" aria-busy={c.attempt?.status !== "grading_failed"}><button type="button" className="lc-text-btn lc-state-return" onClick={onClose}><ArrowLeft size={15} />返回笔记</button><div className="lc-grading-object"><Layers size={43} /></div><span className="lc-eyebrow">答卷已经收好</span><h1>{c.attempt?.status === "grading_failed" ? "批改暂时没有完成" : "正在认真看看你的思考"}</h1><p>{c.attempt?.status === "grading_failed" ? "答案都还在，可以重新提交批改。" : "核对每一道答案，再整理一份属于这次练习的小结。"}</p><div className="lc-state-actions">{c.attempt?.status === "grading_failed" ? <button type="button" className="lc-btn lc-btn--green" disabled={c.busy} onClick={() => void c.submit()}>重新批改</button> : <p className="lc-generation-progress" role="status"><LoaderCircle size={16} className="lc-spin" />正在批改与整理总结</p>}</div></section></div>
      : c.scene === "celebrate" && c.card && c.result ? <LearningCardCelebration card={c.card} result={c.result} onDetails={() => c.setScene("results")} onCard={() => c.setScene("front")} />
      : c.scene === "results" && c.card && c.result ? <LearningCardResults key={c.result.attemptId} card={c.card} result={c.result} title={title} initialQuestionId={c.resultQuestionId} onCard={() => c.setScene("front")} onStart={() => void c.start()} onCelebrate={() => c.setScene("celebrate")} onRetrySummary={() => void c.retrySummary()} summaryPending={c.summaryPending} busy={c.busy} />
      : !c.card || c.scene === "setup" ? <LearningCardSetup controller={c} title={title} canGenerate={Boolean(noteVersionId)} />
      : <LearningCardFront controller={c} title={title} noteVersionId={noteVersionId} />}
    {dialog === "leave" && <CardDialog label="保存并暂时离开练习" onClose={() => setDialog(null)}><span className="lc-eyebrow">这道题，可以留到下次</span><h2>先把这次的思考收好？</h2><p>已答、跳过和未完成的草稿都会保存。下次从这张卡继续。</p><div className="lc-dialog-actions"><button type="button" className="lc-btn lc-btn--soft" onClick={() => setDialog(null)}>继续答题</button><button type="button" className="lc-btn lc-btn--green" disabled={c.saveState === "saving" && c.busy} onClick={() => void c.leavePractice().then((left) => { if (left) setDialog(null); })}>保存并离开</button></div></CardDialog>}
    {dialog === "submit" && <CardDialog label="确认交卷" onClose={() => setDialog(null)}><span className="lc-eyebrow">把这一次认真尝试，收进卡里</span><h2>准备交卷了吗？</h2><p>已答 {(c.card?.questions.length ?? 0) - unanswered - skipped} 道，跳过 {skipped} 道。{unanswered > 0 ? `还有 ${unanswered} 道未完成，交卷后将作为跳过，按 0 分计入本次成绩。` : "提交后将统一批改，可以查看每道题的答案与原文。"}</p><div className="lc-dialog-actions"><button type="button" className="lc-btn lc-btn--soft" disabled={c.busy} onClick={() => setDialog(null)}>再检查一下</button><button type="button" className="lc-btn lc-btn--green" disabled={c.busy} onClick={() => void c.submit().then(() => setDialog(null))}>{c.busy ? <LoaderCircle size={15} className="lc-spin" /> : <Send size={15} />}{c.busy ? "正在提交…" : unanswered ? "跳过未完成题并交卷" : "确认交卷"}</button></div></CardDialog>}
  </section>;
  // The access gate owns a stacking context during room arrival. Stay beside
  // the resident companion inside that context so its normal z-index works.
  return immersive ? createPortal(content, document.querySelector(".desktop-access-gate__room-content") ?? document.querySelector(".desktop-app") ?? document.body) : content;
}
