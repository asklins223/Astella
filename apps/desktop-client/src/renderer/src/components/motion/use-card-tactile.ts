import { useLayoutEffect, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";
import { cardSpringAtRest, stepCardSpring, type CardSpring } from "./card-spring";

type Press = CardSpring & { target: number };

/** Scale has one owner; hover translation and card movement remain independent. */
export function useCardTactile(rootRef: RefObject<HTMLElement | null>) {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || mode !== "full" || reduced) return;
    const tracks = new Map<HTMLElement, Press>();
    let frame = 0, lastTime = 0;
    let pressed: HTMLElement | null = null;
    const tick = (now: number) => {
      const dt = Math.min(.032, Math.max(.001, (now - lastTime) / 1000));
      lastTime = now;
      for (const [element, track] of tracks) {
        if (!element.isConnected) { tracks.delete(element); continue; }
        Object.assign(track, stepCardSpring(track, track.target, dt, track.target < 1 ? 900 : 460, track.target < 1 ? 42 : 25));
        element.style.setProperty("--card-touch-scale", String(track.position));
        if (cardSpringAtRest(track, track.target)) {
          track.position = track.target; track.velocity = 0;
          if (track.target === 1) { element.style.removeProperty("--card-touch-scale"); tracks.delete(element); }
        }
      }
      frame = [...tracks.values()].some(track => !cardSpringAtRest(track, track.target)) ? requestAnimationFrame(tick) : 0;
    };
    const target = (element: HTMLElement, value: number) => {
      const track = tracks.get(element) ?? { position: 1, velocity: 0, target: value };
      track.target = value; tracks.set(element, track);
      if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(tick); }
    };
    const release = () => { if (pressed) target(pressed, 1); pressed = null; };
    const press = (eventTarget: EventTarget | null) => {
      const element = eventTarget instanceof Element ? eventTarget.closest<HTMLElement>("button, summary") : null;
      if (!element || !root.contains(element) || element.matches(":disabled") || element.closest("[inert], [hidden]")) return;
      if (pressed !== element) release();
      pressed = element; target(element, .958);
    };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === "Enter" || event.key === " ")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") release(); };
    const out = (event: PointerEvent) => { if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release(); };
    root.addEventListener("pointerdown", down); root.addEventListener("pointerout", out); root.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("keyup", keyUp); window.addEventListener("blur", release);
    return () => {
      root.removeEventListener("pointerdown", down); root.removeEventListener("pointerout", out); root.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release);
      cancelAnimationFrame(frame);
      for (const element of tracks.keys()) element.style.removeProperty("--card-touch-scale");
    };
  }, [rootRef, mode, reduced]);
}
