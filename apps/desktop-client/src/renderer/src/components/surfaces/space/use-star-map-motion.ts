import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";
import { stepStarSpring, type StarSpring } from "./star-map-motion";

type Track = { kind: "press" | "panel" | "page" | "cushion"; values: StarSpring[]; target: number[] };
const still = (position: number): StarSpring => ({ position, velocity: 0 });
const resting = (track: Track) => track.values.every((value, i) => Math.abs(value.position - track.target[i]) < .001 && Math.abs(value.velocity) < .01);

/** Owns panel travel, tab cushions and press scale. CSS owns static geometry. */
export function useStarMapMotion(rootRef: RefObject<HTMLElement | null>, detailOpen: boolean, identity: string) {
  const motion = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : motion;
  const modeRef = useRef(mode); modeRef.current = mode;
  const tracks = useRef(new Map<HTMLElement, Track>());
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const previous = useRef(identity);
  const paint = (element: HTMLElement, track: Track) => {
    const [a, b] = track.values.map(value => value.position);
    if (track.kind === "press") element.style.setProperty("--star-press", String(a));
    if (track.kind === "panel") {
      element.style.setProperty("--star-panel", String(a));
      element.dataset.visible = a > .001 || track.target[0] === 1 ? "true" : "false";
    }
    if (track.kind === "page") element.style.setProperty("--star-page", String(a));
    if (track.kind === "cushion") {
      element.style.width = `${Math.max(0, b)}px`;
      element.style.transform = `translate3d(${a}px, 0, 0)`;
    }
  };
  const tick = (time: number) => {
    const dt = Math.min(.04, Math.max(0, (time - (lastTime.current ?? time)) / 1000));
    lastTime.current = time;
    let running = false;
    for (const [element, track] of tracks.current) {
      if (!element.isConnected) { tracks.current.delete(element); continue; }
      track.values = track.values.map((value, i) => stepStarSpring(value, track.target[i], dt, modeRef.current));
      if (resting(track)) track.values = track.target.map(still); else running = true;
      paint(element, track);
      if (resting(track) && (track.kind === "page" || (track.kind === "press" && track.target[0] === 1))) {
        element.style.removeProperty(track.kind === "page" ? "--star-page" : "--star-press");
        tracks.current.delete(element);
      }
    }
    frame.current = running ? requestAnimationFrame(tick) : null;
    if (!running) lastTime.current = null;
  };
  const move = (element: HTMLElement, kind: Track["kind"], target: number[], initial: number[]) => {
    const track = tracks.current.get(element) ?? { kind, values: initial.map(still), target };
    track.target = target;
    if (modeRef.current === "off" || (kind === "press" && modeRef.current !== "full")) track.values = target.map(still);
    tracks.current.set(element, track); paint(element, track);
    if (modeRef.current !== "off" && !resting(track) && frame.current === null) frame.current = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let pressed: HTMLElement | null = null;
    const release = () => { if (pressed) move(pressed, "press", [1], [.952]); pressed = null; };
    const press = (target: EventTarget | null) => {
      if (modeRef.current !== "full") return;
      const button = target instanceof Element ? target.closest<HTMLElement>("button, summary, .universe-layer-toggle") : null;
      if (!button || !root.contains(button) || button.matches(":disabled, .universe-detail-scrim") || button.closest("[inert], [hidden]")) return;
      if (pressed !== button) release();
      pressed = button; move(button, "press", [.952], [1]);
    };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const out = (event: PointerEvent) => { if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release(); };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === " " || event.key === "Enter")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === " " || event.key === "Enter") release(); };
    root.addEventListener("pointerdown", down); root.addEventListener("pointerout", out); root.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("keyup", keyUp); window.addEventListener("blur", release);
    return () => {
      root.removeEventListener("pointerdown", down); root.removeEventListener("pointerout", out); root.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; lastTime.current = null;
      for (const [element, track] of tracks.current) {
        if (track.kind === "press") element.style.removeProperty("--star-press");
        if (track.kind === "page") element.style.removeProperty("--star-page");
      }
      tracks.current.clear();
    };
  }, [rootRef]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (mode === "off") {
      for (const [element, track] of tracks.current) { track.values = track.target.map(still); paint(element, track); }
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; lastTime.current = null;
      for (const [element, track] of tracks.current) {
        if (track.kind === "press" || track.kind === "page") {
          element.style.removeProperty(track.kind === "page" ? "--star-page" : "--star-press");
          tracks.current.delete(element);
        }
      }
    }
    const panel = root.querySelector<HTMLElement>(".universe-detail-panel");
    if (panel) move(panel, "panel", [detailOpen ? 1 : 0], [0]);
    const fit = () => {
      root.querySelectorAll<HTMLElement>("[data-star-tabs]").forEach(tabs => {
        const active = tabs.querySelector<HTMLElement>('[aria-pressed="true"], [aria-current="true"]');
        const cushion = tabs.querySelector<HTMLElement>(".universe-tab-cushion");
        if (active && cushion) move(cushion, "cushion", [active.offsetLeft, active.offsetWidth], [active.offsetLeft, active.offsetWidth]);
      });
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(root);
    if (previous.current !== identity) {
      const page = root.querySelector<HTMLElement>(".universe-detail-body");
      if (page && detailOpen) {
        page.scrollTop = 0;
        move(page, "page", [1], [mode === "full" ? .1 : .8]);
      }
      previous.current = identity;
    }
    return () => observer?.disconnect();
  }, [detailOpen, identity, mode, rootRef]);
}
