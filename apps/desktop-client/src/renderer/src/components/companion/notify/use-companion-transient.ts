import { useCallback, useEffect, useRef, useState } from "react";
import { advanceCompanionTransient, noteCompanionTransientActivity, type CompanionTransientEntry } from "./companion-transient-clock";

/** A stable identity cannot be resurrected by a rerender or static hover/focus. */
export function useCompanionTransient(key: string | null, holdMs: number, paused = false) {
  const [dismissedEpoch, setDismissedEpoch] = useState(-1);
  const identityRef = useRef({ key, epoch: 0 });
  if (identityRef.current.key !== key) identityRef.current = { key, epoch: identityRef.current.epoch + 1 };
  const epoch = identityRef.current.epoch;
  const entryRef = useRef<CompanionTransientEntry>({ remainingMs: holdMs, activityUntil: 0 });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    if (!key || !Number.isFinite(holdMs)) return;
    entryRef.current = { remainingMs: holdMs, activityUntil: 0 };
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const expired = advanceCompanionTransient(entryRef.current, now - last, now, document.hidden || pausedRef.current);
      last = now;
      if (expired) {
        window.clearInterval(timer);
        setDismissedEpoch(epoch);
      }
    }, 160);
    return () => window.clearInterval(timer);
  }, [key, holdMs, epoch]);
  const activity = useCallback(() => noteCompanionTransientActivity(entryRef.current, performance.now()), []);
  const dismiss = useCallback(() => { if (key) setDismissedEpoch(epoch); }, [key, epoch]);
  return { visible: key !== null && epoch !== dismissedEpoch, activity, dismiss };
}
