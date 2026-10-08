import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Loader2, Sparkles, X } from "lucide-react";
import { AI_CONSENT_VERSION } from "@astella/shared/desktop-ipc-contracts";
import { useRoomStore } from "../../../app/room-store";
import { resolveSceneMotionMode } from "../../../scene/scene-motion";
import { useTactileSurface } from "../../motion/use-tactile-surface";
import { AiConsentTerms } from "../../ai-consent-terms";
import { companionLayoutBounds } from "../companion-visible-bounds";
import { guideWindowMask, placeGuideChapter } from "./guide-layout";
import type { CompanionGuideController } from "./use-companion-guide";

/** 先完成本人的同意，再挂载演示和讲解。这里不接合成、问一句或真实页面导航。 */
export function GuideConsentEntry({ guide }: { guide: CompanionGuideController }) {
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wash = useRef<HTMLDivElement>(null);
  const [accepted, setAccepted] = useState(false);
  const termsId = useId();
  const mode = resolveSceneMotionMode(useRoomStore(state => state.motionMode), useRoomStore(state => state.reducedMotion));
  const busy = guide.consentLoading || guide.consentSaving;
  const checking = guide.consent === "unknown" && !guide.consentError;
  useTactileSurface(root, "guide-consent");
  useLayoutEffect(() => {
    useRoomStore.getState().setCompanionGuideFilm(true);
    return () => useRoomStore.getState().setCompanionGuideFilm(false);
  }, []);
  useLayoutEffect(() => {
    const arrange = () => {
      const character = document.querySelector<HTMLElement>('.companion-presence:not([aria-hidden="true"]):not([data-companion-unavailable="true"]) .window-live2d');
      const bounds = character?.getClientRects().length ? companionLayoutBounds(character) : null;
      const companion = bounds ? { left: bounds.left, top: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top } : null;
      if (wash.current) wash.current.style.maskImage = guideWindowMask({ width: innerWidth, height: innerHeight }, companion, null);
      if (!root.current) return;
      const placement = placeGuideChapter({ width: innerWidth, height: innerHeight }, companion);
      root.current.style.setProperty("--guide-consent-left", `${placement.left}px`);
      root.current.style.setProperty("--guide-consent-width", `${Math.min(632, placement.width)}px`);
    };
    arrange();
    const timer = window.setInterval(arrange, 160);
    window.addEventListener("resize", arrange);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", arrange); };
  }, []);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = root.current;
    if (!element) return;
    const siblings = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== element);
    const inert = siblings.map(node => ({ node, value: node.inert === true }));
    inert.forEach(({ node }) => { node.inert = true; });
    heading.current?.focus({ preventScroll: true });
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) heading.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      inert.forEach(({ node, value }) => { node.inert = value; });
      if (previous?.isConnected && (element.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, []);
  const pause = () => { if (!guide.consentSaving) guide.pause(); };
  return createPortal(<div ref={root} className="guide-consent" data-motion={mode} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); pause(); }
    if (event.key !== "Tab") return;
    const controls = [...root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]') ?? []];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === heading.current)) { event.preventDefault(); first?.focus(); }
  }}>
    <div ref={wash} className="guide-consent__wash" aria-hidden="true" />
    <section className="guide-consent__paper" data-checking={checking || undefined} role="dialog" aria-modal="true" aria-labelledby="guide-consent-title" aria-describedby="guide-consent-intro" data-companion-owned="true">
      <header className="guide-consent__header"><span><Sparkles size={15} />欢迎来到拾星书房</span><button type="button" className="guide-consent__close" aria-label={checking ? "稍后继续" : "暂不签署，稍后继续"} disabled={guide.consentSaving} onClick={pause}><X size={17} /></button></header>
      <div className="guide-consent__reading">
        <div className="guide-consent__title"><small>伴星带路 · 开始之前</small><h2 id="guide-consent-title" ref={heading} tabIndex={-1}>{checking ? "正在确认你的使用状态" : "先了解 AI 的使用方式"}</h2><p id="guide-consent-intro">{checking ? "确认后，我们会接着你的带路进度。" : "伴星的对话、笔记学习和语音讲解会使用 AI。开始带路前，请阅读并确认下面的使用协议。"}</p></div>
        {!checking ? <div className="guide-consent__terms" id={termsId}><div className="guide-consent__terms-label"><b>AI 使用协议</b><small>版本 {AI_CONSENT_VERSION.replace("ai-consent-", "")}</small></div><AiConsentTerms /></div> : null}
      </div>
      <footer className="guide-consent__footer">
        {!checking ? <button type="button" className="guide-consent__accept" role="checkbox" aria-checked={accepted} aria-controls={termsId} disabled={busy || guide.consent !== "required"} onClick={() => setAccepted(value => !value)}><span aria-hidden="true">{accepted ? <Check size={15} /> : null}</span>我已阅读并同意《AI 使用协议》</button> : null}
        <div className="guide-consent__status" data-state={guide.consentError ? "error" : busy ? "loading" : "ready"} aria-live="polite">{guide.consentError ? <p role="alert">{guide.consent === "unknown" ? "暂时没能读取你的签署状态。" : "这次签署没有完成。"}<span>{guide.consentError}</span></p> : busy ? <p><Loader2 size={14} />{guide.consentSaving ? "正在确认签署结果…" : "正在读取你的签署状态…"}</p> : null}</div>
        <div className="guide-consent__actions"><button type="button" className="guide-consent__later" disabled={guide.consentSaving} onClick={pause}>{checking ? "稍后继续" : "暂不签署"}</button>{checking ? null : guide.consent === "unknown" && guide.consentError ? <button type="button" className="guide-consent__submit" disabled={busy} onClick={() => void guide.retryConsent()}>重新读取<ArrowRight size={17} /></button> : <button type="button" className="guide-consent__submit" disabled={!accepted || busy || guide.consent !== "required"} onClick={() => void guide.signConsent()}>{guide.consentSaving ? "正在签署…" : "同意并开始带路"}{guide.consentSaving ? <Loader2 size={17} /> : <ArrowRight size={17} />}</button>}</div>
        {!checking ? <small className="guide-consent__later-note">同意后会开启外部 AI，可随时在设置中关闭。暂不签署也可以自己浏览书房。</small> : null}
      </footer>
    </section>
  </div>, document.body);
}
