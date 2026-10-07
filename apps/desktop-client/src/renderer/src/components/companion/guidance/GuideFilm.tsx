import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Pause, Play, RotateCcw, X } from "lucide-react";
import gsap from "gsap";
import { useRoomStore } from "../../../app/room-store";
import { useHomeV2 } from "../../home-v2/HomeV2Experience";
import { resolveSceneMotionMode } from "../../../scene/scene-motion";
import { useTactileSurface } from "../../motion/use-tactile-surface";
import { feedSelectionToCompanion } from "../companion-feed";
import { GUIDE_JOURNEY_LABELS, GUIDE_STEPS, GUIDE_TOPICS, WELCOME_TITLES, guideFeatureAvailable } from "./guide-definitions";
import { GuidanceScene } from "./GuidanceScene";
import { GuidanceNarration } from "./GuidanceNarration";
import { guideWindowMask, type GuideRect } from "./guide-layout";
import { useGuideFilm } from "./use-guide-film";
import type { CompanionGuideController } from "./use-companion-guide";

export function GuideFilm({ guide }: { guide: CompanionGuideController }) {
  const { runFeature } = useHomeV2();
  const session = guide.session!, topic = GUIDE_TOPICS.find(item => item.id === session.topic)!;
  const step = GUIDE_STEPS[topic.steps[session.index]], last = session.index === topic.steps.length - 1;
  const welcome = topic.id === "welcome";
  const root = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), wash = useRef<HTMLDivElement>(null);
  const [practicing, setPracticing] = useState(false);
  const practice = useRef(false);
  const surface = useRoomStore(state => state.surface), destination = useRoomStore(state => state.destination);
  const page = useRef({ surface, destination });
  const mode = resolveSceneMotionMode(useRoomStore(state => state.motionMode), useRoomStore(state => state.reducedMotion));
  const film = useGuideFilm(step.id, session.index, last, practicing, guide.next);
  const camera = useRef<gsap.core.Tween | null>(null);
  const [stillSeek, setStillSeek] = useState(false);
  const [selectedBeat, setSelectedBeat] = useState<number | null>(null);
  const speechId = `guidance:${topic.id}:${step.id}:${practicing ? "practice" : "film"}`;
  const showing = film.playing && film.visible && !practicing;
  useTactileSurface(root, "guide-film");
  const setPractice = (value: boolean) => { practice.current = value; setPracticing(value); };

  useLayoutEffect(() => {
    useRoomStore.getState().setCompanionGuideFilm(!practicing);
    document.body.dataset.companionGuidance = practicing ? "practice" : "film";
    if (!practicing) heading.current?.focus({ preventScroll: true });
    return () => { useRoomStore.getState().setCompanionGuideFilm(false); delete document.body.dataset.companionGuidance; };
  }, [practicing]);
  useLayoutEffect(() => {
    if (practicing || !root.current) return;
    const background = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== root.current);
    const inert = background.map(node => ({ node, value: node.inert === true }));
    inert.forEach(({ node }) => { node.inert = true; });
    return () => inert.forEach(({ node, value }) => { node.inert = value; });
  }, [practicing]);
  useEffect(() => {
    if (page.current.surface !== surface || page.current.destination !== destination) {
      if (!practice.current) guide.pause();
      page.current = { surface, destination };
    }
  }, [surface, destination, guide.pause]);
  useLayoutEffect(() => { setSelectedBeat(stillSeek ? 2 : null); }, [step.id, film.replay]);
  useLayoutEffect(() => {
    if (mode === "off" || practicing || stillSeek) {
      if (root.current) gsap.set(root.current.querySelectorAll("[data-guide-content]"), { clearProps: "opacity,transform" });
      return;
    }
    const context = gsap.context(() => {
      gsap.fromTo("[data-guide-content]", { opacity: .35, y: 12 }, { opacity: 1, y: 0, duration: mode === "full" ? .7 : .16, ease: "power2.out", clearProps: "opacity,transform" });
      root.current?.querySelectorAll<SVGPathElement>("[data-guide-draw]").forEach(path => {
        if (!path.getTotalLength) return;
        const length = path.getTotalLength();
        gsap.fromTo(path, { strokeDasharray: length, strokeDashoffset: length }, { strokeDashoffset: 0, duration: mode === "full" ? 2.2 : .2, ease: "power2.inOut", clearProps: "strokeDasharray,strokeDashoffset" });
      });
    }, root);
    return () => context.revert();
  }, [step.id, mode, film.replay, practicing, stillSeek]);
  useLayoutEffect(() => {
    const scene = root.current?.querySelector(".guidance-scene");
    if (!scene) return;
    if (mode === "off" || stillSeek) { gsap.set(scene, { scale: 1, x: 0, y: 0, rotation: 0 }); return; }
    camera.current = gsap.to(scene, {
      scale: step.id === "reading" ? 1.045 : step.id === "return" ? .96 : 1,
      x: step.id === "agent" ? -8 : 0, y: step.id === "notes" ? -4 : 0,
      rotation: step.id === "reading" ? -.5 : 0,
      duration: mode === "full" ? 8 : .2, ease: "sine.inOut", overwrite: "auto",
    });
    if (!showing) camera.current.pause();
    return () => { camera.current?.kill(); };
  }, [step.id, mode, film.replay, practicing, stillSeek]);
  useEffect(() => {
    if (!root.current) return;
    for (const motion of root.current.getAnimations?.({ subtree: true }) ?? []) { if (showing) motion.play(); else motion.pause(); }
    for (const animation of gsap.getTweensOf(root.current.querySelectorAll('.guidance-scene, [data-guide-content], [data-guide-draw]'))) {
      if (showing) animation.resume(); else animation.pause();
    }
  }, [showing, step.id]);
  const arrange = useCallback((companion: GuideRect | null) => {
    if (wash.current) wash.current.style.maskImage = guideWindowMask({ width: innerWidth, height: innerHeight }, companion, null);
  }, []);
  const advance = (direction: number) => {
    if (!direction) return;
    setStillSeek(!film.playing); setPractice(false); guide.next(direction);
  };
  const togglePlayback = () => {
    if (stillSeek) { setStillSeek(false); setSelectedBeat(null); film.restart(); }
    else film.toggle();
  };
  const finish = () => { guide.next(1); if (step.feature && guideFeatureAvailable(step)) runFeature(step.feature); };
  const visit = () => {
    if (!guideFeatureAvailable(step)) return;
    if (welcome && last) { finish(); return; }
    setPractice(true);
    if (step.id === "room") window.dispatchEvent(new CustomEvent("astella:space-menu-open"));
    else if (step.feature) runFeature(step.feature);
  };
  const ask = () => {
    guide.pause();
    feedSelectionToCompanion({ source: "selection", text: `伴星带路：${topic.title} / ${step.title}\n刚才的讲解：${step.detail}\n当前空间：${guide.identity?.name ?? "当前书房"}。动画为教学示例，未创建真实笔记、任务或学习记录。` });
  };
  const narration = practicing ? step.practice : step.id === "space" && guide.identity?.role === "member"
    ? "我们到了。共享内容可以阅读，你的回想与学习记录属于自己。挑一篇想读的，我们就从这里开始。" : step.cue;
  const controls = <footer className="guidance-film__controls">
    <div className="guidance-film__transport">
      {practicing ? <button type="button" onClick={() => setPractice(false)}>返回动画</button> : <>
        <button type="button" className="guidance-film__play" aria-label={film.playing ? "暂停引导动画" : "播放引导动画"} onClick={togglePlayback}>{film.playing ? <Pause size={18} /> : <Play size={18} />}</button>
        <button type="button" aria-label="重播当前片段" onClick={() => { setStillSeek(false); setSelectedBeat(null); film.restart(); }}><RotateCcw size={16} /></button>
      </>}
      <button type="button" className="guidance-film__visit" disabled={!guideFeatureAvailable(step)} onClick={visit}>{step.action ?? "打开真实入口"}<ArrowRight size={14} /></button>
      {practicing ? <button type="button" onClick={() => advance(1)}>{last ? "完成这段带路" : `接着，${GUIDE_JOURNEY_LABELS[topic.steps[session.index + 1]]}`}<ArrowRight size={14} /></button> : null}
      <button type="button" className="guidance-film__exit" onClick={guide.end}><X size={14} />{film.finished ? "合上动画" : "跳过引导"}</button>
    </div>
    {!practicing ? <nav className="guidance-film__timeline" aria-label="动画章节"><ol>{topic.steps.map((id, position) => <li key={id} data-state={position === session.index ? "current" : position < session.index ? "before" : "ahead"} style={{ "--film-progress": position < session.index ? 1 : position === session.index ? film.progress : 0 } as CSSProperties}><button type="button" aria-current={position === session.index ? "step" : undefined} aria-label={`第 ${position + 1} 段：${GUIDE_JOURNEY_LABELS[id]}`} onClick={() => advance(position - session.index)}><span /><b>{GUIDE_JOURNEY_LABELS[id]}</b></button></li>)}</ol></nav> : null}
  </footer>;
  return createPortal(<div ref={root} className="guidance-stage guidance-film" role={practicing ? "region" : "dialog"} aria-modal={!practicing || undefined} aria-labelledby="guidance-stage-title" data-companion-owned="true" data-motion={mode} data-step={step.id} data-view={practicing ? "practice" : "film"} data-playing={showing || undefined} data-still-seek={stillSeek || undefined} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); guide.pause(); return; }
    if (practicing || event.key !== "Tab") return;
    const buttons = [...root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []].filter(button => !button.closest('[inert], [aria-hidden="true"]'));
    if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === heading.current)) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <div ref={wash} className="guidance-stage__wash" aria-hidden="true" />
    <div className="guidance-film__light" aria-hidden="true" />
    <header className="guidance-film__heading"><span>{film.finished ? "现在，换成你的故事" : `${session.index + 1} / ${topic.steps.length} · ${welcome ? "初来书房" : topic.title}`}</span><h2 ref={heading} tabIndex={-1} id="guidance-stage-title">{welcome ? WELCOME_TITLES[step.id] ?? step.title : step.title}</h2><p>{film.finished ? "挑一篇笔记，或者写下你自己的问题。" : "伴星陪你，从一个问题出发。"}</p></header>
    <div className="guidance-film__screen" tabIndex={practicing ? -1 : 0} aria-label="引导动画画面" aria-hidden={practicing || undefined} inert={practicing || undefined}>
      <GuidanceScene step={step} guide={guide} phase={selectedBeat ?? (mode === "off" ? 2 : film.phase)} controls={false} onPhase={beat => { setStillSeek(true); setSelectedBeat(beat); film.pause(); }} />
    </div>
    <GuidanceNarration text={narration} speechId={speechId} replay={film.replay} voiceOff={guide.account?.voiceOff === true} consent={guide.consent} chapter={`伴星带路 · ${session.index + 1} / ${topic.steps.length}`} practice={practicing} film={!practicing} playing={showing} onVoicePhase={film.reportVoice} controls={practicing ? controls : null} onAsk={ask} onConsent={guide.openConsentSettings} onCompanionBounds={arrange} />
    {!practicing ? controls : null}
  </div>, document.body);
}
