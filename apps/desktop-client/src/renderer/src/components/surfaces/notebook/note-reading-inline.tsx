import { noteMarkdownTree, noteMarkdownText } from "@astella/shared/note-markdown";
import type { ReactNode } from "react";
import { noteAnchorBlockRangeV1, type NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { parseInlineMarkdown, type NoteDocInlineSegment } from "@astella/shared/note-doc-schema";
import { isWebLinkUrl } from "@astella/shared/desktop-ipc-contracts";
import { noteBlockText } from "./surface-data.tsx";
import { ZoomableReadingImage } from "../source/image-viewer.tsx";
import { useSourceImage } from "../source/source-image.ts";
import { openExternalLink } from "../../../app/external-link";
import { NoteAnnotationMark } from "./note-annotation-mark";
import type { NoteCompanionExplanation } from "../../companion/note-companion-explanation";
import { ReadableMath } from "../../content/readable-math";

/**
 * 阅读页怎么画一块正文。
 *
 * 一块的 `content` 不是"一行纯文本"，它是**带结构的 Markdown 原文**：段内换行是 `\n`、
 * 粗体是 `**`、图片是 `![](...)`。这三样以前都按字面画进 `<p>`，于是
 * 「编辑器里换的行在预览里没了」「`**重点**` 露着星号」「段落里的图整张看不见」。
 *
 * 所以这里不引入第二种语法：行内解析用 `note-doc-schema` 里那一份（服务端把块写回文档、
 * 编辑器写出的也是它），只是**画**出来。
 *
 * `Atom` 是这条路的中间形状：一个原子带自己在**显示文本**里的偏移区间。偏移只准有一份，
 * 因为「概念句」那条高亮是按字符区间切的——它和渲染各算一份，高亮就会整体错位几个
 * 标记符号的距离。图片是原子节点，不占字符（`start === end`）。
 */
export type NoteInlineAtom =
  | { readonly kind: "text" | "strong" | "em" | "strike" | "code"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: "link"; readonly text: string; readonly href: string; readonly start: number; readonly end: number }
  | { readonly kind: "image"; readonly alt: string; readonly src: string; readonly start: number; readonly end: number }
  | { readonly kind: "math"; readonly text: string; readonly value: string; readonly display: boolean; readonly start: number; readonly end: number }
  | { readonly kind: "break"; readonly start: number; readonly end: number };

/** CommonMark 的"反斜杠转义只挡 ASCII 标点"，还原的就是这一批。 */
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

/**
 * 反斜杠转义还原成它挡着的那个字符。编辑器解析过 Markdown，画出来的是 `~`；
 * 阅读页不还原就会露出 `干杯\~-bilibili` 这种字面串。
 *
 * 只在**文本**那一侧做：行内代码里的反斜杠是内容不是转义（`` `a\b` `` 还原成 `ab`
 * 就是静默改代码）。
 */
function unescapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE, "$1");
}

const ESCAPABLE: Record<string, true> = { text: true, strong: true, em: true, strike: true, link: true };

/** 一段块的正文 → 原子序列（含行与行之间那个 `\n` 对应的 `break`）。 */
export function noteInlineAtoms(content: string): NoteInlineAtom[] {
  const atoms: NoteInlineAtom[] = [];
  let cursor = 0;
  for (const segment of parseInlineMarkdown(noteBlockText(content))) {
      if (segment.kind === "image") {
        // 图片不占显示字符：高亮的偏移量算的是"看得见的字"。
        atoms.push({ kind: "image", alt: segment.alt, src: segment.src, start: cursor, end: cursor });
        continue;
      }
      if (segment.kind === "math") {
        const text = segment.text.replace(/\n/g, "");
        atoms.push({ ...segment, text, start: cursor, end: cursor + text.length });
        cursor += text.length;
        continue;
      }
      segment.text.split("\n").forEach((line, index) => {
      if (index > 0) atoms.push({ kind: "break", start: cursor, end: cursor });
      const text = ESCAPABLE[segment.kind] === true ? unescapeMarkdown(line) : line;
      const at = { start: cursor, end: cursor + text.length };
      atoms.push(segment.kind === "link"
        ? { kind: "link", text, href: segment.href, ...at }
        : { kind: segment.kind, text, ...at });
      cursor += text.length;
      });
  }
  return atoms;
}

/** 这一屏真正显示出来的那几个字。概念句的高亮区间按它算，与渲染同源。 */
export function noteInlineDisplayText(content: string): string {
  return noteMarkdownText(noteMarkdownTree(content));
}

