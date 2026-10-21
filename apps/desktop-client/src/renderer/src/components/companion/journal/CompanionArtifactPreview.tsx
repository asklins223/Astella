import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentArtifactRefV1 } from "@astella/shared/agent-contracts";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { useNotebookGoalResult } from "../../surfaces/notebook/learning/use-notebook-goal-result";
import { NoteMindMapPaper } from "../../surfaces/notebook/generation/note-mind-map-paper";
import { ArtifactFrameHost } from "../../surfaces/source/artifact-frame-host";
import { renderCompanionMarkdown } from "../content/companion-markdown";
import { previewCompanionNote } from "./companion-result-preview";

/** Reuses saved receipts and the application renderer; preview never generates a replacement. */
export function CompanionArtifactPreview({ artifact, epoch, currentVersionId, goalRunId, motion, onReady }: {
  artifact: AgentArtifactRefV1; epoch: number | undefined;
  currentVersionId: string | null; goalRunId?: string; motion: "full" | "lite" | "off";
  onReady?: () => void;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const epochRef = useRef(epoch); epochRef.current = epoch;
  const requested = useMemo(() => ({ kind: artifact.kind, artifactId: artifact.id, taskId: artifact.jobId,
    noteVersionId: artifact.noteVersionId }), [artifact]);
  const saved = useNotebookGoalResult(artifact.noteId, requested, epochRef);
  useLayoutEffect(() => { if (!saved.loading) onReady?.(); }, [saved.loading, saved.result, onReady]);
  const [frame, setFrame] = useState<{ id: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (saved.result?.kind !== "note_dynamic_artifact") return;
    let current = true;
    void window.astella.artifact.ensure({ meta: createRequestMeta(epoch), artifactId: artifact.id, origin: "note_learning" })
      .then(unwrapGatewayResult).then(() => { if (current && useRoomStore.getState().workspaceScopeRevision === scope) setFrame({ id: artifact.id }); })
      .catch(error => { if (current) setFrame({ id: artifact.id, error: gatewayErrorMessage(error) }); });
    return () => { current = false; };
  }, [saved.result, artifact.id, scope, attempt]);
  const references = (items: { blockOrdinal: number; quote: string }[]) => items.length ? <details open>
    <summary>原文出处 · {items.length} 处</summary>{items.map((reference, index) => <div key={index}>
      <blockquote>{reference.quote}</blockquote><button type="button" onClick={event => previewCompanionNote({
        noteId: artifact.noteId, noteVersionId: artifact.noteVersionId, title: "成果引用的原文", goalRunId,
        blockOrdinal: reference.blockOrdinal,
      }, event.currentTarget)}>查看第 {reference.blockOrdinal + 1} 段原文</button>
    </div>)}</details> : null;
  if (saved.loading) return <p role="status">正在读取这份已保存的成果…</p>;
  if (saved.error || !saved.result) return <div role="status"><p>{saved.error ?? "这份成果暂时没有读到。"}</p>
    <button type="button" onClick={saved.retry}>重新读取</button></div>;
  const result = saved.result;
  if (result.kind === "note_mind_map") return <NoteMindMapPaper key={artifact.id} map={result.mindMap}
    currentVersionId={currentVersionId} unversioned={false} regenerating={false} epoch={epoch} />;
  if (result.kind === "note_overview") return <article>{renderCompanionMarkdown(result.overview.body)}
    {result.overview.points?.map((point, index) => <section key={index}>{renderCompanionMarkdown(point.explanation)}{references([point])}</section>)}
    {references(result.overview.references)}</article>;
  if (result.kind === "note_expansion") return <div>{result.task.drafts.map(draft => <article key={draft.candidateId}>
    <h3>{draft.title}</h3><p>{draft.relationship}</p>{renderCompanionMarkdown(draft.blocks.map(block => noteBlockMarkdown(block.type, block.content)).join("\n\n"))}
    {references(draft.sourceReferences)}</article>)}{!result.task.drafts.length ? <p>这次没有留下可阅读的拓展草稿。</p> : null}</div>;
  return frame?.id === artifact.id && !frame.error ? <ArtifactFrameHost artifactId={artifact.id} contentOnly motion={motion === "full" ? "full" : "reduced"} />
    : <div role="status"><p>{frame?.error ?? "正在准备已保存的互动演示…"}</p>{frame?.error ? <button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取演示</button> : null}</div>;
}
