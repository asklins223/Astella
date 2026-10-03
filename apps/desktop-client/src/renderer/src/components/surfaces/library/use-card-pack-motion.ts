import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useRoomStore } from "../../../app/room-store";
import { cardSpringAtRest, stepCardSpring, type CardSpring } from "../../motion/card-spring";

type PackPose = { pitch: number; yaw: number; lift: number; open: number; press: number };
type MotionMode = "full" | "lite" | "off";
const keys: (keyof PackPose)[] = ["pitch", "yaw", "lift", "open", "press"];
const units: Record<keyof PackPose, string> = { pitch: "deg", yaw: "deg", lift: "px", open: "", press: "" };

/** The cover, flap and cards share a pose. A new intent keeps the current velocity. */
export function createCardPackMotion(host: HTMLElement, initial: PackPose) {
  const target = { ...initial };
  const tracks = Object.fromEntries(keys.map(key => [key, { position: initial[key], velocity: 0 }])) as Record<keyof PackPose, CardSpring>;
  let frame = 0, lastTime = 0, mode: MotionMode = "full", destroyed = false;
  const paint = () => {
    for (const key of keys) host.style.setProperty(`--pack-${key}`, `${tracks[key].position}${units[key]}`);
    host.dataset.packMotion = mode;
  };
  const tick = (time: number) => {
    frame = 0;
    if (destroyed) return;
    const dt = Math.min(.04, Math.max(.001, (time - lastTime) / 1000)); lastTime = time;
    for (const key of keys) {
      tracks[key] = stepCardSpring(tracks[key], target[key], dt, key === "press" ? 520 : 330, key === "open" ? 23 : 21);
      if (cardSpringAtRest(tracks[key], target[key])) tracks[key] = { position: target[key], velocity: 0 };
    }
    paint();
    if (keys.some(key => !cardSpringAtRest(tracks[key], target[key]))) draw();
  };
  function draw() {
    if (destroyed) return;
    if (mode !== "full") {
      cancelAnimationFrame(frame); frame = 0;
      for (const key of keys) tracks[key] = { position: target[key], velocity: 0 };
      paint();
    } else if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(tick); }
  }
  paint();
  return {
    target(next: Partial<PackPose>) { Object.assign(target, next); draw(); },
    mode(next: MotionMode) { if (mode === next) return; mode = next; draw(); },
    pose() { return Object.fromEntries(keys.map(key => [key, tracks[key].position])) as PackPose; },
    destroy() { destroyed = true; cancelAnimationFrame(frame); for (const key of keys) host.style.removeProperty(`--pack-${key}`); delete host.dataset.packMotion; },
  };
}

export function useCardPackMotion(ref: RefObject<HTMLElement | null>, opened = false, flat = false) {
  const requestedMode = useRoomStore(state => state.motionMode), reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : requestedMode;
  const controller = useRef<ReturnType<typeof createCardPackMotion> | null>(null);
  const hovered = useRef(false), pressed = useRef(false);
  const base = { pitch: flat ? 0 : -7, yaw: flat ? 0 : -14 };
  const rest = () => ({ ...base, lift: hovered.current ? -8 : 0, open: opened ? 1 : hovered.current && !flat ? .16 : 0, press: pressed.current ? 1 : 0 });
  const update = () => controller.current?.target(mode === "full" ? rest() : { ...base, lift: 0, open: opened ? 1 : 0, press: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const motion = createCardPackMotion(ref.current, { ...base, lift: 0, open: 0, press: 0 });
    controller.current = motion;
    return () => { motion.destroy(); controller.current = null; };
  }, [ref, flat]);
  useLayoutEffect(() => {
    controller.current?.mode(mode);
    controller.current?.target(mode === "full" ? rest() : { ...base, lift: 0, open: opened ? 1 : 0, press: 0 });
  }, [mode, opened, flat]);
  const settle = () => { hovered.current = false; pressed.current = false; controller.current?.target(rest()); };
  return {
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (mode !== "full" || event.pointerType !== "mouse") return;
      hovered.current = true;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1) * 2 - 1));
      const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / Math.max(rect.height, 1) * 2 - 1));
      controller.current?.target({ ...rest(), pitch: base.pitch - y * 6, yaw: base.yaw + x * 9 });
    },
    onPointerEnter(event: PointerEvent<HTMLElement>) { if (mode === "full" && event.pointerType === "mouse") { hovered.current = true; controller.current?.target(rest()); } },
    onPointerLeave: settle,
    onPointerDown() { if (mode === "full") { pressed.current = true; controller.current?.target(rest()); } },
    onPointerUp() { pressed.current = false; update(); },
    onPointerCancel: settle,
    onFocus() { if (mode === "full") { hovered.current = true; controller.current?.target(rest()); } },
    onBlur: settle,
    onKeyDown(event: KeyboardEvent<HTMLElement>) { if (mode === "full" && (event.key === " " || event.key === "Enter")) { pressed.current = true; update(); } },
    onKeyUp(event: KeyboardEvent<HTMLElement>) { if (event.key === " " || event.key === "Enter") { pressed.current = false; update(); } },
  };
}
