import type { Ref } from "react";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { plainTextForGroundingV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-measure";
import { ArtifactFrameHost } from "../source/artifact-frame-host";
import type { NoteLearningArtifactTaskV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import { TaskSlip } from "./task-slip";

export function NotebookLearningArtifactPaper(props: {
  readonly artifact: NoteLearningArtifactV1;
  readonly paperRef: Ref<HTMLElement>;
  readonly ready: boolean;
  readonly error: string | null;
  readonly motion: "full" | "reduced";
  readonly referenceBlocks: readonly NoteBlockProjectionV1[];
  readonly onLocateReference: (blockOrdinal: number) => void;
  readonly onRetry: () => void;
  readonly onRegenerate?: () => void;
  readonly regenerationStarting?: boolean;
  readonly regenerationTask?: NoteLearningArtifactTaskV1 | null;
  readonly regenerationError?: string | null;
  readonly onOpenGenerated?: (artifact: NoteLearningArtifactV1) => void;
}) {
  const { artifact } = props;
  const referenceOrdinal = (quote: string): number | null => {
    const target = quote.replace(/\s+/g, "");
    if (!target || artifact.versionState !== "current") return null;
    const matches = props.referenceBlocks.filter(block => plainTextForGroundingV1(block.content).replace(/\s+/g, "").includes(target));
    return matches.length === 1 ? matches[0]!.ordinal : null;
  };
  return <article className="note-learning-artifact-paper" aria-label={artifact.title} ref={props.paperRef} tabIndex={-1} data-task-focus>
    <header className="note-learning-artifact-paper__meta">
      <span className="tag">概念示意</span>
      <span>笔记 v{artifact.noteVersionNumber}{artifact.versionState === "older" ? " · 旧版记录" : ""}</span>
      {props.onRegenerate ? <button type="button" className="text-action" disabled={props.regenerationStarting || props.regenerationTask?.status === "queued" || props.regenerationTask?.status === "running"}
        onClick={props.onRegenerate}>{props.regenerationStarting ? "正在创建演示…" : "重新生成演示"}</button> : null}
      {artifact.selectionText ? <details className="note-learning-artifact-paper__source">
        <summary>对照原句</summary>
        <blockquote>{artifact.selectionText}</blockquote>
        {artifact.selectionAnchor && artifact.versionState === "current" ? <button type="button" className="text-action" onClick={() => props.onLocateReference(artifact.selectionAnchor!.startBlockOrdinal)}>回到这句</button> : null}
      </details> : null}
    </header>
    {props.regenerationStarting || props.regenerationTask && props.regenerationTask.artifact?.artifactId !== artifact.artifactId ? <aside className="notebook-regeneration" aria-label="新互动演示的进度">
      <TaskSlip kind="artifact" status={props.regenerationStarting ? "queued" : props.regenerationTask!.status}
        failureReason={props.regenerationTask?.failureReason} onRetry={props.onRegenerate} />
      {props.regenerationTask?.status === "ready" && props.regenerationTask.artifact ? <button type="button" className="text-action" onClick={() => props.onOpenGenerated?.(props.regenerationTask!.artifact!)}>打开新演示</button> : null}
      <small>当前演示仍可使用，之前的演示留在学习记录里。</small>
    </aside> : null}
    {props.regenerationError ? <p className="notebook-regeneration" role="alert">这次演示没能创建：{props.regenerationError}</p> : null}
    {props.ready ? <ArtifactFrameHost artifactId={artifact.artifactId} contentOnly motion={props.motion} /> : <>
      <h3>{artifact.title}</h3>
      <p className="note-learning-artifact-paper__subject">{artifact.subject}</p>
      {props.error ? <p className="small notebook-note" role="alert">互动页面暂时没能打开：{props.error} <button type="button" className="text-action" onClick={props.onRetry}>重试</button></p>
        : <p className="small notebook-note" role="status">正在打开互动演示…</p>}
    </>}
    <section className="note-learning-artifact-paper__explanation" aria-label="演示的文字说明">
      <h3>这里发生了什么</h3>
      <ol>{artifact.outline.map((item) => {
        const ordinal = referenceOrdinal(item.quote);
        return <li key={`${item.index}:${item.title}`}>
        <strong>{item.title}</strong><p>{item.narration}</p>
        <details className="note-learning-artifact-paper__source">
          <summary>对照原句 · {item.sectionLabel}</summary>
          <blockquote>{item.quote}</blockquote>
          {ordinal !== null ? <button type="button" className="text-action" onClick={() => props.onLocateReference(ordinal)}>回到这句</button> : null}
        </details>
      </li>; })}</ol>
    </section>
    <footer>
      <p className="note-learning-artifact-paper__caution">{artifact.caution}</p>
      <span>已留在学习记录 · <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString()}</time></span>
    </footer>
  </article>;
}