/** 这一块里画得出来的图片有几张（整篇画廊要按正文顺序编号）。 */
export function noteInlineImageCount(content: string): number {
  return noteInlineImages(content).length;
}

/** 这一块里的行内图片，按正文顺序。整篇画廊要拿它编号，渲染要拿它画，同一份来源。 */
export function noteInlineImages(content: string): { readonly src: string; readonly alt: string }[] {
  const images: { src: string; alt: string }[] = [];
  const walk = (node: ReturnType<typeof noteMarkdownTree> | import("@astella/shared/note-markdown").NoteMarkdownNode) => {
    if (node.type !== "element" && node.type !== "root") return;
    if (node.type === "element" && node.tagName === "img") images.push({ src: String(node.properties.src ?? ""), alt: String(node.properties.alt ?? "") });
    node.children.forEach(walk);
  };
  walk(noteMarkdownTree(content));
  return images;
}

/**
 * 站内地址（`/api/uploads/...`）在渲染层画不出来：origin 是 `astella-app://`，
 * 相对路径会落到应用包内。所以和块级图片走同一条路——带会话令牌取字节，换成 blob。
 */
export function InlineImage({
  src,
  alt,
  workspaceEpoch,
  galleryIndex,
  onOpenGallery,
  linked = false,
}: {
  readonly src: string;
  readonly alt: string;
  readonly workspaceEpoch?: number;
  /** 这一张在整篇图片画廊里的序号；不传就是这一篇没有画廊，点了只放大这一张。 */
  readonly galleryIndex?: number;
  readonly onOpenGallery?: (index: number) => void;
  /** A linked badge follows its destination instead of opening the image viewer. */
  readonly linked?: boolean;
}) {
  const { state, retry } = useSourceImage(src, workspaceEpoch);
  if (state.status === "loading") return <span className="small" data-note-decoration="true">正在载入图片…</span>;
  if (state.status === "unavailable") return <span className="small" data-note-decoration="true">{src && !/^(?:[a-z][a-z\d+.-]*:|\/api\/uploads\/)/i.test(src) ? `缺少图片附件：${alt || src}（原文使用相对路径）` : `这张图片没能取回：${alt || src}`}</span>;
  if (linked) return <img src={state.src} alt={alt} loading="lazy" />;
  if (galleryIndex === undefined || !onOpenGallery) {
    return <ZoomableReadingImage src={state.src} alt={alt} retryable={state.status === "ready"} onRetry={retry} />;
  }
  return (
    <ZoomableReadingImage
      src={state.src}
      alt={alt}
      retryable={state.status === "ready"}
      onRetry={retry}
      // 开关交给整篇画廊接管：受控时组件自己不再叠一层灯箱。
      open={false}
      onOpenChange={(open) => { if (open) onOpenGallery(galleryIndex); }}
    />
  );
}

function wrapKind(kind: NoteInlineAtom["kind"], nodes: ReactNode, key: string): ReactNode {
  if (kind === "strong") return <strong key={key}>{nodes}</strong>;
  if (kind === "em") return <em key={key}>{nodes}</em>;
  if (kind === "strike") return <del key={key}>{nodes}</del>;
  if (kind === "code") return <code key={key}>{nodes}</code>;
  return nodes;
}

/** 一块正文里"整段就是一条分隔线"的写法（编辑器画成 `<hr>`，读侧不能露出三个减号）。 */
const HORIZONTAL_RULE = /^(?:\*{3,}|-{3,}|_{3,})$/;

export function isHorizontalRule(text: string): boolean {
  return HORIZONTAL_RULE.test(text.trim());
}

/**
 * 一块正文 → 按行分组的 React 节点。
 *
 * `mark` 是「概念句」高亮的字符区间，切在显示文本的坐标上（见 `noteInlineDisplayText`）。
 * `galleryStart` 是这一块第一张行内图片在整篇画廊里的序号；不传即这一篇没有画廊。
 * `lineClass` 给每一行套一个 `<span>`（列表项要逐行带记号），此时不再插 `<br>`。
 */
export type NoteInlineRenderOptions = {
    readonly mark?: readonly [number, number] | null;
    readonly workspaceEpoch?: number;
    readonly galleryStart?: number;
    readonly onOpenGallery?: (index: number) => void;
    readonly lineClass?: string;
    readonly annotations?: readonly NoteAnnotationV1[];
    readonly openAnnotationId?: string | null;
    readonly block?: { readonly ordinal: number; readonly type: string; readonly content: string };
    readonly onOpenAnnotation?: (annotation: NoteAnnotationV1) => void;
    /**
     * 记号浮层里那一格「删掉这条」（用户裁决：正文里就能删，不必先开附页）。
     * 是 `ReactNode` 而不是回调——确认状态留在页面那一份，见 `useAnnotationDeleteConfirm`。
     */
    readonly onDeleteAnnotation?: (annotation: NoteAnnotationV1) => ReactNode;
    readonly textOffset?: number;
    readonly companionExplanations?: readonly NoteCompanionExplanation[];
};

