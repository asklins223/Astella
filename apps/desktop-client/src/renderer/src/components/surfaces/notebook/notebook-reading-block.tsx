/**
 * 笔记「阅读」这一侧的展示层：从阅读块到块内文到图片，外加两个纯函数。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件有 5519 行，其中 `NotebookSurface` 单个函数就 4449 行、约 190 个 hook。
 * 这一簇是其中**耦合最干净**的一块：三个组件全是 props 进、JSX 出，不碰任何页面级状态，
 * 依赖只有四个 `@ailearn/shared` 的类型与两个别处已导出的纯函数
 * （`noteBlockText` / `noteInlineDisplayText`）。所以它是拆分的第一步——
 * 先搬走「搬得动且搬完行为不变」的部分，剩下的主体再按功能域切。
 */

import { Clock3, History, Link2, LoaderCircle, MessageCircle, PencilLine, RefreshCw, Sparkles, X } from "lucide-react";
import { Fragment } from "react";
import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import type {
  NoteAnnotationAnchorV1,
  NoteAnnotationTaskV1,
  NoteAnnotationV1,
} from "@ailearn/shared/note-annotation-contracts";
import type { NoteLearningArtifactTaskV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import { noteBlockText } from "./surface-data.tsx";
import { isHorizontalRule, noteInlineDisplayText, noteInlineImages, renderNoteInline } from "./note-reading-inline.tsx";
import { TaskSlip } from "./task-slip.tsx";
import { parseMarkdownTable } from "./note-blocks.ts";
import { parseImageBlock } from "./surface-data.tsx";
import { useSourceImage } from "../source/source-image.ts";
import { ZoomableReadingImage } from "../source/image-viewer.tsx";

/**
 * 截断摘要。与 `notebook-surface.tsx:664` 的同名函数是**一对孪生**（签名 `(value, max = 96)`），
 * 而 `source-segments.ts:126` 还有一个同名的（签名 `(text)`、46 字）。搬文件时接错了那一个，
 * 表现为 `Expected 1 arguments, but got 2`。两份签名不同、截断长度不同，所以**不能互相替代**。
 * 后续把这两个收进同一个 `note-truncate.ts` 才算收干净。
 */
function excerpt(value: string, max = 96): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 阅读正文里**每一块的锚点**（39d W4-6 刀二）：教学面的依据要能"点开定位到那一块"，
 * 而在此之前正文里没有任何能指认某一段的东西。锚点包一层 `.reading-block`，样式表里
 * 三条直接子选择器（`> p` / `> h3` / `> p.list-block`）跟着走进这一层——格线、
 * 标题字号与列表缩进一个字都不变。`data-block-focused` 是"依据点开的那一段"的短暂高亮。
 */
function sameNoteAnchor(left: NoteAnnotationAnchorV1, right: NoteAnnotationAnchorV1): boolean {
  return left.noteVersionId === right.noteVersionId
    && left.startBlockOrdinal === right.startBlockOrdinal
    && left.startOffset === right.startOffset
    && left.endBlockOrdinal === right.endBlockOrdinal
    && left.endOffset === right.endOffset
    && left.excerpt === right.excerpt
    && left.prefix === right.prefix
    && left.suffix === right.suffix;
}

function annotationExplanationParts(value: string): { lead: string; more: string; example: string } {
  const [explanation = "", example = ""] = value.split("\n\n举个例子：", 2);
  const main = explanation.trim();
  const sentenceEnd = main.search(/[。！？!?]/u);
  if (main.length > 145 && sentenceEnd >= 24 && sentenceEnd < 145) {
    return { lead: main.slice(0, sentenceEnd + 1), more: main.slice(sentenceEnd + 1).trim(), example: example.trim() };
  }
  return { lead: main, more: "", example: example.trim() };
}


export function ReadingBlock(props: {
  readonly block: NoteBlockProjectionV1;
  readonly annotations?: readonly NoteAnnotationV1[];
  readonly pendingAnnotationTask?: NoteAnnotationTaskV1 | null;
  readonly selection?: { text: string; anchor: NoteAnnotationAnchorV1 | null } | null;
  readonly selectionBusy?: boolean;
  readonly selectionDirty?: boolean;
  readonly onExplainSelection?: () => void;
  readonly onAskSelection?: () => void;
  readonly onDismissSelection?: () => void;
  readonly learningArtifactTasks?: readonly NoteLearningArtifactTaskV1[];
  readonly onCreateLearningArtifact?: (anchor: NoteAnnotationAnchorV1) => void;
  readonly learningArtifactTaskStarting?: boolean;
  readonly openAnnotationId?: string | null;
  readonly onOpenAnnotation?: (annotation: NoteAnnotationV1) => void;
  readonly onRetryAnnotationTask?: () => void;
  readonly onOpenAiConsentSettings?: () => void;
  readonly onAskCompanion?: (anchor: NoteAnnotationAnchorV1) => void;
  /** 依据点开的那一段：短暂高亮（W4-6 刀二）。 */
  readonly focused?: boolean;
  readonly mark: readonly [number, number] | null;
  readonly workspaceEpoch?: number;
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  const openAnnotation = props.annotations?.find((annotation) => annotation.annotationId === props.openAnnotationId);
  const annotationMark = openAnnotation?.anchor.startBlockOrdinal === props.block.ordinal
    ? [openAnnotation.anchor.startOffset, openAnnotation.anchor.endOffset] as const
    : null;
  return (
    <div
      className="reading-block"
      data-block-ordinal={props.block.ordinal}
      {...(props.focused ? { "data-block-focused": "true" } : {})}
    >
      <ReadingBlockContent
        block={props.block}
        mark={annotationMark ?? props.mark}
        workspaceEpoch={props.workspaceEpoch}
        gallery={props.gallery}
      />
      {props.selection ? (
        <div className="notebook-selection-actions" data-note-selection-action="true" role="group" aria-label="已选原文">
          <q className="notebook-selection-actions__excerpt">{excerpt(props.selection.text, 90)}</q>
          {props.selection.anchor ? (
            <button type="button" className="notebook-selection-actions__main"
              disabled={props.selectionBusy || props.selectionDirty}
              title={props.selectionDirty ? "先保存改动，再讲这句" : "把解释贴在原句旁边"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onExplainSelection}>
              {props.selectionBusy ? "正在准备…" : "讲讲这句"}
            </button>
          ) : <span className="notebook-selection-actions__reason">请选同一段里的句子，才能贴回原文。</span>}
          <button type="button" className="notebook-selection-actions__companion"
            onPointerDown={(event) => event.preventDefault()} onClick={props.onAskSelection}>
            <MessageCircle size={14} aria-hidden="true" />问伴星
          </button>
          <button type="button" className="notebook-selection-actions__dismiss" aria-label="收起选句操作"
            onPointerDown={(event) => event.preventDefault()} onClick={props.onDismissSelection}><X size={14} aria-hidden="true" /></button>
        </div>
      ) : null}
      {props.annotations?.length ? (
        <div className="note-annotation-tabs" aria-label="这段的批注">
          {props.annotations.map((annotation) => (
            <button
              type="button"
              key={annotation.annotationId}
              aria-expanded={props.openAnnotationId === annotation.annotationId}
              onClick={() => props.onOpenAnnotation?.(annotation)}
          >
              <span aria-hidden="true">✦</span> “{annotation.anchor.excerpt.length > 22 ? `${annotation.anchor.excerpt.slice(0, 22)}…` : annotation.anchor.excerpt}”
            </button>
          ))}
        </div>
      ) : null}
      {props.annotations?.map((annotation) => {
        if (props.openAnnotationId !== annotation.annotationId) return null;
        const task = props.learningArtifactTasks?.find((item) => item.selectionAnchor && sameNoteAnchor(item.selectionAnchor, annotation.anchor));
        const explanation = annotationExplanationParts(annotation.explanation);
        return (
          <aside className="note-annotation-paper" key={`paper:${annotation.annotationId}`} aria-label="原句批注">
            <button type="button" className="note-annotation-paper__close" onClick={() => props.onOpenAnnotation?.(annotation)} aria-label="收起批注">收起</button>
            <blockquote>{annotation.anchor.excerpt}</blockquote>
            <p>{explanation.lead}</p>
            {explanation.more || explanation.example ? (
              <details className="note-annotation-paper__more">
                <summary>{explanation.more ? "再看详细说明" : "看个比方"}</summary>
                {explanation.more ? <p>{explanation.more}</p> : null}
                {explanation.example ? <p>举个例子：{explanation.example}</p> : null}
              </details>
            ) : null}
            <small>{annotation.sourceMessageId ? "伴星补充" : "白话解释"} · {new Date(annotation.createdAt).toLocaleString()}</small>
            <div className="note-annotation-paper__actions">
              <button type="button" className="note-annotation-paper__ask" onClick={() => props.onAskCompanion?.(annotation.anchor)}>问伴星换种说法</button>
              <button type="button" className="note-annotation-paper__ask" disabled={props.learningArtifactTaskStarting || task?.status === "queued" || task?.status === "running"} onClick={() => props.onCreateLearningArtifact?.(annotation.anchor)}>
                {task?.status === "queued" ? "排队做演示…" : task?.status === "running" ? "正在做演示…" : task?.status === "failed" ? "再试一次演示" : "做个互动演示"}
              </button>
            </div>
          </aside>
        );
      })}
      {props.pendingAnnotationTask && props.pendingAnnotationTask.status !== "ready" ? (
        <aside className="note-annotation-paper note-annotation-paper--task" aria-label="原句解释任务" role={props.pendingAnnotationTask.status === "failed" ? undefined : "status"}>
          <blockquote>{props.pendingAnnotationTask.anchor.excerpt}</blockquote>
          {/* 原句留在顶部（41 §2.3），状态收进同一张纸签。
              关键的一处差别：以前这一格只说「完成后会贴在这里」，读起来像
              「得站在这儿等」；现在它明说正文照常能读——那句就是继续阅读的许可。 */}
          <TaskSlip
            kind="annotation"
            status={props.pendingAnnotationTask.status}
            failureReason={props.pendingAnnotationTask.failureReason}
            onRetry={props.onRetryAnnotationTask}
            onOpenSettings={props.onOpenAiConsentSettings}
          />
          {/* 讲不成时伴星仍是一条真出路（41 §4：她可在用户点她时换个说法）。 */}
          {props.pendingAnnotationTask.status === "failed" ? (
            <button type="button" className="note-annotation-paper__ask" onClick={() => props.onAskCompanion?.(props.pendingAnnotationTask!.anchor)}>让伴星换个说法</button>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

export function textRangeAtOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;
  let lastNode: Text | null = null;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    const next = current + text.data.length;
    if (!startNode && start >= current && start <= next) {
      startNode = text;
      startNodeOffset = Math.min(text.data.length, start - current);
    }
    if (end >= current && end <= next) {
      endNode = text;
      endNodeOffset = Math.min(text.data.length, end - current);
      if (startNode) break;
    }
    current = next;
    lastNode = text;
  }
  if (!startNode || !endNode) {
    if (!startNode && start === current && lastNode) {
      startNode = lastNode;
      startNodeOffset = lastNode.data.length;
    }
    if (!endNode && end === current && lastNode) {
      endNode = lastNode;
      endNodeOffset = lastNode.data.length;
    }
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

export function ReadingBlockContent({
  block,
  mark,
  workspaceEpoch,
  gallery,
}: {
  readonly block: NoteBlockProjectionV1;
  /** Character range of the sentence this block contributes, when it has one. */
  readonly mark: readonly [number, number] | null;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
  /**
   * 这一块第一张图在整篇画廊里的序号与开关（一块可以有好几张：编辑器里的图是行内
   * 节点）。没有图的块不传，那时行内图仍可单独放大，只是不进整篇画廊。
   */
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  if (block.type === "image") {
    // 图片块要先取字节再画图，所以由自己的组件承载状态：hook 不能排在这一串
    // 按块类型分叉的早返回之后。
    return <ReadingImage block={block} workspaceEpoch={workspaceEpoch} gallery={gallery} />;
  }
  const inline = {
    mark,
    workspaceEpoch,
    galleryStart: gallery?.start,
    onOpenGallery: gallery?.openAt,
  };
  if (block.type === "heading") return <h3 className="serif">{renderNoteInline(block.content, inline)}</h3>;
  if (block.type === "code") {
    // 代码块里的换行与星号都是内容，不是语法：`pre` 自己保空白，不走行内解析。
    return <pre className="code-block"><code>{noteBlockText(block.content)}</code></pre>;
  }
  if (block.type === "list") {
    // 每一项占一行、带自己的记号：以前整块列表压成一行，第二项开始根本看不出是列表。
    return <p className="list-block">{renderNoteInline(block.content, { ...inline, lineClass: "list-line" })}</p>;
  }
  if (block.type === "quote") return <p className="quote">{renderNoteInline(block.content, inline)}</p>;
  // Tables have no block type; a paragraph of pipe rows renders as one.
  const table = parseMarkdownTable(noteBlockText(block.content));
  if (table) {
    // 第二行是**语法**不是内容（`| --- | --- |` 那一条分隔行），跟着画就多出一整行减号。
    const [header, , ...rows] = table;
    const cell = (value: string, key: string) => <span key={key}>{renderNoteInline(value, { mark: null })}</span>;
    return (
      <table className="md-table">
        <thead>
          <tr>{header?.map((value, index) => <th key={index}>{cell(value, `h${index}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((value, cellIndex) => <td key={cellIndex}>{cell(value, `c${rowIndex}-${cellIndex}`)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  // 编辑器把 `---` 画成一条线，投影回来它是一个内容为 `---` 的段落；不认出来就是
  // 纸面上凭空多出三个减号。
  if (isHorizontalRule(noteInlineDisplayText(block.content))) return <hr className="reading-rule" />;
  return <p>{renderNoteInline(block.content, inline)}</p>;
}

/**
 * A stored image block (`![alt](url)`).
 *
 * 从来源起稿的笔记里，这个地址是 `/api/uploads/{objectKey}`：解析把网页内嵌图片
 * 下载进对象存储后改写的站内引用。渲染层的 origin 是 `ailearn-app://`，相对路径
 * 会落到应用包内，所以图由 main 带会话令牌取回字节，这里用 blob URL 画出来。
 * 站外地址仍原样交给 `<img>`；取不回来时只这一张缺位，正文照旧读下去。
 */
export function ReadingImage({
  block,
  workspaceEpoch,
  gallery,
}: {
  readonly block: NoteBlockProjectionV1;
  readonly workspaceEpoch?: number;
  readonly gallery?: {
    readonly start: number;
    readonly openAt: (index: number) => void;
    readonly close: () => void;
  };
}) {
  const image = parseImageBlock(block.content);
  const { state, retry } = useSourceImage(image?.url ?? "", workspaceEpoch);

  if (!image) return <p className="small">图片片段无法解析：{block.content}</p>;

  const alt = image.alt || "笔记图片";
  if (state.status === "external" || state.status === "ready") {
    return (
      <ZoomableReadingImage
        src={state.src}
        alt={alt}
        retryable={state.status === "ready"}
        onRetry={retry}
        // 有整篇画廊时开关归画廊（受控，组件自己不再叠一层灯箱）；没有就单张放大。
        open={gallery ? false : undefined}
        onOpenChange={(open) => {
          if (!gallery) return;
          if (open) gallery.openAt(gallery.start);
          else gallery.close();
        }}
      />
    );
  }
  if (state.status === "loading") return <p className="small notebook-note">正在载入图片…</p>;
  return <p className="small notebook-note">这张图片没能取回：{alt}</p>;
}

