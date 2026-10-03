import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";
import { directorySpring } from "../../directory-rail-motion";

type Spring = { position: number; velocity: number; target: number };
const resting = (value: Spring) => Math.abs(value.position - value.target) < .0002 && Math.abs(value.velocity) < .002;

/** Press and release share a spring, including when a second press interrupts it. */
export function useSourceMotion(rootRef: RefObject<HTMLElement | null>, identity: string) {
  const preference = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : preference;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tracks = useRef(new Map<HTMLElement, Spring>());
  const frame = useRef<number | null>(null);
  const time = useRef(0);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let pressed: HTMLElement | null = null;
    const tick = (now: number) => {
      const seconds = Math.min(.032, Math.max(.001, (now - time.current) / 1000));
      time.current = now;
      for (const [element, spring] of tracks.current) {
        if (!element.isConnected || modeRef.current !== "full") {
          element.style.removeProperty("--source-press");
          tracks.current.delete(element);
          continue;
        }
        Object.assign(spring, directorySpring(spring, spring.target, seconds, "full"));
        element.style.setProperty("--source-press", String(spring.position));
        if (resting(spring)) {
          if (spring.target === 1) element.style.removeProperty("--source-press");
          else element.style.setProperty("--source-press", String(spring.target));
          tracks.current.delete(element);
        }
      }
      frame.current = tracks.current.size ? requestAnimationFrame(tick) : null;
    };
    const move = (element: HTMLElement, target: number) => {
      if (modeRef.current !== "full") return;
      const spring = tracks.current.get(element) ?? { position: Number(element.style.getPropertyValue("--source-press")) || 1, velocity: 0, target };
      spring.target = target;
      tracks.current.set(element, spring);
      if (frame.current === null) { time.current = performance.now(); frame.current = requestAnimationFrame(tick); }
    };
    const release = () => { if (pressed) move(pressed, 1); pressed = null; };
    const press = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest<HTMLElement>("button, summary, [role='button']") : null;
      if (!button || !root.contains(button) || button.matches(":disabled, [aria-disabled='true']") || button.closest("[inert], [hidden]")) return;
      release(); pressed = button; move(button, button.classList.contains("source-sheet") ? .982 : .94);
    };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const out = (event: PointerEvent) => { if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release(); };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === "Enter" || event.key === " ")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") release(); };
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointerout", out);
    root.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    return () => {
      root.removeEventListener("pointerdown", down); root.removeEventListener("pointerout", out); root.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      for (const element of tracks.current.keys()) element.style.removeProperty("--source-press");
      tracks.current.clear();
    };
  }, [rootRef, identity]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.dataset.sourceMotion = mode;
    if (mode !== "full") {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      for (const element of tracks.current.keys()) element.style.removeProperty("--source-press");
      tracks.current.clear();
    }
  }, [rootRef, identity, mode]);
}

/** The mounted sheet can reverse mid-flight; its controls follow intent immediately. */
export function useSourceSheetMotion(ref: RefObject<HTMLElement | null>, open: boolean) {
  const preference = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : preference;
  const spring = useRef<Spring>({ position: 0, velocity: 0, target: 0 });
  useLayoutEffect(() => {
    const sheet = ref.current;
    if (!sheet) return;
    spring.current.target = open ? 1 : 0;
    sheet.hidden = false;
    let frame = 0;
    let previous = performance.now();
    const paint = () => {
      const value = spring.current.position;
      sheet.style.opacity = String(Math.max(0, Math.min(1, value)));
      sheet.style.transform = mode === "full" ? `translate3d(${(1 - value) * 38}px,0,0) scale(${.975 + value * .025})` : "none";
    };
    const tick = (now: number) => {
      Object.assign(spring.current, directorySpring(spring.current, spring.current.target, Math.min(.032, (now - previous) / 1000), mode));
      previous = now; paint();
      if (resting(spring.current)) {
        spring.current.position = spring.current.target; spring.current.velocity = 0; paint();
        sheet.hidden = !open;
      } else frame = requestAnimationFrame(tick);
    };
    if (mode === "off") {
      spring.current.position = spring.current.target; spring.current.velocity = 0; paint(); sheet.hidden = !open;
    } else { paint(); frame = requestAnimationFrame(tick); }
    return () => cancelAnimationFrame(frame);
  }, [ref, open, mode]);
}
