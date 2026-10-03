import { useLayoutEffect, useRef, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";
import { stepUiSpring, type UiMotionMode, type UiSpring } from "../../hud/ui-spring";

type Track = {
  kind: "press" | "page" | "cushion" | "offset";
  values: UiSpring[];
  target: number[];
};
const still = (position: number): UiSpring => ({ position, velocity: 0 });
const settled = (track: Track) => track.values.every((value, index) =>
  Math.abs(value.position - track.target[index]) < .001 && Math.abs(value.velocity) < .01);

/** A single motion owner for the setting book, including its nested chapters and controls. */
export function useSettingsTactile(rootRef: RefObject<HTMLElement | null>) {
  const motion = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode: UiMotionMode = reduced ? "off" : motion;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const refreshRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const tracks = new Map<HTMLElement, Track>();
    const pressed = new Set<HTMLElement>();
    const pages = new WeakMap<HTMLElement, string>();
    const observed = new Set<HTMLElement>();
    let frame: number | null = null;
    let lastFrame: number | null = null;

    const clear = (element: HTMLElement) => {
      element.style.removeProperty("transform");
      element.style.removeProperty("opacity");
      tracks.delete(element);
    };
    const paint = (element: HTMLElement, track: Track) => {
      const [a, b, width, height] = track.values.map(value => value.position);
      if (track.kind === "cushion") {
        element.style.transform = `translate3d(${a}px, ${b}px, 0)`;
        element.style.width = `${Math.max(0, width)}px`;
        element.style.height = `${Math.max(0, height)}px`;
      } else if (track.kind === "offset") {
        element.style.transform = `translate3d(${a}px, 0, 0)`;
      } else if (track.kind === "press") {
        element.style.transform = `translate3d(0, ${b}px, 0) scale(${a})`;
      } else {
        element.style.transform = modeRef.current === "lite" ? "none"
          : `translate3d(0, ${(1 - a) * 10}px, 0) scale(${.991 + a * .009})`;
        // Text stays visible and interactive throughout a page change.
        element.style.opacity = `${.78 + Math.max(0, Math.min(1, a)) * .22}`;
      }
    };
    const tick = (time: number) => {
      const dt = Math.min(.032, Math.max(0, (time - (lastFrame ?? time)) / 1000));
      lastFrame = time;
      let running = false;
      for (const [element, track] of tracks) {
        if (!root.contains(element)) { clear(element); continue; }
        track.values = track.values.map((value, index) => stepUiSpring(value, track.target[index], dt, modeRef.current));
        if (settled(track)) track.values = track.target.map(still);
        else running = true;
        paint(element, track);
        if (settled(track) && (track.kind === "page" || (track.kind === "press" && track.target[0] === 1))) clear(element);
      }
      frame = running ? requestAnimationFrame(tick) : null;
      if (!running) lastFrame = null;
    };
    const move = (element: HTMLElement, kind: Track["kind"], target: number[], initial = target) => {
      if (modeRef.current === "off" && (kind === "press" || kind === "page")) { clear(element); return; }
      const track = tracks.get(element) ?? { kind, values: initial.map(still), target };
      track.target = target;
      if (modeRef.current === "off") track.values = target.map(still);
      tracks.set(element, track);
      paint(element, track);
      if (frame === null && !settled(track)) frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      for (const element of tracks.keys()) if (!root.contains(element)) clear(element);
      root.querySelectorAll<HTMLElement>(".settings-menu, .settings-companion-tabs").forEach(nav => {
        if (nav.closest('[data-settings-active="false"]')) return;
        const active = nav.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
        const cushion = nav.querySelector<HTMLElement>("[data-settings-cushion]");
        if (active && cushion) move(cushion, "cushion", [active.offsetLeft, active.offsetTop, active.offsetWidth, active.offsetHeight]);
      });
      root.querySelectorAll<HTMLElement>(".hud-segmented").forEach(control => {
        const active = control.querySelector<HTMLElement>('[aria-checked="true"]');
        const plate = control.querySelector<HTMLElement>(".hud-segmented__plate");
        if (plate && control.closest('[data-settings-active="false"]')) { clear(plate); return; }
        if (active && plate) move(plate, "offset", [active.offsetLeft - plate.offsetLeft]);
      });
      root.querySelectorAll<HTMLElement>(".switch").forEach(control => {
        const thumb = control.querySelector<HTMLElement>("i");
        if (thumb && control.closest('[data-settings-active="false"]')) { clear(thumb); return; }
        if (thumb) move(thumb, "offset", [control.getAttribute("aria-checked") === "true" ? 20 : 0]);
      });
      root.querySelectorAll<HTMLElement>("[data-settings-page]").forEach(page => {
        const identity = page.closest('[data-settings-active="false"]') ? "hidden" : page.dataset.settingsPage ?? "";
        const previous = pages.get(page);
        if (previous !== undefined && previous !== identity && identity !== "hidden") {
          const existing = tracks.get(page);
          if (existing?.kind === "page") {
            // A fast second switch gives the same paper an impulse, preserving its live position.
            existing.values[0].velocity -= 1.8;
            move(page, "page", [1]);
          } else move(page, "page", [1], [0]);
        }
        if (identity === "hidden") clear(page);
        pages.set(page, identity);
      });
      if (modeRef.current === "off") {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        lastFrame = null;
        for (const [element, track] of tracks) {
          if (track.kind === "page" || track.kind === "press") clear(element);
          else { track.values = track.target.map(still); paint(element, track); }
        }
      }
      root.querySelectorAll<HTMLElement>(".settings-menu, .settings-companion-tabs, .hud-segmented").forEach(element => {
        if (!observed.has(element)) { observer?.observe(element); observed.add(element); }
      });
      for (const element of observed) if (!root.contains(element)) { observer?.unobserve(element); observed.delete(element); }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(root);
    refreshRef.current = sync;
    sync();
    // Style writes are excluded: the spring cannot trigger its own observer.
    const mutationObserver = new MutationObserver(sync);
    mutationObserver.observe(root, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-current", "aria-selected", "aria-checked", "data-settings-page", "data-settings-active"],
    });

    const buttonFrom = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>("button, summary, label.button") : null;
    const press = (target: EventTarget | null) => {
      const button = buttonFrom(target);
      if (!button || !root.contains(button) || button.matches(":disabled, [aria-disabled=true], [data-disabled=true]")) return;
      pressed.add(button);
      move(button, "press", [.96, 1.7], [1, 0]);
    };
    const release = () => {
      for (const button of pressed) move(button, "press", [1, 0], [.96, 1.7]);
      pressed.clear();
    };
    const down = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const keyDown = (event: KeyboardEvent) => {
      // Enter in an input must submit/edit immediately without pressing its enclosing field.
      if (!event.repeat && (event.key === " " || event.key === "Enter") &&
        !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) press(event.target);
    };
    const keyUp = (event: KeyboardEvent) => { if (event.key === " " || event.key === "Enter") release(); };
    const bounce = (event: MouseEvent) => {
      const leaf = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-settings-bounce]") : null;
      if (!leaf || modeRef.current !== "full") return;
      move(leaf, "press", [1, 0], [1, 0]);
      const track = tracks.get(leaf)!;
      track.values[0].velocity += 2.8;
      track.values[1].velocity -= 38;
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    root.addEventListener("pointerdown", down);
    root.addEventListener("keydown", keyDown);
    root.addEventListener("click", bounce);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    window.addEventListener("keyup", keyUp);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("keydown", keyDown);
      root.removeEventListener("click", bounce);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      window.removeEventListener("keyup", keyUp);
      observer?.disconnect();
      mutationObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      for (const element of tracks.keys()) clear(element);
      refreshRef.current = null;
    };
  }, [rootRef]);

  useLayoutEffect(() => { refreshRef.current?.(); }, [mode]);
}
