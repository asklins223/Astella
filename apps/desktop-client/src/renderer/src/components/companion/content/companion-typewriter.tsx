import { useEffect, useRef, useState } from "react";
import { useRoomStore } from "../../../app/home/room-store";

import { CompanionTypewriterState, findCompanionTypewriter, prepareCompanionTypewriter } from "../../../app/companion-session/companion-typewriter-state";
export { CompanionTypewriterState } from "../../../app/companion-session/companion-typewriter-state";

/** 只在回复区域提交逐字更新；历史列表、输入区和活动日志不跟着每帧重建。 */
export function useCompanionTypewriter(target: string, live: boolean, identity?: string) {
  const reduced = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  const state = useRef<CompanionTypewriterState | null>(null);
  const prepared = identity ? findCompanionTypewriter(identity) : undefined;
  const hasBeenLive = useRef(live || Boolean(prepared));
  if (!state.current) {
    state.current = prepared ?? (identity && live ? prepareCompanionTypewriter(identity) : new CompanionTypewriterState());
    state.current.setTarget(target, !live);
    if (!hasBeenLive.current || reduced) state.current.finish();
  }
  const [shown, setShown] = useState(state.current.visible);
  useEffect(() => {
    const model = state.current!;
    hasBeenLive.current ||= live;
    model.setTarget(target, !live);
    if (reduced || !hasBeenLive.current) model.finish();
    setShown(model.visible);
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      model.advance(now - previous); previous = now;
      setShown(model.visible);
      frame = model.canAdvance ? requestAnimationFrame(tick) : 0;
    };
    const visibility = () => {
      cancelAnimationFrame(frame); frame = 0;
      if (!document.hidden && model.canAdvance && !reduced) {
        previous = performance.now(); frame = requestAnimationFrame(tick);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", visibility); };
  }, [target, live, reduced]);
  return { text: shown, busy: !reduced && hasBeenLive.current && shown !== target };
}

export function CompanionThinkingStatus({ children }: { readonly children: string }) {
  const reduced = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return <span className="companion-thinking-status" data-active={!reduced && visible || undefined} role="status">{children}</span>;
}
