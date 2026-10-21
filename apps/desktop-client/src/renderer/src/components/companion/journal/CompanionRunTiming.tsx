import { useEffect, useMemo, useRef, useState } from "react";

export function companionElapsedLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
}

/** Wall-clock waiting and idle time for one run, observed rather than estimated. */
function useRunElapsed({ runId, startedAt, latestActivityAt, activityKey, active }: {
  runId: string; startedAt?: string; latestActivityAt?: string; activityKey?: string | number; active: boolean;
}) {
  const seenAt = useMemo(() => Date.now(), [runId]);
  const activity = useRef({ runId, key: activityKey, at: seenAt });
  if (activity.current.runId !== runId || activity.current.key !== activityKey)
    activity.current = { runId, key: activityKey, at: Date.now() };
  const [now, setNow] = useState(seenAt);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, runId]);
  const start = startedAt && Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : seenAt;
  const latest = latestActivityAt && Number.isFinite(Date.parse(latestActivityAt))
    ? Math.max(Date.parse(latestActivityAt), activity.current.at) : activity.current.at;
  return { elapsed: Math.max(0, now - start) / 1_000, idle: Math.max(0, now - latest) / 1_000 };
}

/** Full-width row for documents (journal, process rail). */
export function CompanionRunTiming(props: {
  runId: string; startedAt?: string; latestActivityAt?: string; activityKey?: string | number; active: boolean;
}) {
  const { active } = props;
  const { elapsed, idle } = useRunElapsed(props);
  const delayed = active && idle >= 10;
  return <div className="companion-run-timing" data-delayed={delayed || undefined}>
    <span>{active ? "已等待" : "用时"} {companionElapsedLabel(elapsed)}</span>
    {delayed ? <span role="status">{idle >= 30 ? "暂时没有新进展，已有成果仍可查看；可停止这一轮。" : "这一步比平时久，仍在等待服务返回。"}</span> : null}
  </div>;
}

/**
 * Compact counter for the reply bubble heading. The body stays for content; the
 * elapsed time sits beside her name where it reads at a glance and does not push
 * the answer down.
 */
export function CompanionRunClock(props: {
  runId: string; startedAt?: string; latestActivityAt?: string; activityKey?: string | number; active?: boolean;
}) {
  const { elapsed, idle } = useRunElapsed({ ...props, active: props.active ?? true });
  // A run that answers in a second should not flash "0 秒"; the counter appears
  // once waiting is actually noticeable.
  if (elapsed < 2) return null;
  const delayed = idle >= 10;
  return <span className="companion-run-clock" data-delayed={delayed || undefined}
    aria-label={`已等待 ${companionElapsedLabel(elapsed)}${delayed ? "，这一步比平时久" : ""}`}>
    {companionElapsedLabel(elapsed)}
  </span>;
}

/** Only speaks up once progress stalls; the counter itself lives in the heading. */
export function CompanionRunDelay(props: {
  runId: string; startedAt?: string; latestActivityAt?: string; activityKey?: string | number;
}) {
  const { idle } = useRunElapsed({ ...props, active: true });
  if (idle < 10) return null;
  return <p className="companion-run-delay" role="status">
    {idle >= 30 ? "暂时没有新进展，已有成果仍可查看；可停止这一轮。" : "这一步比平时久，仍在等待服务返回。"}
  </p>;
}
