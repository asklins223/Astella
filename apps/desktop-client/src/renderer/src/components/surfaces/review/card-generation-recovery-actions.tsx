import { ArrowLeft, RefreshCw, RotateCcw } from "lucide-react";
import type { CardGenerationSession } from "./use-card-generation-session";

export function CardGenerationRecoveryActions({ session }: { readonly session: CardGenerationSession }) {
  const { run, busyAction, revealing, loading, resync, retry, openRecoveryNote } = session;
  const locked = busyAction !== null || revealing;
  return run?.recovery?.allowedActions.map((action) => {
    if (action.kind === "refresh_status") return <button key={action.kind} type="button" className="button" disabled={locked || loading} onClick={() => void resync()}><RefreshCw size={14} aria-hidden="true" />{loading ? "正在重新检查…" : "重新检查"}</button>;
    if (action.kind === "retry_generation") return <button key={action.kind} type="button" className="button primary" disabled={locked} onClick={() => void retry()}><RotateCcw size={14} aria-hidden="true" />{busyAction === "retry" ? "正在重新规划…" : "再生成一次候选"}</button>;
    if (action.kind === "return_note" || action.kind === "open_latest_note" || action.kind === "start_new_generation") return <button key={action.kind} type="button" className={run.recovery?.allowedActions.some((item) => item.kind === "retry_generation") ? "button" : "button primary"} onClick={() => openRecoveryNote(action.sourceRef)}><ArrowLeft size={14} aria-hidden="true" />{action.kind === "start_new_generation" ? "回笔记重新生成" : "返回笔记"}</button>;
    return null;
  }) ?? null;
}