function explanationRanges(options: NoteInlineRenderOptions) {
  return (options.companionExplanations ?? []).flatMap(item => {
    const range = options.block ? noteAnchorBlockRangeV1(options.block, item.target.anchor) : null;
    return range ? [{ item, range }] : [];
  });
}

function annotationRanges(options: NoteInlineRenderOptions) {
  return (options.annotations ?? []).flatMap((annotation, index) => {
    const range = options.block ? noteAnchorBlockRangeV1(options.block, annotation.anchor)
      : [annotation.anchor.startOffset, annotation.anchor.endOffset] as const;
    return range ? [{ annotation, range, number: index + 1,
      endsHere: !options.block || options.block.ordinal === annotation.anchor.endBlockOrdinal }] : [];
  });
}

/** Code preserves its literal characters, using the same saved annotation ranges. */
export function renderNotePlainText(content: string, options: NoteInlineRenderOptions = {}): ReactNode {
  const offset = options.textOffset ?? 0;
  return renderTextAtom({ kind: "text", text: content, start: offset, end: offset + content.length },
    "plain", options.mark ?? null, options.mark ?? [0, 0], annotationRanges(options), options.onOpenAnnotation, options.openAnnotationId, explanationRanges(options), options.onDeleteAnnotation);
}

export function renderNoteInline(
  content: string,
  options: NoteInlineRenderOptions = {},
): ReactNode[] {
  const offset = options.textOffset ?? 0;
  const atoms = noteInlineAtoms(content).map(atom => ({ ...atom, start: atom.start + offset, end: atom.end + offset }));
  const mark = options.mark ?? null;
  const [from, to] = mark ?? [0, 0];
  const annotations = annotationRanges(options);
  let imageSeen = 0;
  const lines: ReactNode[][] = [[]];
  atoms.forEach((atom, index) => {
    const key = `${atom.kind}-${index}`;
    if (atom.kind === "break") {
      lines.push([]);
      return;
    }
    let node: ReactNode;
    if (atom.kind === "image") {
      const galleryIndex = options.galleryStart === undefined ? undefined : options.galleryStart + imageSeen;
      imageSeen += 1;
      node = (
        <InlineImage
          key={key}
          src={atom.src}
          alt={atom.alt}
          workspaceEpoch={options.workspaceEpoch}
          galleryIndex={galleryIndex}
          onOpenGallery={options.onOpenGallery}
        />
      );
    } else if (atom.kind === "math") {
      const anchored = annotations.find(item => item.range[0] < atom.end && item.range[1] > atom.start);
      const formula = <ReadableMath source={atom.text} value={atom.value} display={atom.display} />;
      const badges = annotations.filter(item => item.endsHere && item.range[1] > atom.start && item.range[1] <= atom.end);
      node = <span key={key}>{anchored ? <NoteAnnotationMark annotation={anchored.annotation}
        open={anchored.annotation.annotationId === options.openAnnotationId} onOpen={options.onOpenAnnotation}>{formula}</NoteAnnotationMark> : formula}
        {badges.length ? <span className="note-annotation-badges" aria-label="原句的批注角标">{badges.map(item => <NoteAnnotationMark key={item.annotation.annotationId}
          annotation={item.annotation} number={item.number} badge open={item.annotation.annotationId === options.openAnnotationId}
          onOpen={options.onOpenAnnotation} onDelete={options.onDeleteAnnotation?.(item.annotation)}>{null}</NoteAnnotationMark>)}</span> : null}
      </span>;
    } else {
      node = renderTextAtom(atom, key, mark, [from, to], annotations, options.onOpenAnnotation, options.openAnnotationId, explanationRanges(options), options.onDeleteAnnotation);
    }
    lines[lines.length - 1]?.push(node);
  });
  if (options.lineClass) {
    const sourceLines = noteInlineDisplayText(content).split("\n");
    return lines.map((nodes, index) => <span className={options.lineClass} data-list-prefixed={/^\s*(?:[-*+]|\d+[.)])\s/.test(sourceLines[index] ?? "") || undefined} key={`line-${index}`}>{nodes}</span>);
  }
  return lines.flatMap((nodes, index) => (index === 0 ? nodes : [<br key={`break-${index}`} />, ...nodes]));
}

