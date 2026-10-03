import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";

type Spring = { position: number; velocity: number };
type Track = { kind: "press" | "page" | "tab"; values: Spring[]; target: number[] };
type MotionMode = "full" | "lite" | "off";
const still = (position: number): Spring => ({ position, velocity: 0 });

/** Exact spring integration; a new destination preserves presentation and velocity. */
export function tactileSpring(state: Spring, target: number, seconds: number): Spring {
  const damping = 15;
  const frequency = Math.sqrt(460 - damping * damping);
  const displacement = state.position - target;
  const b = (state.velocity + damping * displacement) / frequency;
  const sin = Math.sin(frequency * seconds), cos = Math.cos(frequency * seconds);
  const decay = Math.exp(-damping * seconds);
  const value = displacement * cos + b * sin;
  return {
    position: target + decay * value,
    velocity: decay * (-damping * value - displacement * frequency * sin + b * frequency * cos),
  };
}

const settled = (track: Track) => track.values.every((value, i) =>
  Math.abs(value.position - track.target[i]) < .001 && Math.abs(value.velocity) < .01);
const clear = (element: HTMLElement, kind: Track["kind"]) => {
  for (const name of kind === "press" ? ["--tactile-press", "--tactile-drop"]
    : kind === "page" ? ["--tactile-page"] : ["--tactile-tab-x", "--tactile-tab-width"])
    element.style.removeProperty(name);
};

/** Delegated touch, a sliding tab cushion and page arrival share one motion owner.
 * Functionality and focus never wait for this hook. CSS owns static geometry.
 */
