import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, Compass, Pause, RotateCcw, X } from "lucide-react";
import gsap from "gsap";
import { useRoomStore } from "../../../app/room-store";
import { useHomeV2 } from "../../home-v2/HomeV2Experience";
import { resolveSceneMotionMode } from "../../../scene/scene-motion";
import { feedSelectionToCompanion } from "../companion-feed";
import { GUIDE_JOURNEY_LABELS, GUIDE_PRACTICE_EVENT, GUIDE_STEPS, GUIDE_TOPICS, WELCOME_TITLES, guideFeatureAvailable } from "./guide-definitions";
import { GuidanceScene } from "./GuidanceScene";
import { GuidanceNarration } from "./GuidanceNarration";
import { useGuideAnchor } from "./use-guide-anchor";
import { guidePointerPath, guideWindowMask, placeGuidePointer, type GuideRect } from "./guide-layout";
import type { CompanionGuideController } from "./use-companion-guide";

export function CompanionGuidanceStage({ guide }: { guide: CompanionGuideController }) {
  const active = guide.session;
  if (!active) return null;
  return <ActiveGuidanceStage guide={guide} topicId={active.topic} index={active.index} />;
}

function ActiveGuidanceStage({ guide, topicId, index }: { guide: CompanionGuideController; topicId: string; index: number }) {
  const { runFeature } = useHomeV2();
  const mode = resolveSceneMotionMode(useRoomStore(state => state.motionMode), useRoomStore(state => state.reducedMotion));
  const surface = useRoomStore(state => state.surface);
  const destination = useRoomStore(state => state.destination);
  const topic = GUIDE_TOPICS.find(item => item.id === topicId)!;
  const step = GUIDE_STEPS[topic.steps[index]];
  const welcome = topic.id === "welcome";
  const last = index === topic.steps.length - 1;
  const anchor = useGuideAnchor(`${step.anchor}, .guidance-stage__visit`);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wash = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const route = useRef<SVGPathElement>(null);
  const halo = useRef<HTMLDivElement>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const [phase, setPhase] = useState(mode === "off" ? 2 : 0);
  const [replay, setReplay] = useState(0);
  const [practicing, setPracticing] = useState(false);
  const practiceRef = useRef(false);
  const setPractice = useCallback((value: boolean) => { practiceRef.current = value; setPracticing(value); }, []);
  const initialPage = useRef({ surface, destination });
  const speechId = `guidance:${topicId}:${step.id}:${practicing ? "practice" : "tour"}`;

  const arrange = useCallback((companion: GuideRect | null) => {
    const viewport = { width: innerWidth, height: innerHeight };
    const currentAnchor = anchorRef.current;
    if (wash.current) wash.current.style.maskImage = guideWindowMask(viewport, companion, currentAnchor);
    // Keep the same paper across chapters, on whichever side has room beside the resident.
    const margin = innerWidth < 1000 ? 76 : 104;
    const narrationWidth = root.current?.querySelector<HTMLElement>(".guidance-narration")?.getBoundingClientRect().width ?? 310;
    const narrationLeft = Math.max(12, Math.min(companion ? companion.left + companion.width - narrationWidth : innerWidth - narrationWidth - 18, innerWidth - narrationWidth - 12));
    const characterOnRight = !companion || companion.left + companion.width / 2 > innerWidth / 2;
    const left = characterOnRight ? margin : Math.max(margin, companion!.left + companion!.width + 32, narrationLeft + narrationWidth + 24);
    // Reserve the narration column before unfolding secondary pieces, not just after they appear.
    const available = characterOnRight ? Math.min(companion ? companion.left - left - 30 : innerWidth, narrationLeft - left - 24) : innerWidth - left - 36;
    const width = Math.min(1100, Math.max(360, available));
    root.current?.style.setProperty("--guidance-art-left", `${Math.round(left)}px`);
    root.current?.style.setProperty("--guidance-art-width", `${Math.round(width)}px`);
    if (halo.current) {
      halo.current.hidden = !companion;
      if (companion) Object.assign(halo.current.style, { left: `${companion.left - 30}px`, top: `${companion.top - 28}px`, width: `${companion.width + 60}px`, height: `${companion.height + 56}px` });
    }
    if (!currentAnchor || !pointer.current) return;
    const obstacles: GuideRect[] = [...root.current?.querySelectorAll<HTMLElement>(".guidance-narration, .guidance-stage__controls, .guidance-stage__journey, .guidance-stage__heading, .guidance-scene [data-guide-object]") ?? []]
      .filter(node => node.getClientRects().length && getComputedStyle(node).opacity !== "0" && !node.closest('[aria-hidden="true"]'))
      .map(node => node.getBoundingClientRect());
    if (companion) obstacles.push(companion);
    const placed = placeGuidePointer(viewport, currentAnchor, pointer.current.getBoundingClientRect(), obstacles);
    Object.assign(pointer.current.style, { left: `${Math.round(placed.left)}px`, top: `${Math.round(placed.top)}px` });
    route.current?.setAttribute("d", guidePointerPath(placed, currentAnchor));
  }, []);

  useEffect(() => {
    if (initialPage.current.surface !== surface || initialPage.current.destination !== destination) {
      // A guided visit keeps its position. An unrelated route yields to the user's new intent.
      if (!practiceRef.current) guide.pause();
      initialPage.current = { surface, destination };
    }
  }, [surface, destination, guide.pause]);
  useEffect(() => {
    document.body.dataset.companionGuidance = practicing ? "practice" : "tour";
    return () => { delete document.body.dataset.companionGuidance; };
  }, [practicing]);
  useEffect(() => {
    const practice = () => setPractice(true);
    const followTarget = (event: MouseEvent) => {
      if (anchorRef.current?.element.contains(event.target as Node) && !anchorRef.current.element.closest(".guidance-stage")) setPractice(true);
    };
    window.addEventListener(GUIDE_PRACTICE_EVENT, practice);
    document.addEventListener("click", followTarget, true);
    return () => { window.removeEventListener(GUIDE_PRACTICE_EVENT, practice); document.removeEventListener("click", followTarget, true); };
  }, [setPractice]);
  useLayoutEffect(() => {
    const element = anchor?.element;
    if (!element || element.closest(".guidance-stage")) return;
    const oldTarget = element.getAttribute("data-companion-guide-target"), title = element.getAttribute("title");
    element.dataset.companionGuideTarget = step.id;
    element.removeAttribute("title");
    return () => {
      if (oldTarget === null) delete element.dataset.companionGuideTarget; else element.setAttribute("data-companion-guide-target", oldTarget);
      if (title !== null && !element.hasAttribute("title")) element.setAttribute("title", title);
    };
  }, [anchor?.element, step.id]);
  useLayoutEffect(() => { setPractice(false); heading.current?.focus({ preventScroll: true }); }, [topicId, index, setPractice]);
  useLayoutEffect(() => {
    setPhase(mode === "off" ? 2 : 0);
    if (mode === "off" || practicing) return;
    const scope = gsap.context(() => {
      timeline.current = gsap.timeline();
      // The folio's position is a continuous CSS transition; only its new content fades in.
      timeline.current.fromTo("[data-guide-content]", { opacity: .3 }, { opacity: 1, duration: mode === "full" ? .42 : .16, clearProps: "opacity" });
      if (mode === "full") root.current?.querySelectorAll<SVGPathElement>("[data-guide-draw]").forEach(path => {
        if (!path.getTotalLength) return;
        const length = path.getTotalLength();
        timeline.current!.fromTo(path, { strokeDasharray: length, strokeDashoffset: length }, { strokeDashoffset: 0, duration: 1.1, ease: "power2.inOut", clearProps: "strokeDasharray,strokeDashoffset" }, .05);
      });
      timeline.current.call(() => setPhase(1), undefined, mode === "full" ? 1.65 : .55).call(() => setPhase(2), undefined, mode === "full" ? 4.3 : 1.2);
      if (mode === "full") gsap.fromTo("[data-guide-spark]", { opacity: .3, scale: .65, transformOrigin: "center" }, { opacity: 1, scale: 1.1, duration: 1.6, stagger: .18, repeat: 1, yoyo: true, ease: "sine.inOut" });
    }, root);
    return () => { timeline.current?.kill(); timeline.current = null; scope.revert(); };
  }, [step.id, topicId, mode, replay, practicing]);

  const advance = (direction = 1) => { setPractice(false); guide.next(direction); };
  const finish = () => { guide.next(1); if (step.feature && guideFeatureAvailable(step)) runFeature(step.feature); };
  const visit = () => {
    if (!guideFeatureAvailable(step)) return;
    if (welcome && last) { finish(); return; }
    setPractice(true);
    if (step.id === "room") window.dispatchEvent(new CustomEvent("ailearn:space-menu-open"));
    else if (step.feature) runFeature(step.feature);
  };
  const ask = () => {
    guide.pause();
    feedSelectionToCompanion({ source: "selection", text: `伴星带路：${topic.title} / ${step.title}\n刚才的讲解：${step.detail}\n当前空间：${guide.identity?.name ?? "当前书房"}。预制演示是教学示例，未创建真实笔记、任务或学习记录。` });
  };
  const narration = practicing ? step.practice : step.id === "space" ? guide.identity?.role === "member"
    ? "我们到了。这里的共享内容可以阅读，你的回想与学习记录属于自己。先看看这里有什么，再挑一篇开始。"
    : "我们到了。门牌上是当前空间，材料都按这间书房收好。先看看这里的笔记，再挑一个想学的开始。" : step.cue;
  const nextLabel = last ? welcome ? "开始我的学习" : "完成这段带路" : `接着，${GUIDE_JOURNEY_LABELS[topic.steps[index + 1]]}`;
  const fallbackAnchor = Boolean(anchor?.element.closest(".guidance-stage"));
  return createPortal(<div ref={root} className="guidance-stage" role="region" aria-labelledby="guidance-stage-title" data-motion={mode} data-step={step.id} data-view={practicing ? "practice" : "tour"}>
    <div ref={wash} className="guidance-stage__wash" aria-hidden="true" />
    <div className="guidance-stage__atmosphere" aria-hidden="true"><i /><i /><i /></div>
    <div ref={halo} className="guidance-stage__companion-halo" aria-hidden="true" />
    <nav className="guidance-stage__journey" aria-label="连续带路路线"><div><Compass size={17} /><span>{welcome ? "伴星陪你，从这里开始" : topic.title}</span>{!welcome ? <button type="button" onClick={() => guide.start("welcome")}>完整走一遍<ArrowRight size={12} /></button> : <small>一个问题，一路走到开始学习</small>}</div><ol>{topic.steps.map((id, position) => <li key={id} data-state={position < index ? "done" : position === index ? "current" : "ahead"}><button type="button" aria-current={position === index ? "step" : undefined} aria-label={`第 ${position + 1} 站：${GUIDE_JOURNEY_LABELS[id]}`} onClick={() => advance(position - index)}><span>{position < index ? <Check size={13} /> : String(position + 1).padStart(2, "0")}</span><b>{GUIDE_JOURNEY_LABELS[id]}</b></button></li>)}</ol></nav>
    <header className="guidance-stage__heading"><span>{String(index + 1).padStart(2, "0")}<i />{practicing ? "入口已打开 · 可以实际试试" : welcome ? "跟着同一个问题，接着往下走" : "在书房里，边看边听"}</span><h2 ref={heading} tabIndex={-1} id="guidance-stage-title">{welcome ? WELCOME_TITLES[step.id] ?? step.title : step.title}</h2></header>
    <div className="guidance-stage__story" aria-hidden={practicing || undefined} inert={practicing || undefined}><GuidanceScene step={step} guide={guide} phase={phase} onPhase={beat => { timeline.current?.kill(); setPhase(beat); }} /></div>
    {anchor ? <><svg className="guidance-stage__route" aria-hidden="true" width="100%" height="100%"><defs><marker id="guidance-route-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="currentColor" strokeWidth="1.5" /></marker></defs><path ref={route} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 6" markerEnd="url(#guidance-route-arrow)" /></svg><div className="companion-guide-anchor" aria-hidden="true" style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }} /><div ref={pointer} className="guidance-stage__pointer"><span><i>{index + 1}</i>{fallbackAnchor ? "从这个按钮打开真实入口" : step.target}</span><button type="button" onClick={visit}>{step.action ?? "带我去这里"}<ArrowRight size={13} /></button></div></> : null}
    <GuidanceNarration text={narration} speechId={speechId} replay={replay} voiceOff={guide.account?.voiceOff === true} chapter={`伴星带路 · ${index + 1} / ${topic.steps.length}`} anchor={anchor} onAsk={ask} onCompanionBounds={arrange} />
    <footer className="guidance-stage__controls">
      <div className="guidance-stage__navigation"><button type="button" aria-label="上一步" disabled={index === 0} onClick={() => advance(-1)}><ArrowLeft size={17} /></button><button type="button" aria-label="重播本段" onClick={() => { setPractice(false); setReplay(value => value + 1); }}><RotateCcw size={16} /></button><div className="guidance-stage__next-cue"><small>{practicing ? "位置留在这里，试过后继续" : last ? "认识了入口，就可以开始了" : "下一站"}</small><b>{last ? "换成你想学的内容" : GUIDE_JOURNEY_LABELS[topic.steps[index + 1]]}</b></div>{!practicing && !(welcome && last) ? <button type="button" className="guidance-stage__visit" disabled={!guideFeatureAvailable(step)} onClick={visit}>先去实际试试<ArrowRight size={14} /></button> : null}<button type="button" className="guidance-stage__next" onClick={last && welcome ? finish : () => advance()}>{nextLabel}<ArrowRight size={16} /></button></div>
      <div className="guidance-stage__leaving"><button type="button" onClick={guide.pause}><Pause size={12} />稍后继续</button><button type="button" onClick={guide.end}><X size={12} />结束带看</button><small>{guide.pending ? "位置先保存在本机" : "随时按 Esc 暂停，之后从右上角继续"}</small></div>
    </footer>
  </div>, document.body);
}
