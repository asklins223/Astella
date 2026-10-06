/**
 * 笔记「阅读」这一侧的展示层：从阅读块到块内文到图片，外加两个纯函数。
 *
 * ## 为什么从 `notebook-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件有 5519 行，其中 `NotebookSurface` 单个函数就 4449 行、约 190 个 hook。
 * 这一簇是其中**耦合最干净**的一块：三个组件全是 props 进、JSX 出，不碰任何页面级状态，
 * 依赖只有四个 `@astella/shared` 的类型与两个别处已导出的纯函数
 * （`noteBlockText` / `noteInlineDisplayText`）。所以它是拆分的第一步——
 * 先搬走「搬得动且搬完行为不变」的部分，剩下的主体再按功能域切。
 */

import { Clock3, History, Link2, LoaderCircle, MessageCircle, PencilLine, RefreshCw, Sparkles, X } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";
import type { NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import type {
  NoteAnnotationAnchorV1,
  NoteAnnotationTaskV1,
  NoteAnnotationV1,
} from "@astella/shared/note-annotation-contracts";
import { noteAnchorBlockRangeV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteLearningArtifactTaskV1 } from "@astella/shared/note-learning-artifact-contracts";
import { noteBlockText } from "./surface-data.tsx";
import { isHorizontalRule, noteInlineDisplayText, noteInlineImages, renderNoteInline, renderNotePlainText } from "./note-reading-inline.tsx";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { parseMarkdownTable } from "@astella/shared/note-doc-schema";
import { parseImageBlock } from "./surface-data.tsx";
import { useSourceImage } from "../source/source-image.ts";
import { ZoomableReadingImage } from "../source/image-viewer.tsx";
import { noteReadingTextNodes } from "./note-reading-text";
import { noteExplanationBusy, noteExplanationLabel, type NoteCompanionExplanation } from "../../companion/note-companion-explanation";

/**
 * 阅读正文里**每一块的锚点**（39d W4-6 刀二）：教学面的依据要能"点开定位到那一块"，
 * 而在此之前正文里没有任何能指认某一段的东西。锚点包一层 `.reading-block`，样式表里
 * 三条直接子选择器（`> p` / `> h3` / `> p.list-block`）跟着走进这一层——格线、
 * 标题字号与列表缩进一个字都不变。`data-block-focused` 是"依据点开的那一段"的短暂高亮。
 */





export function ReadingBlock(props: {
  readonly block: NoteBlockProjectionV1;
  readonly annotations?: readonly NoteAnnotationV1[];
  readonly companionExplanations?: readonly NoteCompanionExplanation[];
  readonly onOpenCompanionExplanation?: (item: NoteCompanionExplanation) => void;
  readonly pendingAnnotationTask?: NoteAnnotationTaskV1 | null;
  readonly learningArtifactTasks?: readonly NoteLearningArtifactTaskV1[];
  readonly onCreateLearningArtifact?: (anchor: NoteAnnotationAnchorV1) => void;
  readonly learningArtifactTaskStarting?: boolean;
  readonly openAnnotationId?: string | null;
  readonly onOpenAnnotation?: (annotation: NoteAnnotationV1) => void;
  /** 记号浮层里那一格「删掉这条」：正文里就能删，不必先开附页。 */
  readonly onDeleteAnnotation?: (annotation: NoteAnnotationV1) => ReactNode;
  readonly onRetryAnnotationTask?: () => void;
  readonly onOpenPendingAnnotation?: () => void;
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
  const annotationMark = openAnnotation ? noteAnchorBlockRangeV1(props.block, openAnnotation.anchor) : null;
  const explanations = (props.companionExplanations ?? []).filter(item => noteAnchorBlockRangeV1(props.block, item.target.anchor));
  return (
    <div
      className="reading-block"
      data-block-ordinal={props.block.ordinal}
      {...(props.focused ? { "data-block-focused": "true" } : {})}
    >
      <div data-note-block-content="true"><ReadingBlockContent
        block={props.block}
        mark={annotationMark ?? props.mark}
        workspaceEpoch={props.workspaceEpoch}
        gallery={props.gallery}
        annotations={props.annotations}
        openAnnotationId={props.openAnnotationId}
        onOpenAnnotation={props.onOpenAnnotation}
        onDeleteAnnotation={props.onDeleteAnnotation}
        companionExplanations={explanations}
      /></div>

      {explanations.filter(item => item.target.anchor.startBlockOrdinal === props.block.ordinal).map(item => <div key={item.id} className="note-explanation-progress" data-phase={item.phase}>
        <button type="button" className="text-action" aria-label={`${noteExplanationLabel(item)}，查看解释进度`} onClick={() => props.onOpenCompanionExplanation?.(item)}>
          {noteExplanationBusy(item) ? <LoaderCircle size={12} aria-hidden="true" /> : item.phase === "stopped" ? <SquareStopMark /> : <MessageCircle size={12} aria-hidden="true" />}
          <span role="status">{noteExplanationLabel(item)}{item.text && item.phase === "explaining" ? " · 已有部分内容" : ""}</span>
          <span className="note-explanation-progress__open">查看</span>
        </button>
      </div>)}
      {props.pendingAnnotationTask && props.pendingAnnotationTask.status !== "ready" ? <button type="button" className="text-action" onClick={props.onOpenPendingAnnotation}>查看这句解释的进度</button> : null}
    </div>
  );
}

function SquareStopMark() { return <span className="note-explanation-progress__stop" aria-hidden="true">▪</span>; }

export function textRangeAtOffsets(root: HTMLElement, start: number, end: number): Range | null {
  let current = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;
  let lastNode: Text | null = null;
  for (const text of noteReadingTextNodes(root)) {
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
  annotations,
  openAnnotationId,
  onOpenAnnotation,
  onDeleteAnnotation,
  companionExplanations,
}: {
  readonly block: NoteBlockProjectionV1;
  /** Character range of the sentence this block contributes, when it has one. */
  readonly mark: readonly [number, number] | null;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
  readonly annotations?: readonly NoteAnnotationV1[];
  readonly companionExplanations?: readonly NoteCompanionExplanation[];
  readonly openAnnotationId?: string | null;
  readonly onOpenAnnotation?: (annotation: NoteAnnotationV1) => void;
  /** 记号浮层里那一格「删掉这条」：正文里就能删，不必先开附页。 */
  readonly onDeleteAnnotation?: (annotation: NoteAnnotationV1) => ReactNode;
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
    annotations,
    openAnnotationId,
    block,
    onOpenAnnotation,
    onDeleteAnnotation,
    companionExplanations,
    galleryStart: gallery?.start,
    onOpenGallery: gallery?.openAt,
  };
  if (block.type === "heading") return <h3 className="serif">{renderNoteInline(block.content, inline)}</h3>;
  if (block.type === "code") {
    // 代码块里的换行与星号都是内容，不是语法：`pre` 自己保空白，不走行内解析。
    return <pre className="code-block"><code>{renderNotePlainText(noteBlockText(block.content), inline)}</code></pre>;
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
    const [header, separators, ...rows] = table;
    const alignments = (separators ?? []).map(separator => separator.endsWith(":")
      ? (separator.startsWith(":") ? "center" as const : "right" as const) : "left" as const);
    let offset = 0;
    const cell = (value: string, key: string) => {
      const textOffset = offset;
      offset += noteBlockRenderedTextV1("paragraph", value).length;
      return <span key={key}>{renderNoteInline(value, { ...inline, textOffset })}</span>;
    };
    return (
      <table className="md-table">
        <thead>
          <tr>{header?.map((value, index) => <th scope="col" key={index} style={{ textAlign: alignments[index] }}>{cell(value, `h${index}`)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((value, cellIndex) => <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}>{cell(value, `c${rowIndex}-${cellIndex}`)}</td>)}</tr>
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
 * 下载进对象存储后改写的站内引用。渲染层的 origin 是 `astella-app://`，相对路径
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
