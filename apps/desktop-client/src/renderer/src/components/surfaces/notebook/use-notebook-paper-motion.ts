import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";

type PaperKind = "page" | "index" | "side" | "fold" | "stamp";
export type PlayPaperMotion = (element: HTMLElement | null, kind: PaperKind, closing?: boolean) => Animation | null;

/** One interruptible motion owner; editor contents never unmount to animate. */
export function useNotebookPaperMotion(): PlayPaperMotion {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const animations = useRef(new Map<HTMLElement, Animation>());
  useEffect(() => {
    return () => {
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
    };
  }, []);
  useLayoutEffect(() => {
    if (mode !== "off" && !reduced) return;
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
  }, [mode, reduced]);

  return useCallback((element, kind, closing = false) => {
    if (!element) return null;
    const previous = animations.current.get(element);
    const current = getComputedStyle(element);
    const interrupted = previous ? { opacity: current.opacity, transform: current.transform } : null;
    previous?.cancel();
    animations.current.delete(element);
    if (mode === "off" || reduced || typeof element.animate !== "function") return null;
    const easing = current.getPropertyValue("--hud-ease-out").trim();
    if (!easing) return null;
    const distance = kind === "index" ? -28 : kind === "side" ? 32 : 24;
    const displaced = { opacity: .35, transform: kind === "fold" ? "translateY(-12px) scaleY(.97)" : kind === "stamp" ? "scale(1.12) rotate(-6deg)" : `translateX(${distance}px)` };
    const resting = { opacity: 1, transform: kind === "fold" ? "translateY(0) scaleY(1)" : kind === "stamp" ? "scale(1) rotate(-3deg)" : "translateX(0)" };
    const from = interrupted ?? (closing ? resting : displaced);
    const to = closing ? displaced : resting;
    const frames = mode === "lite" ? [{ opacity: from.opacity }, { opacity: to.opacity }] : [from, to];
    const animation = element.animate(frames, {
      duration: mode === "lite" ? 120 : closing ? 160 : kind === "index" ? 200 : 220,
      easing,
    });
    animations.current.set(element, animation);
    void animation.finished.catch(() => undefined).then(() => {
      if (animations.current.get(element) === animation) animations.current.delete(element);
    });
    return animation;
  }, [mode, reduced]);
}

/** Retain only the closing paper; it becomes inert immediately, before its exit. */
export function useNotebookPaperPresence<T>(value: T | null, identity: string, kind: "index" | "side" | "fold", play: PlayPaperMotion) {
  const [present, setPresent] = useState(value !== null);
  const last = useRef(value);
  const latest = useRef(value); latest.current = value;
  if (value !== null) last.current = value;
  const ref = useRef<HTMLElement | null>(null);
  const open = value !== null;
  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      play(ref.current, kind);
      return;
    }
    const animation = play(ref.current, kind, true);
    if (!animation) { setPresent(false); return; }
    void animation.finished.then(() => { if (latest.current === null) setPresent(false); }).catch(() => undefined);
  }, [open, identity, kind, play]);
  return { ref, value: value ?? (present ? last.current : null), closing: !open };
}

export function useNotebookPageTurn(ref: RefObject<HTMLElement | null>, identity: string, play: PlayPaperMotion) {
  const previous = useRef(identity);
  useLayoutEffect(() => {
    if (previous.current === identity) return;
    previous.current = identity;
    play(ref.current, "page");
  }, [identity, play, ref]);
}
