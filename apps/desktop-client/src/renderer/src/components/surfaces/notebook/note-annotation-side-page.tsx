import type { NoteAnnotationAnchorV1, NoteAnnotationTaskV1, NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteLearningArtifactTaskV1, NoteLearningArtifactV1 } from "@astella/shared/note-learning-artifact-contracts";
import { TaskSlip } from "./task-slip";
import { AnnotationDeleteControl, type AnnotationDeleteView } from "./annotation-delete-control";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { NoteAnnotationQuote } from "./note-annotation-paper";
import { MessageCircle, Play } from "lucide-react";

export function NoteAnnotationSidePage(props: {
  readonly annotation: NoteAnnotationV1 | null;
  readonly task: NoteAnnotationTaskV1 | null;
  readonly artifactTasks: readonly NoteLearningArtifactTaskV1[];
  readonly artifactStarting: boolean;
  readonly artifactError?: string | null;
  readonly readOnlySnapshot?: boolean;
  readonly onReturnToHistory?: () => void;
  readonly onAsk: (anchor: NoteAnnotationAnchorV1) => void;
  readonly onCreateArtifact: (anchor: NoteAnnotationAnchorV1) => void;
  readonly onOpenArtifact: (artifact: NoteLearningArtifactV1) => void;
  readonly onRetry: () => void;
  readonly onSettings: () => void;
  /**
   * 删除。两步确认的状态**由页面持有**（`useAnnotationDeleteConfirm`），因为记号浮层
   * 里那枚「删掉这条」和这里是同一个动作的两个入口——各自存一份的话，会出现
   * 「附页里正问着要不要删，浮层里还是平常那枚 ✕」。
   */
  readonly onDelete?: () => void;
  readonly onCancelDelete?: () => void;
  readonly onConfirmDelete?: () => void;
  readonly deleteView?: AnnotationDeleteView;
  readonly deleting?: boolean;
  readonly deleteError?: string | null;
  readonly removedNotice?: string | null;
}) {
  const { annotation, task } = props;
  if (!annotation && !task) return null;
  const anchor = annotation?.anchor ?? task!.anchor;
  const artifact = props.artifactTasks.find((item) => item.selectionAnchor
    && item.selectionAnchor.noteVersionId === anchor.noteVersionId
    && item.selectionAnchor.startBlockOrdinal === anchor.startBlockOrdinal
    && item.selectionAnchor.startOffset === anchor.startOffset
    && item.selectionAnchor.endBlockOrdinal === anchor.endBlockOrdinal
    && item.selectionAnchor.endOffset === anchor.endOffset
    && item.selectionAnchor.excerpt === anchor.excerpt);
  const [explanation = "", example = ""] = annotation?.explanation.split("\n\n举个例子：", 2) ?? [];
  return <section className="note-annotation-paper" aria-label={annotation ? "原句批注" : "原句解释任务"}>
    {props.onReturnToHistory ? <button type="button" className="text-action" onClick={props.onReturnToHistory}>回学习记录</button> : null}
    {props.readOnlySnapshot && annotation ? <p className="small">{annotation.versionState === "older" ? "旧版的原句与批注，未定位到当前正文" : "原句位置尚未核对，保留这条批注的快照"}</p> : null}
    {annotation ? <>
      {!props.readOnlySnapshot ? <div className="note-annotation-paper__actions">
        <button type="button" className="button" disabled={props.artifactStarting || artifact?.status === "queued" || artifact?.status === "running"} onClick={() => artifact?.status === "ready" && artifact.artifact ? props.onOpenArtifact(artifact.artifact) : props.onCreateArtifact(anchor)}>
          <Play size={15} aria-hidden="true" />{artifact?.status === "ready" && artifact.artifact ? "打开互动演示" : artifact?.status === "queued" ? "排队做演示…" : artifact?.status === "running" ? "正在做演示…" : artifact?.status === "failed" ? "再试一次演示" : "做个互动演示"}
        </button>
        <button type="button" className="text-action" onClick={() => props.onAsk(anchor)}><MessageCircle size={15} aria-hidden="true" />问伴星换种说法</button>
      </div> : null}
      {props.artifactError ? <p role="alert">演示暂时没能开始：{props.artifactError}</p> : null}
      {artifact?.status === "failed" ? <TaskSlip kind="artifact" status={artifact.status} failureReason={artifact.failureReason} onRetry={() => props.onCreateArtifact(anchor)} onOpenSettings={props.onSettings} /> : null}
      <details className="note-annotation-paper__source"><summary>对照原句</summary><blockquote>{anchor.excerpt}</blockquote></details>
      <div className="note-annotation-paper__explanation">{renderCompanionMarkdown(explanation)}</div>
      {example ? <details className="note-annotation-paper__more"><summary>看个比方</summary>{renderCompanionMarkdown(`举个例子：${example}`)}</details> : null}
      <small>{annotation.sourceMessageId ? "伴星补充" : annotation.generationJobId ? "白话解释" : "自己的批注"} · {new Date(annotation.createdAt).toLocaleString()}</small>
      {!props.readOnlySnapshot && props.onDelete ? <AnnotationDeleteControl
        annotation={annotation}
        hasArtifact={artifact?.status === "ready" && Boolean(artifact.artifact)}
        view={props.deleteView ?? "idle"}
        deleting={props.deleting}
        error={props.deleteError}
        onRequest={props.onDelete}
        onCancel={props.onCancelDelete ?? (() => undefined)}
        onConfirm={props.onConfirmDelete ?? props.onDelete}
      /> : null}
      {/* 删成功之后附页**不合上**：留一句说清连带删了什么，让人看得见「真的删掉了」
          而不是「按了一下，纸没了」。那一句只由回执给——服务端没回执就不写它。 */}
      {props.removedNotice ? <p className="small" role="status">{props.removedNotice}</p> : null}
    </> : <>
      <NoteAnnotationQuote excerpt={anchor.excerpt} />
      <TaskSlip kind="annotation" status={task!.status} failureReason={task!.failureReason} onRetry={props.onRetry} onOpenSettings={props.onSettings} />
      {task!.status === "failed" ? <button type="button" className="note-annotation-paper__ask" onClick={() => props.onAsk(anchor)}>让伴星换个说法</button> : null}
    </>}
  </section>;
}
