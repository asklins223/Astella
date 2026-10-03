import { useLayoutEffect,useRef,type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";

import { stepUiSpring as companionSpring, type UiSpring as Spring, type UiMotionMode as Mode } from "../../hud/ui-spring";
export { companionSpring };

type Track = { kind: "press" | "page" | "cushion"; values: Spring[]; target: number[] };
const atRest = (track: Track) => track.values.every((value, i) => Math.abs(value.position - track.target[i]) < .001 && Math.abs(value.velocity) < .01);
const still = (position: number): Spring => ({ position, velocity: 0 });

/** One motion owner for the house. Navigation and focus take effect before any motion. */
export function useCompanionTactile(rootRef: RefObject<HTMLElement | null>, identity: string) {
  const motion = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode: Mode = reduced ? "off" : motion;
  const modeRef = useRef(mode); modeRef.current = mode;
  const tracks = useRef(new Map<HTMLElement, Track>());
  const frame = useRef<number | null>(null);
  const lastFrame = useRef<number | null>(null);
  const previous = useRef(identity);
  const paint = (element: HTMLElement, track: Track) => {
    const [a, b, width, height] = track.values.map(value => value.position);
    if (track.kind === "cushion") {
      element.style.width = `${Math.max(0, width)}px`; element.style.height = `${Math.max(0, height)}px`;
      element.style.transform = `translate3d(${a}px, ${b}px, 0)`;
    }
    else if (track.kind === "press") element.style.transform = `translate3d(0, ${b}px, 0) scale(${a})`;
    else { element.style.transform = `translate3d(0, ${(1 - a) * 12}px, 0) scale(${.986 + a * .014})`; element.style.opacity = `${Math.max(0, Math.min(1, a))}`; }
  };
  const tick = (time: number) => {
    const dt = Math.min(.032, Math.max(0, (time - (lastFrame.current ?? time)) / 1000));
    lastFrame.current = time;
    let running = false;
    for (const [element, track] of tracks.current) {
      track.values = track.values.map((value, i) => companionSpring(value, track.target[i], dt, modeRef.current));
      if (atRest(track)) track.values = track.target.map(still); else running = true;
      paint(element, track);
      if (atRest(track) && track.kind !== "cushion" && (track.kind !== "press" || track.target[0] === 1)) {
        element.style.removeProperty("transform"); element.style.removeProperty("opacity"); tracks.current.delete(element);
      }
    }
    frame.current = running ? requestAnimationFrame(tick) : null;
    if (!running) lastFrame.current = null;
  };
  const move = (element: HTMLElement, kind: Track["kind"], target: number[], initial: number[]) => {
    if (modeRef.current === "off" && kind !== "cushion") {
      element.style.removeProperty("transform"); element.style.removeProperty("opacity"); tracks.current.delete(element); return;
    }
    const track = tracks.current.get(element) ?? { kind, values: initial.map(still), target };
    track.target = target;
    if (modeRef.current === "off") track.values = target.map(still);
    tracks.current.set(element, track); paint(element, track);
    if (frame.current === null && modeRef.current !== "off") frame.current = requestAnimationFrame(tick);
  };
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const pressed = new Set<HTMLElement>();
    const buttonFrom = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
    const press = (target: EventTarget | null) => {
      const button = buttonFrom(target);
      if (!button || !root.contains(button) || button.disabled) return;
      pressed.add(button); move(button, "press", [.967, 1.4], [1, 0]);
    };
    const release = () => { for (const button of pressed) move(button, "press", [1, 0], [.967, 1.4]); pressed.clear(); };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === " " || event.key === "Enter")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === " " || event.key === "Enter") release(); };
    root.addEventListener("pointerdown", down); root.addEventListener("keydown", keyDown);
    window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); window.addEventListener("blur", release); window.addEventListener("keyup", keyUp);
    return () => {
      root.removeEventListener("pointerdown", down); root.removeEventListener("keydown", keyDown);
      window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("blur", release); window.removeEventListener("keyup", keyUp);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; lastFrame.current = null;
      for (const [element, track] of tracks.current) {
        element.style.removeProperty("transform"); element.style.removeProperty("opacity");
        if (track.kind === "cushion") { element.style.removeProperty("width"); element.style.removeProperty("height"); }
      }
      tracks.current.clear();
    };
  }, [rootRef]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      const active = root.querySelector<HTMLElement>('.cc-room-tabs [aria-selected="true"]');
      const cushion = root.querySelector<HTMLElement>(".cc-room-tabs__cushion");
      if (active && cushion) {
        const bounds = [active.offsetLeft, active.offsetTop, active.offsetWidth, active.offsetHeight];
        move(cushion, "cushion", bounds, bounds);
        active.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(root);
    const navigation = root.querySelector<HTMLElement>(".cc-room-tabs");
    const activeTab = navigation?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (navigation) observer?.observe(navigation);
    if (activeTab) observer?.observe(activeTab);
    if (previous.current !== identity) {
      for (const [element, track] of tracks.current) if (track.kind === "page" && element.id !== `companion-panel-${identity}` && element.id !== `companion-settings-panel-${identity}`) {
        element.style.removeProperty("transform"); element.style.removeProperty("opacity"); tracks.current.delete(element);
      }
      const page = root.querySelector<HTMLElement>(`#companion-panel-${identity}, #companion-settings-panel-${identity}`);
      if (page) move(page, "page", [1], [mode === "lite" ? .8 : 0]);
      previous.current = identity;
    }
    if (mode === "off") for (const [element, track] of tracks.current) {
      if (track.kind === "cushion") { track.values = track.target.map(still); paint(element, track); }
      else { element.style.removeProperty("transform"); element.style.removeProperty("opacity"); tracks.current.delete(element); }
    }
    return () => observer?.disconnect();
  }, [rootRef, identity, mode]);
}
