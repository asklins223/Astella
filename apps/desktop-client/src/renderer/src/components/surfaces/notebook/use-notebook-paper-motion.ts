import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";

type PaperKind = "page" | "index" | "side" | "fold" | "stamp";
export type PlayPaperMotion = (element: HTMLElement | null, kind: PaperKind, closing?: boolean) => Animation | null;
type PaperState = { x: number; y: number; scale: number; rotate: number; opacity: number };
type PaperFrame = { value: PaperState; velocity: PaperState };
const rest: PaperState = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 };
const still: PaperState = { x: 0, y: 0, scale: 0, rotate: 0, opacity: 0 };
const channels = ["x", "y", "scale", "rotate", "opacity"] as const;

/** Sample the current trajectory, including velocity, before a reversal. */
function sample(frames: readonly PaperFrame[], progress: number): PaperFrame {
  const at = Math.max(0, Math.min(frames.length - 1, progress * (frames.length - 1)));
  const a = frames[Math.floor(at)]!, b = frames[Math.min(frames.length - 1, Math.ceil(at))]!;
  const fraction = at - Math.floor(at);
  return { value: Object.fromEntries(channels.map(key => [key, a.value[key] + (b.value[key] - a.value[key]) * fraction])) as PaperState,
    velocity: Object.fromEntries(channels.map(key => [key, a.velocity[key] + (b.velocity[key] - a.velocity[key]) * fraction])) as PaperState };
}

function trajectory(from: PaperFrame, target: PaperState, duration: number): PaperFrame[] {
  const frames: PaperFrame[] = [{ value: { ...from.value }, velocity: { ...from.velocity } }];
  const count = Math.ceil(duration / 8), dt = duration / count / 1000;
  for (let i = 0; i < count; i++) {
    const previous = frames.at(-1)!, value = { ...previous.value }, velocity = { ...previous.velocity };
    for (const key of channels) {
      velocity[key] += ((target[key] - value[key]) * 360 - velocity[key] * 30) * dt;
      value[key] += velocity[key] * dt;
    }
    frames.push({ value, velocity });
  }
  frames.push({ value: target, velocity: still });
  return frames;
}

/** One interruptible motion owner; editor contents never unmount to animate. */
export function useNotebookPaperMotion(): PlayPaperMotion {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const tracks = useRef(new Map<HTMLElement, { frames: readonly PaperFrame[]; duration: number }>());
  useEffect(() => {
    return () => {
      for (const animation of animations.current.values()) animation.cancel();
      animations.current.clear();
      tracks.current.clear();
    };
  }, []);
  useLayoutEffect(() => {
    if (mode !== "off" && !reduced) return;
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
    tracks.current.clear();
  }, [mode, reduced]);

  return useCallback((element, kind, closing = false) => {
    if (!element) return null;
    const previous = animations.current.get(element);
    const current = getComputedStyle(element);
    const track = tracks.current.get(element);
    const interrupted = previous && track ? sample(track.frames, Number(previous.currentTime ?? 0) / track.duration) : null;
    previous?.cancel();
    animations.current.delete(element);
    tracks.current.delete(element);
    if (mode === "off" || reduced || typeof element.animate !== "function") return null;
    const easing = current.getPropertyValue("--hud-ease-out").trim() || "ease-out";
    const displaced: PaperState = { ...rest, opacity: 0, ...(kind === "fold" ? { y: -12, scale: .98 }
      : kind === "stamp" ? { scale: 1.08, rotate: -4 } : { x: kind === "index" ? -26 : kind === "side" ? 34 : 18 }) };
    const from = interrupted ?? { value: closing ? rest : displaced, velocity: still };
    const to = closing ? displaced : rest;
    const duration = mode === "lite" ? 120 : closing ? 280 : 480;
    const path = trajectory(from, to, duration);
    const frames = mode === "lite" ? [{ opacity: from.value.opacity }, { opacity: to.opacity }]
      : path.map(({ value }) => ({ opacity: Math.max(0, Math.min(1, value.opacity)), transform: `translate(${value.x}px, ${value.y}px) scale(${value.scale}) rotate(${value.rotate}deg)` }));
    const animation = element.animate(frames, {
      duration,
      easing: mode === "lite" ? easing : "linear",
    });
    animations.current.set(element, animation);
    tracks.current.set(element, { frames: path, duration });
    void animation.finished.catch(() => undefined).then(() => {
      if (animations.current.get(element) === animation) { animations.current.delete(element); tracks.current.delete(element); }
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
    if (open && !present) { setPresent(true); return; }
    if (!present) return;
    if (open) {
      setPresent(true);
      play(ref.current, kind);
      return;
    }
    const animation = play(ref.current, kind, true);
    if (!animation) { setPresent(false); return; }
    void animation.finished.then(() => { if (latest.current === null) setPresent(false); }).catch(() => undefined);
  }, [open, present, identity, kind, play]);
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