export function useTactileSurface(rootRef: RefObject<HTMLElement | null>, identity: string) {
  const preference = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode: MotionMode = reduced ? "off" : preference;
  const runtime = useRef({
    mode, tracks: new Map<HTMLElement, Track>(), frame: 0, time: 0,
    root: null as HTMLElement | null, dispose: null as (() => void) | null,
    identity: "", page: null as HTMLElement | null,
  });
  runtime.current.mode = mode;
  const paint = (element: HTMLElement, track: Track) => {
    const [a, b] = track.values.map(value => value.position);
    if (track.kind === "press") {
      element.style.setProperty("--tactile-press", String(a));
      element.style.setProperty("--tactile-drop", `${b}px`);
    } else if (track.kind === "page") {
      element.style.setProperty("--tactile-page", String(a));
    } else {
      element.style.setProperty("--tactile-tab-x", `${a}px`);
      element.style.setProperty("--tactile-tab-width", `${Math.max(0, b)}px`);
    }
  };
  const tick = (time: number) => {
    const state = runtime.current;
    const dt = Math.min(.04, Math.max(0, (time - state.time) / 1000));
    state.time = time;
    let running = false;
    for (const [element, track] of state.tracks) {
      if (!element.isConnected) { clear(element, track.kind); state.tracks.delete(element); continue; }
      track.values = track.values.map((value, index) => state.mode === "lite"
        ? { position: track.target[index] + (value.position - track.target[index]) * Math.exp(-25 * dt), velocity: 0 }
        : tactileSpring(value, track.target[index], dt));
      if (settled(track)) track.values = track.target.map(still); else running = true;
      paint(element, track);
      if (settled(track) && track.kind !== "tab" && (track.kind !== "press" || track.target[0] === 1)) {
        clear(element, track.kind); state.tracks.delete(element);
      }
    }
    state.frame = running ? requestAnimationFrame(tick) : 0;
    if (!running) state.time = 0;
  };
  const move = (element: HTMLElement, kind: Track["kind"], target: number[], initial: number[]) => {
    const state = runtime.current;
    if (state.mode === "off" || (state.mode === "lite" && kind === "press")) {
      clear(element, kind); state.tracks.delete(element);
      if (kind === "tab") paint(element, { kind, target, values: target.map(still) });
      return;
    }
    const track = state.tracks.get(element) ?? { kind, values: initial.map(still), target };
    track.target = target;
    state.tracks.set(element, track); paint(element, track);
    if (!state.frame) { state.time = performance.now(); state.frame = requestAnimationFrame(tick); }
  };

  // Runs after every commit so a root first appearing after an async read gets bound.
  // Re-renders do not tear down springs or restart a held button.
  useLayoutEffect(() => {
    const state = runtime.current, root = rootRef.current;
    if (state.root !== root) {
      state.dispose?.(); state.root = root;
      if (root) {
        let pressed: HTMLElement | null = null;
        const find = (target: EventTarget | null) => {
          const control = target instanceof Element ? target.closest<HTMLElement>("button, summary") : null;
          return control && root.contains(control) && !control.matches(":disabled, [aria-disabled='true']")
            && !control.closest("[inert], [hidden]") ? control : null;
        };
        const release = () => { if (pressed) move(pressed, "press", [1, 0], [1, 0]); pressed = null; };
        const press = (target: EventTarget | null) => {
          const control = find(target); if (!control) return;
          if (pressed !== control) release();
          pressed = control; move(control, "press", [.95, 1.5], [1, 0]);
        };
        const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
        const out = (event: PointerEvent) => {
          if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release();
        };
        const keyDown = (event: KeyboardEvent) => {
          if (!event.repeat && (event.key === " " || event.key === "Enter")) press(event.target);
        };
        const keyUp = (event: KeyboardEvent) => { if (event.key === " " || event.key === "Enter") release(); };
        const doc = root.ownerDocument;
        root.addEventListener("pointerdown", down); root.addEventListener("pointerout", out);
        root.addEventListener("keydown", keyDown);
        doc.addEventListener("pointerup", release); doc.addEventListener("pointercancel", release);
        doc.addEventListener("keyup", keyUp); window.addEventListener("blur", release);
        state.dispose = () => {
          root.removeEventListener("pointerdown", down); root.removeEventListener("pointerout", out);
          root.removeEventListener("keydown", keyDown);
          doc.removeEventListener("pointerup", release); doc.removeEventListener("pointercancel", release);
          doc.removeEventListener("keyup", keyUp); window.removeEventListener("blur", release);
        };
      }
    }
    if (!root) return;
    if (mode === "off") {
      cancelAnimationFrame(state.frame); state.frame = 0; state.time = 0;
      for (const [element, track] of state.tracks) clear(element, track.kind);
      state.tracks.clear();
    } else if (mode === "lite") {
      for (const [element, track] of state.tracks) if (track.kind === "press") {
        clear(element, track.kind); state.tracks.delete(element);
      }
      if (!state.tracks.size) { cancelAnimationFrame(state.frame); state.frame = 0; state.time = 0; }
    }
    const page = root.querySelector<HTMLElement>("[data-tactile-page]:not([hidden])");
    if (page && (state.identity !== identity || state.page !== page))
      move(page, "page", [1], [mode === "lite" ? .65 : .15]);
    state.identity = identity; state.page = page;
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      const active = root.querySelector<HTMLElement>('[data-tactile-tabs] [aria-selected="true"]');
      const cushion = root.querySelector<HTMLElement>("[data-tactile-cushion]");
      if (active && cushion) move(cushion, "tab", [active.offsetLeft, active.offsetWidth], [active.offsetLeft, active.offsetWidth]);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [rootRef, identity, mode]);

  // Cancel the frame **and give the number back**. StrictMode mounts, unmounts and
  // remounts this hook while keeping the same ref, so a cancelled id left behind
  // reads as "a loop is already running": `move` would never schedule again and
  // every spring would freeze on the value it was painting before the switch.
  useLayoutEffect(() => () => {
    const state = runtime.current;
    state.dispose?.(); cancelAnimationFrame(state.frame);
    state.frame = 0; state.time = 0;
    for (const [element, track] of state.tracks) clear(element, track.kind);
    state.tracks.clear(); state.root = null;
  }, []);
}
