import { useEffect, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";

type TouchSpring = { value: number; velocity: number; target: number; frame: number; time: number };

/** Retarget the same spring on press/release; fast clicks keep their velocity. */
export function stepTouchSpring(value: number, velocity: number, target: number, seconds: number) {
  const steps = Math.max(1, Math.ceil(seconds / .008));
  const dt = seconds / steps;
  const stiffness = target < 1 ? 1000 : 480;
  const damping = target < 1 ? 52 : 25;
  for (let i = 0; i < steps; i++) {
    velocity += ((target - value) * stiffness - velocity * damping) * dt;
    value += velocity * dt;
  }
  return { value, velocity };
}

/** This owns only scale. Paper movement and hover translation have other owners. */
export function useNotebookTouch(root: RefObject<HTMLElement | null>) {
  const mode = useRoomStore(state => state.motionMode);
  const reduced = useRoomStore(state => state.reducedMotion);
  useEffect(() => {
    const node = root.current;
    if (!node || mode !== "full" || reduced) return;
    const springs = new Map<HTMLElement, TouchSpring>();
    let pressed: HTMLElement | null = null;
    const find = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest<HTMLElement>("button, summary") : null;
      return button && node.contains(button) && !button.matches(":disabled") && !button.closest("[inert], [hidden]") ? button : null;
    };
    const retarget = (element: HTMLElement, target: number) => {
      let spring = springs.get(element);
      if (!spring) {
        spring = { value: 1, velocity: 0, target, frame: 0, time: 0 };
        springs.set(element, spring);
      }
      spring.target = target;
      if (spring.frame) return;
      spring.time = performance.now();
      const tick = (now: number) => {
        const seconds = Math.min(.032, Math.max(.001, (now - spring!.time) / 1000));
        spring!.time = now;
        Object.assign(spring!, stepTouchSpring(spring!.value, spring!.velocity, spring!.target, seconds));
        element.style.setProperty("--note-touch-scale", String(spring!.value));
        if (Math.abs(spring!.target - spring!.value) < .0001 && Math.abs(spring!.velocity) < .001) {
          spring!.value = spring!.target;
          spring!.velocity = 0;
          spring!.frame = 0;
          if (spring!.target === 1) { element.style.removeProperty("--note-touch-scale"); springs.delete(element); }
          else element.style.setProperty("--note-touch-scale", String(spring!.target));
          return;
        }
        spring!.frame = requestAnimationFrame(tick);
      };
      spring.frame = requestAnimationFrame(tick);
    };
    const release = () => { if (pressed) retarget(pressed, 1); pressed = null; };
    const press = (target: EventTarget | null) => {
      const button = find(target);
      if (!button) return;
      if (pressed !== button) release();
      pressed = button;
      retarget(button, .955);
    };
    const pointerDown = (event: PointerEvent) => { if (event.button === 0) press(event.target); };
    const pointerOut = (event: PointerEvent) => {
      if (pressed && (!(event.relatedTarget instanceof Node) || !pressed.contains(event.relatedTarget))) release();
    };
    const keyDown = (event: KeyboardEvent) => { if (!event.repeat && (event.key === "Enter" || event.key === " ")) press(event.target); };
    const keyUp = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") release(); };
    node.addEventListener("pointerdown", pointerDown);
    node.addEventListener("pointerout", pointerOut);
    node.addEventListener("keydown", keyDown);
    node.ownerDocument.addEventListener("pointerup", release);
    node.ownerDocument.addEventListener("pointercancel", release);
    node.ownerDocument.addEventListener("keyup", keyUp);
    window.addEventListener("blur", release);
    return () => {
      node.removeEventListener("pointerdown", pointerDown);
      node.removeEventListener("pointerout", pointerOut);
      node.removeEventListener("keydown", keyDown);
      node.ownerDocument.removeEventListener("pointerup", release);
      node.ownerDocument.removeEventListener("pointercancel", release);
      node.ownerDocument.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", release);
      for (const [element, spring] of springs) { cancelAnimationFrame(spring.frame); element.style.removeProperty("--note-touch-scale"); }
    };
  }, [root, mode, reduced]);
}
