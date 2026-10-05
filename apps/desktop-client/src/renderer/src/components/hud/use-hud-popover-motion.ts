import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";
import { paperSpringAtRest, stepPaperSpring, type PaperSpring } from "../motion/paper-spring";

export type HudMenuKind = "space" | "account" | "guide";

/** Keep one presentation object through close/reopen. Logical input changes immediately. */
export function useHudPopoverMotion(kind: HudMenuKind | null, rootRef: RefObject<HTMLDivElement | null>,
  anchorRef: RefObject<HTMLButtonElement | null>) {
  const preference = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : preference;
  const [retained, setRetained] = useState<HudMenuKind | null>(kind);
  const shown = kind ?? retained;
  const runtime = useRef({ value: { value: 0, velocity: 0 } as PaperSpring, target: 0, frame: 0, time: 0,
    left: null as PaperSpring | null, targetLeft: 0, minLeft: 0, maxLeft: 0, wake: () => {} });

  useLayoutEffect(() => {
    if (kind) setRetained(kind);
    const state = runtime.current;
    state.target = kind ? 1 : 0;
    const root = rootRef.current;
    if (!root) return;
    const paint = () => {
      root.style.setProperty("--hud-bubble-presence", String(state.value.value));
      if (state.left) root.style.left = `${Math.max(state.minLeft, Math.min(state.maxLeft, state.left.value))}px`;
    };
    const finish = () => {
      state.value = { value: state.target, velocity: 0 }; paint();
      state.frame = 0; state.time = 0;
      if (!state.target) { state.left = null; setRetained(null); }
    };
    const tick = (time: number) => {
      const dt = Math.min(.04, Math.max(0, (time - state.time) / 1000));
      state.time = time;
      state.value = mode === "lite"
        ? { value: state.target + (state.value.value - state.target) * Math.exp(-30 * dt), velocity: 0 }
        : stepPaperSpring(state.value, state.target, dt, 480, 28);
      if (state.left) state.left = mode === "lite"
        ? { value: state.targetLeft, velocity: 0 }
        : stepPaperSpring(state.left, state.targetLeft, dt, 500, 38);
      paint();
      if (paperSpringAtRest(state.value, state.target) && (!state.left || paperSpringAtRest(state.left, state.targetLeft, .1))) finish();
      else state.frame = requestAnimationFrame(tick);
    };
    state.wake = () => {
      if (mode === "off") {
        cancelAnimationFrame(state.frame);
        if (state.left) state.left = { value: state.targetLeft, velocity: 0 };
        finish(); return;
      }
      paint();
      if (!state.frame) { state.time = performance.now(); state.frame = requestAnimationFrame(tick); }
    };
    state.wake();
    return () => { cancelAnimationFrame(state.frame); state.frame = 0; state.wake = () => {}; };
  }, [kind, mode, rootRef, shown]);

  // Fit to the actual trigger and viewport, including island travel, text zoom and resize.
  useLayoutEffect(() => {
    const root = rootRef.current, anchor = anchorRef.current;
    if (!root || !anchor || !shown) return;
    const fit = () => {
      const box = anchor.getBoundingClientRect();
      const host = root.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const gap = 12, margin = 14;
      const width = root.offsetWidth;
      const center = box.left + box.width / 2;
      const left = Math.max(margin, Math.min(center - width / 2, window.innerWidth - width - margin));
      const top = Math.min(box.bottom + gap, window.innerHeight - 96);
      const state = runtime.current;
      state.targetLeft = left - host.left;
      state.minLeft = margin - host.left;
      state.maxLeft = window.innerWidth - width - margin - host.left;
      if (!state.left) state.left = { value: state.targetLeft, velocity: 0 };
      root.style.top = `${top - host.top}px`;
      root.style.setProperty("--hud-bubble-anchor", `${Math.max(26, Math.min(width - 26, center - left))}px`);
      const availableHeight = Math.max(80, window.innerHeight - top - margin);
      root.style.setProperty("--hud-bubble-max-height", `${availableHeight}px`);
      root.dataset.scrollWhole = String(availableHeight < 420);
      state.wake();
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(root);
    const island = anchor.parentElement;
    if (island) observer?.observe(island);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [anchorRef, rootRef, shown]);

  useLayoutEffect(() => () => {
    const state = runtime.current;
    cancelAnimationFrame(state.frame); state.frame = 0; state.time = 0;
  }, []);

  return { shown, mode };
}
