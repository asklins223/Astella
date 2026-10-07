import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useRoomStore } from "../../../app/room-store";
import { HUD_PAGES } from "../../hud/hud-pages";
import { companionLayoutBounds } from "../companion-visible-bounds";
import { placeCompanionNotification } from "../notification-placement";
import { speakCompanionNotification, stopCompanionNotificationSpeech, type NotificationVoicePhase } from "../companion-notification-voice";
import type { GuideRect } from "./guide-layout";

/** Uses the resident's audio graph, priority rules and mouth amplitude. */
export function GuidanceNarration({ text, speechId, replay, voiceOff, consent, chapter, anchor, onAsk, onConsent, onCompanionBounds }: { text: string; speechId: string; replay: number; voiceOff: boolean; consent: "unknown" | "required" | "granted"; chapter: string; anchor: GuideRect | null; onAsk: () => void; onConsent: () => void; onCompanionBounds: (bounds: GuideRect | null) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const muted = useRoomStore(state => state.masterMuted) || voiceOff;
  const hudPage = useRoomStore(state => state.hudPage);
  const formal = HUD_PAGES[hudPage].companion.mode === "assessment";
  const [enabled, setEnabled] = useState(true);
  const [voicePhase, setVoicePhase] = useState<NotificationVoicePhase>("silent");
  const [voiceReplay, setVoiceReplay] = useState(0);
  useEffect(() => {
    if (!enabled || muted || formal) { setVoicePhase("silent"); return; }
    // 没读出来之前不发请求：合成一定被挡在门外，而这一步没有兜底。
    if (consent === "unknown") { setVoicePhase("silent"); return; }
    if (consent === "required") { setVoicePhase("consent_required"); return; }
    let alive = true;
    const allowed = () => alive && !voiceOff && !document.hidden && !useRoomStore.getState().masterMuted && HUD_PAGES[useRoomStore.getState().hudPage].companion.mode !== "assessment";
    const timer = window.setTimeout(() => {
      void speakCompanionNotification({ id: speechId, text, purpose: "guidance", allowed, report: phase => { if (alive) setVoicePhase(phase); } });
    }, 220);
    const visibility = () => { if (document.hidden) stopCompanionNotificationSpeech(speechId); };
    document.addEventListener("visibilitychange", visibility);
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); stopCompanionNotificationSpeech(speechId); };
  }, [speechId, text, replay, voiceReplay, enabled, muted, formal, consent]);
  useLayoutEffect(() => {
    const paper = root.current; if (!paper) return;
    const position = () => {
      const character = document.querySelector<HTMLElement>('.companion-presence:not([aria-hidden="true"]):not([data-companion-unavailable="true"]) .window-live2d');
      const bounds = character?.getClientRects().length ? companionLayoutBounds(character) : null;
      const companion = bounds ? { left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top } : null;
      const obstacles: GuideRect[] = [...document.querySelectorAll<HTMLElement>('.guidance-stage__controls, .guidance-stage__journey, .guidance-stage__heading, .guidance-scene [data-guide-object], .room-control, .companion-hud__controls, .companion-goal-tab')].filter(node => node.getClientRects().length && getComputedStyle(node).opacity !== "0" && !node.closest('[aria-hidden="true"]')).map(node => node.getBoundingClientRect());
      if (anchor) obstacles.push({ left: anchor.left - 12, top: anchor.top - 12, width: anchor.width + 24, height: anchor.height + 24 });
      const placed = placeCompanionNotification({ viewport: { width: innerWidth, height: innerHeight }, paper: paper.getBoundingClientRect(), companion, obstacles, compact: true });
      paper.style.left = `${Math.round(placed.left)}px`; paper.style.top = `${Math.round(placed.top)}px`; paper.dataset.side = placed.side;
      onCompanionBounds(companion);
    };
    position();
    const observer = new ResizeObserver(position); observer.observe(paper);
    const timer = window.setInterval(position, 160);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.clearInterval(timer); window.removeEventListener("resize", position); };
  }, [text, anchor, onCompanionBounds]);
  const speaking = voicePhase === "preparing" || voicePhase === "speaking";
  const quiet = muted || formal || consent !== "granted" || !enabled;
  return <div ref={root} className="guidance-narration" data-companion-owned="true" data-speaking={voicePhase === "speaking" || undefined}>
    <div className="guidance-narration__label"><Sparkles size={14} /><span>{chapter}</span><button type="button" disabled={muted || formal} aria-label={speaking ? "暂停语音讲解" : "播放语音讲解"} title={muted ? "当前总静音" : formal ? "作答时安静带路" : quiet && consent === "required" ? "签署 AI 使用同意后才会出声" : speaking ? "暂停语音讲解" : "播放语音讲解"} onClick={() => { if (speaking) setEnabled(false); else { setEnabled(true); setVoiceReplay(value => value + 1); } }}>{voicePhase === "preparing" && !quiet ? <Loader2 size={14} className="guidance-narration__loading" /> : !quiet ? <Volume2 size={14} /> : <VolumeX size={14} />}</button></div>
    <p aria-live="polite">{text}</p>
    <div className="guidance-narration__foot"><span aria-live="polite">{voicePhase === "preparing" ? "正在准备讲解…" : voicePhase === "speaking" ? "边看，边听我讲" : voicePhase === "consent_required" ? "还差一步：签署 AI 使用同意后，我才被允许念给你听。文字可以先看。" : voicePhase === "failed" ? "声音暂时没接通，文字可以继续看" : muted || formal || !enabled ? "安静带路" : "随时可以问我"}</span>{voicePhase === "consent_required" ? <button type="button" onClick={onConsent}>去设置同意</button> : null}<button type="button" onClick={onAsk}><MessageCircle size={12} />问一句</button></div>
  </div>;
}