function renderTextAtom(
  atom: Exclude<Extract<NoteInlineAtom, { text: string }>, { kind: "math" }>,
  key: string,
  mark: readonly [number, number] | null,
  [from, to]: readonly [number, number],
  annotations: readonly { readonly annotation: NoteAnnotationV1; readonly range: readonly [number, number]; readonly number: number; readonly endsHere: boolean }[] = [],
  onOpenAnnotation?: (annotation: NoteAnnotationV1) => void,
  openAnnotationId?: string | null,
  explanations: readonly { readonly item: NoteCompanionExplanation; readonly range: readonly [number, number] }[] = [],
  // 第十个位置参数。**不要再加了**：这个函数已经十个位置参数，下一个就该收成
  // 一个 options 对象（`mark` / `annotations` / `explanations` 三样已经是一组）。
  onDeleteAnnotation?: (annotation: NoteAnnotationV1) => ReactNode,
): ReactNode {
  const cut = (start: number, end: number) => atom.text.slice(start - atom.start, end - atom.start);
  const overlapFrom = Math.max(atom.start, from);
  const overlapTo = Math.min(atom.end, to);
  const marked = mark !== null && overlapFrom < overlapTo;
  let nodes: ReactNode = atom.text;
  if (marked) {
    const parts: ReactNode[] = [];
    if (overlapFrom > atom.start) parts.push(cut(atom.start, overlapFrom));
    parts.push(<span className="mark" key="mark">{cut(overlapFrom, overlapTo)}</span>);
    if (overlapTo < atom.end) parts.push(cut(overlapTo, atom.end));
    nodes = parts;
  }
  if ([...annotations, ...explanations].some(item => item.range[0] < atom.end && item.range[1] > atom.start)) {
    const cuts = [...new Set([atom.start, atom.end, ...annotations.flatMap(item => item.range), ...explanations.flatMap(item => item.range), ...(mark ? mark : [])])]
      .filter(offset => offset >= atom.start && offset <= atom.end).sort((a, b) => a - b);
    nodes = cuts.slice(0, -1).map((start, index) => {
      const end = cuts[index + 1]!;
      const anchored = annotations.find(item => item.range[0] <= start && item.range[1] >= end);
      const annotation = anchored?.annotation;
      const text = cut(start, end);
      const explanation = explanations.find(item => item.range[0] <= start && item.range[1] >= end)?.item;
      const content = !annotation ? <span className={mark && start >= from && end <= to ? "mark" : undefined}>{text}</span>
        : <NoteAnnotationMark annotation={annotation}
        open={annotation.annotationId === openAnnotationId}
        onOpen={onOpenAnnotation}
        // 只有这段末尾（`endsHere`）挂删除入口：跨块的锚会在每一段都出现一枚 ✕，
        // 删的是**同一条**批注——按一次删对，另一枚留在原地会让「删干净了吗」没法答。
        onDelete={onDeleteAnnotation && anchored!.endsHere ? onDeleteAnnotation(annotation) : undefined}
        >{text}</NoteAnnotationMark>;
      const badges = annotations.filter(item => item.endsHere && item.range[1] === end);
      return <span key={start}><span className={explanation ? "note-explanation-anchor" : undefined} data-phase={explanation?.phase}>{content}</span>
        {badges.length ? <span className="note-annotation-badges" aria-label="原句的批注角标">{badges.map(item => <NoteAnnotationMark key={item.annotation.annotationId}
          annotation={item.annotation} number={item.number} badge open={item.annotation.annotationId === openAnnotationId}
          onOpen={onOpenAnnotation} onDelete={onDeleteAnnotation?.(item.annotation)}>{null}</NoteAnnotationMark>)}</span> : null}
      </span>;
    });
  }
  if (atom.kind === "link") {
    /**
     * 只把 http(s) 画成能点的：`javascript:`、`data:` 这类不解析成结构，照原文留成
     * 文本。窗口本身永远不导航出去（主进程 `will-navigate` 拦外链），所以"画成能点"
     * 与"真能打开"用的是合同里同一份 `isWebLinkUrl`，不会两套口径。
     */
    if (!isWebLinkUrl(atom.href)) return wrapKind("text", `[${atom.text}](${atom.href})`, key);
    return (
      <a
        key={key}
        href={atom.href}
        onClick={(event) => {
          event.preventDefault();
          void openExternalLink(atom.href);
        }}
      >
        {nodes}
      </a>
    );
  }
  return wrapKind(atom.kind, nodes, key);
}
