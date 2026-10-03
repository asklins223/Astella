import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";

type Mode = "full" | "lite" | "off";
type Spring = { position: number; velocity: number };
type Track = { kind: "press" | "cushion" | "paper"; values: Spring[]; targets: number[] };
const still = (position: number): Spring => ({ position, velocity: 0 });

/** Substeps keep the light bounce stable after a slow frame. Retargets keep velocity. */
export function searchSpring(state: Spring, target: number, seconds: number, mode: Mode): Spring {
  if (mode === "off") return still(target);
  let { position, velocity } = state;
  const steps = Math.max(1, Math.ceil(seconds / .006)), dt = seconds / steps;
  for (let i = 0; i < steps; i++) {
    velocity += ((target - position) * 430 - velocity * (mode === "lite" ? 46 : 29)) * dt;
    position += velocity * dt;
  }
  return { position, velocity };
}

/** Only visual values are delayed. Selection, inputs, focus and actions stay immediate. */
export function useSearchMotion(root: RefObject<HTMLElement | null>, filter: string, paperIdentity: string) {
  const preference = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode: Mode = reduced ? "off" : preference;
  const tracks = useRef(new Map<HTMLElement, Track>());
  const frame = useRef<number | null>(null);
  const previousTime = useRef<number | null>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  const previousPaper = useRef(paperIdentity);

  const paint = (element: HTMLElement, track: Track) => {
    const values = track.values.map(value => value.position);
    if (track.kind === "press") element.style.setProperty("--search-press", String(values[0]));
    if (track.kind === "paper") element.style.setProperty("--search-reveal", String(values[0]));
    if (track.kind === "cushion") {
      element.style.width = `${Math.max(0, values[1])}px`;
      element.style.transform = `translate3d(${values[0]}px, 0, 0)`;
    }
  };
  const clear = (element: HTMLElement, track: Track) => {
    element.style.removeProperty("--search-press"); element.style.removeProperty("--search-reveal");
    if (track.kind === "cushion") paint(element, { ...track, values: track.targets.map(still) });
  };
  const tick = (now: number) => {
    const dt = Math.min(.04, Math.max(.001, (now - (previousTime.current ?? now - 16)) / 1000));
    previousTime.current = now;
    let running = false;
    for (const [element, track] of tracks.current) {
      if (!element.isConnected) { tracks.current.delete(element); continue; }
      track.values = track.values.map((value, index) => searchSpring(value, track.targets[index], dt, modeRef.current));
      const resting = track.values.every((value, index) => Math.abs(value.position - track.targets[index]) < .001 && Math.abs(value.velocity) < .004);
      if (resting) track.values = track.targets.map(still); else running = true;
      paint(element, track);
      if (resting && track.kind !== "cushion" && (track.kind !== "press" || track.targets[0] === 1)) { clear(element, track); tracks.current.delete(element); }
    }
    frame.current = running ? requestAnimationFrame(tick) : null;
    if (!running) previousTime.current = null;
  };
  const move = (element: HTMLElement, kind: Track["kind"], targets: number[], initial: number[], kick = false) => {
    if (modeRef.current === "off" || kind === "press" && modeRef.current === "lite") {
      clear(element, { kind, values: targets.map(still), targets }); tracks.current.delete(element); return;
    }
    const track = tracks.current.get(element) ?? { kind, values: initial.map(still), targets };
    track.targets = targets;
    if (kick && modeRef.current === "full") track.values[0].velocity = Math.min(track.values[0].velocity, -2.5);
    tracks.current.set(element, track); paint(element, track);
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    let pressed: HTMLElement | null = null;
    const release = () => { if (pressed) move(pressed, "press", [1], [1]); pressed = null; };
    const press = (target: EventTarget | null) => {
      const element = target instanceof Element ? target.closest<HTMLElement>('button, [role="option"]') : null;
      if (!element || !node.contains(element) || element.matches(':disabled, [aria-disabled="true"]') || element.closest("[inert], [hidden]")) return;
      if (pressed !== element) release();
      pressed = element; move(element, "press", [.954], [1]);
    };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const out = (event: PointerEvent) => { if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release(); };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === "Enter" || event.key === " ")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") release(); };
    node.addEventListener("pointerdown", down); node.addEventListener("pointerout", out); node.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("keyup", keyUp); window.addEventListener("blur", release);
    return () => {
      node.removeEventListener("pointerdown", down); node.removeEventListener("pointerout", out); node.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; previousTime.current = null;
      for (const [element, track] of tracks.current) clear(element, track);
      tracks.current.clear();
    };
  }, [root]);

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    node.dataset.searchMotion = mode;
    const fit = () => {
      const button = node.querySelector<HTMLElement>('.search-types [aria-pressed="true"]');
      const cushion = node.querySelector<HTMLElement>(".search-types__cushion");
      if (button && cushion) move(cushion, "cushion", [button.offsetLeft, button.offsetWidth], [button.offsetLeft, button.offsetWidth]);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    const types = node.querySelector(".search-types"); if (types) observer?.observe(types);
    if (previousPaper.current !== paperIdentity) {
      const paper = node.querySelector<HTMLElement>(".search-preview__paper");
      if (paper) move(paper, "paper", [1], [mode === "lite" ? .7 : .94], true);
      previousPaper.current = paperIdentity;
    }
    if (mode === "off") {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; previousTime.current = null;
      for (const [element, track] of tracks.current) clear(element, track);
      tracks.current.clear();
    }
    return () => observer?.disconnect();
  }, [root, filter, paperIdentity, mode]);
}
