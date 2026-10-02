import type { Ref } from "react";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { plainTextForGroundingV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-measure";
import { ArtifactFrameHost } from "../source/artifact-frame-host";

export function NotebookLearningArtifactPaper(props: {
  readonly artifact: NoteLearningArtifactV1;
  readonly paperRef: Ref<HTMLElement>;
  readonly ready: boolean;
  readonly error: string | null;
  readonly motion: "full" | "reduced";
  readonly referenceBlocks: readonly NoteBlockProjectionV1[];
  readonly onLocateReference: (blockOrdinal: number) => void;
  readonly onRetry: () => void;
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
      {artifact.selectionText ? <details className="note-learning-artifact-paper__source">
        <summary>对照原句</summary>
        <blockquote>{artifact.selectionText}</blockquote>
        {artifact.selectionAnchor && artifact.versionState === "current" ? <button type="button" className="text-action" onClick={() => props.onLocateReference(artifact.selectionAnchor!.startBlockOrdinal)}>回到这句</button> : null}
      </details> : null}
    </header>
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
