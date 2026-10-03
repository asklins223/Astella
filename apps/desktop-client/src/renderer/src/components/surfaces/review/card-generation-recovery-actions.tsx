import { ArrowLeft, RefreshCw, RotateCcw } from "lucide-react";
import type { CardGenerationSession } from "./use-card-generation-session";

export function CardGenerationRecoveryActions({ session, showReturn = true }: { readonly session: CardGenerationSession; readonly showReturn?: boolean }) {
  const { run, busyAction, revealing, loading, resync, retry, openRecoveryNote } = session;
  const locked = busyAction !== null || revealing;
  return run?.recovery?.allowedActions.map((action) => {
    if (action.kind === "refresh_status") return <button key={action.kind} type="button" className="button" disabled={locked || loading} onClick={() => void resync()}><RefreshCw size={14} aria-hidden="true" />{loading ? "正在重新检查…" : "重新检查"}</button>;
    if (action.kind === "retry_generation") return <button key={action.kind} type="button" className="button primary" disabled={locked} onClick={() => void retry()}><RotateCcw size={14} aria-hidden="true" />{busyAction === "retry" ? "正在重新规划…" : "再生成一次候选"}</button>;
    // The page owns a direct new-generation action in every stopped state.
    if (action.kind === "start_new_generation") return null;
    if (showReturn && (action.kind === "return_note" || action.kind === "open_latest_note")) return <button key={action.kind} type="button" className="button" onClick={() => openRecoveryNote(action.sourceRef)}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button>;
    return null;
  }) ?? null;
}
