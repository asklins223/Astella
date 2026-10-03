import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";
import { cardSpringAtRest, stepCardSpring, type CardSpring } from "./card-spring";

type Pose = { x: number; y: number; rotate: number; scale: number; open: number };
type Mode = "full" | "lite" | "off";
type ObjectOptions = { readonly layoutPosition?: boolean };
const resting: Pose = { x: 0, y: 0, rotate: 0, scale: 1, open: 1 };
const units: Record<keyof Pose, string> = { x: "px", y: "px", rotate: "deg", scale: "", open: "" };
const keys = Object.keys(resting) as (keyof Pose)[];

/** One physical object, one pose owner. Retargeting retains both position and speed. */
export function createCardObjectSpring(host: HTMLElement, initial: Partial<Pose> = {}, options: ObjectOptions = {}) {
  let mode: Mode = "full", frame = 0, lastTime = 0, destroyed = false, modeSet = false;
  let settled: (() => void) | null = null;
  const targets = { ...resting, ...initial };
  const tracks = Object.fromEntries(keys.map(key => [key, { position: targets[key], velocity: 0 }])) as Record<keyof Pose, CardSpring>;
  const isLayoutPosition = (key: keyof Pose) => options.layoutPosition && (key === "x" || key === "y");
  const paint = () => {
    for (const key of keys) {
      const value = mode === "lite" && key !== "open" ? isLayoutPosition(key) ? targets[key] : resting[key] : tracks[key].position;
      host.style.setProperty(`--card-object-${key}`, `${value}${units[key]}`);
    }
    host.dataset.objectMotion = mode;
  };
  const tick = (now: number) => {
    frame = 0;
    if (destroyed) return;
    const dt = Math.min(.04, Math.max(.001, (now - lastTime) / 1000)); lastTime = now;
    for (const key of keys) {
      tracks[key] = mode === "lite" && isLayoutPosition(key)
        ? { position: targets[key], velocity: 0 }
        : stepCardSpring(tracks[key], targets[key], dt, key === "open" ? 420 : 380, key === "open" ? 27 : 23);
      if (cardSpringAtRest(tracks[key], targets[key])) tracks[key] = { position: targets[key], velocity: 0 };
    }
    paint();
    if (keys.some(key => !cardSpringAtRest(tracks[key], targets[key]))) draw();
    else { const callback = settled; settled = null; callback?.(); }
  };
  function draw() {
    if (destroyed) return;
    if (mode === "off") {
      cancelAnimationFrame(frame); frame = 0;
      for (const key of keys) tracks[key] = { position: targets[key], velocity: 0 };
      paint(); const callback = settled; settled = null; callback?.(); return;
    }
    if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(tick); }
  }
  paint();
  return {
    target(patch: Partial<Pose>) { Object.assign(targets, patch); if (mode === "lite") paint(); draw(); },
    kick(patch: Partial<Pose>) { if (mode === "full") for (const key of keys) tracks[key].velocity += patch[key] ?? 0; draw(); },
    grab(patch: Partial<Pose>) {
      if (mode !== "full") return;
      for (const key of keys) if (patch[key] !== undefined) { tracks[key].position = patch[key]!; tracks[key].velocity = 0; targets[key] = patch[key]!; }
      paint();
    },
    mode(next: Mode) {
      if (modeSet && mode === next) return;
      modeSet = true;
      mode = next;
      if (next !== "full") for (const key of keys) if (key !== "open") {
        if (!isLayoutPosition(key)) targets[key] = resting[key];
        tracks[key] = { position: targets[key], velocity: 0 };
      }
      paint();
      draw();
    },
    pose() { return Object.fromEntries(keys.map(key => [key, tracks[key].position])) as Pose; },
    settled(callback: () => void) { if (!frame) callback(); else settled = callback; },
    destroy() { destroyed = true; cancelAnimationFrame(frame); for (const key of keys) host.style.removeProperty(`--card-object-${key}`); delete host.dataset.objectMotion; },
  };
}

export function useCardObjectSpring(ref: RefObject<HTMLElement | null>, initial: Partial<Pose> = {}, options: ObjectOptions = {}) {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const controller = useRef<ReturnType<typeof createCardObjectSpring> | null>(null);
  const host = useRef<HTMLElement | null>(null);
  const initialRef = useRef(initial);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    if (host.current !== ref.current) {
      controller.current?.destroy();
      host.current = ref.current;
      controller.current = ref.current ? createCardObjectSpring(ref.current, initialRef.current, optionsRef.current) : null;
    }
    controller.current?.mode(reduced ? "off" : mode);
  });
  useLayoutEffect(() => () => { controller.current?.destroy(); controller.current = null; host.current = null; }, [ref]);
  return controller;
}

export function useCardPaperArrival(ref: RefObject<HTMLElement | null>, pageKey: string | null) {
  const object = useCardObjectSpring(ref, { y: 34, rotate: -2.5, open: 0 });
  const lastKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!pageKey || !object.current || lastKey.current === pageKey) return;
    object.current.target(resting);
    if (lastKey.current) object.current.kick({ y: 420, rotate: -38 });
    lastKey.current = pageKey;
  });
  return object;
}
