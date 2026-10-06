import type { ReactElement, Ref } from "react";
import type { NoteOverviewV1 } from "@astella/shared/note-overview-contracts";
import type { NoteLearningArtifactTaskV1, NoteLearningArtifactV1 } from "@astella/shared/note-learning-artifact-contracts";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { overviewReading, pointLead } from "./overview-reading";

export function NoteOverviewPaper(props: {
  readonly overview: NoteOverviewV1;
  readonly paperRef: Ref<HTMLElement>;
  readonly dirty: boolean;
  readonly onCollapse: () => void;
  readonly onLocateReference: (blockOrdinal: number) => void;
  readonly onOpenExpansionPage: () => void;
  readonly onAskCompanion: () => void;
  readonly artifactTask: NoteLearningArtifactTaskV1 | null;
  readonly artifactStarting: boolean;
  readonly onCreateArtifact: () => void;
  readonly onOpenArtifact: (artifact: NoteLearningArtifactV1) => void;
  readonly onRegenerate?: () => void;
  readonly regenerating?: boolean;
}): ReactElement {
  const overview = props.overview;
  const reading = overviewReading(overview);
  const sources = (references: NoteOverviewV1["references"]) => <details className="note-overview-paper__references">
    <summary>翻开原文出处{references.length > 1 ? ` · ${references.length} 处` : ""}</summary>
    {references.map(reference => <div key={`${reference.blockOrdinal}:${reference.quote}`}><blockquote>{reference.quote}</blockquote>
      {overview.versionState === "current" ? <button type="button" className="text-action" onClick={() => props.onLocateReference(reference.blockOrdinal)}>回到第 {reference.blockOrdinal + 1} 段原句</button> : <small>来自笔记 v{overview.noteVersionNumber} · 当时的原文</small>}
    </div>)}
  </details>;
  return <article className="note-overview-paper" aria-label="这篇笔记的速看" ref={props.paperRef} tabIndex={-1} data-task-focus>
    <header><span>笔记 v{overview.noteVersionNumber}{overview.versionState === "older" ? " · 旧版记录" : ""}</span>
      <button type="button" className="text-action" disabled={props.dirty || overview.versionState === "older" || props.artifactStarting || props.artifactTask?.status === "queued" || props.artifactTask?.status === "running"}
        onClick={() => props.artifactTask?.status === "ready" && props.artifactTask.artifact ? props.onOpenArtifact(props.artifactTask.artifact) : props.onCreateArtifact()}>
        {props.artifactTask?.status === "ready" ? "打开互动演示" : props.artifactTask?.status === "queued" ? "排队做演示…" : props.artifactTask?.status === "running" ? "正在做演示…" : "做个互动演示"}
      </button>
      {props.onRegenerate ? <button type="button" className="text-action" disabled={props.regenerating} onClick={props.onRegenerate}>{props.regenerating ? "正在重新生成…" : "重新生成速看"}</button> : null}
      <button type="button" className="text-action" onClick={props.onCollapse}>回正文</button></header>
    <div className="note-overview-paper__gist">{renderCompanionMarkdown(reading.gist)}</div>
    {reading.points.length ? <ol className="note-overview-paper__points" aria-label="这篇的重点">{reading.points.map((point, index) => {
      const { lead, remainder } = pointLead(point.text);
      return <li key={index}><span className="note-overview-paper__number" aria-hidden="true">{index + 1}</span><div>
        <div className="note-overview-paper__lead">{renderCompanionMarkdown(lead)}</div>
        {remainder ? <details className="note-overview-paper__explanation"><summary>展开说明</summary>{renderCompanionMarkdown(remainder)}</details> : null}
        {point.references.length ? sources(point.references) : null}
      </div></li>;
    })}</ol> : null}
    {reading.notes ? <details className="note-overview-paper__body"><summary>继续看完整说明</summary>{renderCompanionMarkdown(reading.notes)}</details> : null}
    {reading.references.length ? sources(reading.references) : null}
    {overview.coverage?.imageBlocksNotRead ? <p className="note-overview-paper__coverage">有 {overview.coverage.imageBlocksNotRead} 处图片没有读取，速看只根据文字整理。</p> : null}
    <footer><span>已留在学习记录</span><button type="button" className="text-action" onClick={props.onOpenExpansionPage}>继续往外学</button><button type="button" className="text-action" disabled={props.dirty} onClick={props.onAskCompanion}>问问伴星</button></footer>
  </article>;
}
