import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { AgentRunHistoryV1, AgentRunV1 } from "@astella/shared/agent-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { artifactLabel, goalStatusText, previewAgentArtifact } from "./agent-goal-presentation";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { useJournalDisclosure } from "../journal/companion-journal-view-state";
import { useCompanionResultPreview } from "../journal/companion-result-preview";

function RevisionPaper({ identity, children, summary }: { identity: string; children: ReactNode; summary: ReactNode }) {
  const [open, toggle] = useJournalDisclosure(identity);
  return <details open={open}><summary aria-expanded={open} onClick={event => { event.preventDefault(); toggle(); }}>{summary}</summary>{children}</details>;
}

/** Older requirements stay in the book; each page keeps its own delivery and saved results. */
export function CompanionGoalRevisions({ run, scope, onArtifactOpen }: {
  run: AgentRunV1; scope: number; onArtifactOpen: () => void;
}) {
  const identity = `goal:${scope}:${run.runId}:${run.revision}:revisions`;
  const history = useCompanionResultPreview(state => state.goalHistory);
  const [open, toggle] = useJournalDisclosure(identity);
  const [page, setPage] = useState<AgentRunHistoryV1 | null>(() => history.get(identity) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0), pending = useRef(false);
  const read = useCallback(async (beforeRevision?: number) => {
    if (pending.current) return;
    pending.current = true;
    const request = ++sequence.current;
    setLoading(true); setError(null);
    const current = () => request === sequence.current && useRoomStore.getState().workspaceScopeRevision === scope;
    try {
      const result = unwrapGatewayResult(await window.astella.agent.getRunHistory({ meta: createRequestMeta(), runId: run.runId,
        ...(beforeRevision ? { query: { beforeRevision } } : {}) }));
      if (!current()) return;
      setPage(previous => { const next = beforeRevision && previous ? { ...result,
        items: [...new Map([...previous.items, ...result.items].map(item => [item.revision, item])).values()],
        unrecordedRevisions: [...new Set([...previous.unrecordedRevisions, ...result.unrecordedRevisions])],
      } : result; history.set(identity, next); return next; });
    } catch (cause) { if (current()) setError(gatewayErrorMessage(cause)); }
    finally { if (current()) { pending.current = false; setLoading(false); } }
  }, [run.runId, run.revision, scope, identity, history]);
  useEffect(() => {
    ++sequence.current; pending.current = false; setPage(history.get(identity) ?? null); setError(null); setLoading(false);
    if (open && !history.has(identity)) void read();
    return () => { ++sequence.current; pending.current = false; };
  }, [open, read]);
  return <details className="companion-goal-journal__revisions" open={open}>
    <summary aria-expanded={open} onClick={event => { event.preventDefault(); toggle(); }}>之前的要求与交付</summary>
    {open ? <>
      {page?.items.filter(item => item.revision !== page.currentRevision).map(item => <RevisionPaper key={item.revision} identity={`${identity}:${item.revision}`}
        summary={<><span>第 {item.revision} 次要求</span><small>{item.recordedAt ? new Date(item.recordedAt).toLocaleDateString("zh-CN") : ""}</small></>}>
        <p className="companion-goal-journal__intent">{item.goal}</p>
        <p className="companion-goal-journal__intro">换要求前：{goalStatusText[item.status]}{item.artifacts.length ? ` · 留下 ${item.artifacts.length} 份成果` : ""}</p>
        {item.summary ? <div className="companion-record__body">{renderCompanionMarkdown(item.summary)}</div> : null}
        {item.artifacts.length ? <div className="companion-goal-journal__results">{item.artifacts.map(artifact => <button type="button" key={artifact.id}
          onClick={event => { if (previewAgentArtifact(artifact, scope, run.runId, artifactLabel(artifact, run), event.currentTarget)) onArtifactOpen(); }}><span>{artifactLabel(artifact, run)}</span><ArrowUpRight size={16} /></button>)}</div> : null}
        {item.error ? <p className="companion-goal-error">{item.error}</p> : null}
      </RevisionPaper>)}
      {page?.unrecordedRevisions.length ? <p className="companion-goal-journal__intro">第 {page.unrecordedRevisions.join("、")} 次要求没有保存完整记录，已有成果仍保留在这件事里。</p> : null}
      {loading ? <p role="status">正在加载之前的要求与交付…</p> : null}
      {error ? <p className="companion-goal-error" role="alert">{error}<button type="button" onClick={() => void read(page?.nextBeforeRevision ?? undefined)}>重新读取</button></p> : null}
      {page?.nextBeforeRevision ? <button type="button" className="companion-goal-journal__back" disabled={loading} onClick={() => void read(page.nextBeforeRevision!)}>再翻一些更早的要求</button> : null}
      {page && page.currentRevision === 1 ? <p>这件事还没有改过要求。</p> : null}
    </> : null}
  </details>;
}
