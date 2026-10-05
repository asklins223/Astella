import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useRoomStore } from "../../app/room-store";
import { paperSpringAtRest, stepPaperSpring } from "../motion/paper-spring";

/** 开合共用当前位置与速度；关闭立即撤去操作，重开可以接住尚未离开的册页。 */
export function useCompanionJournalMotion(open: boolean, rootRef: RefObject<HTMLElement | null>, preference: "full" | "lite" | "off") {
  const reduced = useRoomStore(state => state.reducedMotion);
  const mode = reduced ? "off" : preference;
  const [mounted, setMounted] = useState(open);
  const runtime = useRef({ value: { value: 0, velocity: 0 }, frame: 0, time: 0 });
  useLayoutEffect(() => {
    if (open && !mounted) { setMounted(true); return; }
    const root = rootRef.current;
    if (!root) return;
    const state = runtime.current;
    const target = open ? 1 : 0;
    const paint = () => root.style.setProperty("--journal-presence", String(state.value.value));
    const finish = () => {
      state.value = { value: target, velocity: 0 }; paint();
      state.frame = 0; state.time = 0;
      if (!open) setMounted(false);
    };
    const tick = (time: number) => {
      const seconds = Math.min(.04, Math.max(0, (time - state.time) / 1000));
      state.time = time;
      state.value = mode === "lite"
        ? { value: target + (state.value.value - target) * Math.exp(-28 * seconds), velocity: 0 }
        : stepPaperSpring(state.value, target, seconds, 460, 33);
      paint();
      if (paperSpringAtRest(state.value, target)) finish();
      else state.frame = requestAnimationFrame(tick);
    };
    if (mode === "off") finish();
    else { paint(); state.time = performance.now(); state.frame = requestAnimationFrame(tick); }
    return () => { cancelAnimationFrame(state.frame); state.frame = 0; state.time = 0; };
  }, [open, mounted, mode, rootRef]);
  return { mounted, exiting: !open, mode };
}
