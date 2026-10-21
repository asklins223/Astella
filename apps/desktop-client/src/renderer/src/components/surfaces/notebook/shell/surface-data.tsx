import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesktopSourceListItem } from "@astella/shared/desktop-surface-contracts";
import type { NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import { gatewayErrorMessage } from "../../../../app/client/desktop-client";
import { readAuthenticatedSession } from "../../../../app/home/surface-session";
import {
  noteBlockMarkdown,
  noteFootnoteBody,
  noteImageHtmlAttrs,
  noteMarkdownTree,
  type NoteMarkdownNode,
  type NoteMarkdownTree,
} from "@astella/shared/note-markdown";

export { readAuthenticatedSession };

/**
 * Every business page reads one workspace projection and then renders real
 * records. The hook keeps that single request shape in one place: a workspace
 * epoch cursor, a loading flag, and a failure message that never invents data.
 */
export type SurfaceProjectionOptions = {
  /**
   * Re-read when the window regains focus or the app becomes visible again.
   *
   * Off by default because a page that owns an editing session must not have its
   * records swapped underneath it. Pages that only *describe* the workspace —
   * the today route, the ledgers — opt in, so a reader who leaves the app open
   * all day is not served the morning's snapshot all evening.
   */
  readonly refreshOnFocus?: boolean;
};

export function useSurfaceProjection<T>(
  read: (context: { readonly workspaceEpoch: number }) => Promise<T>,
  deps: readonly unknown[] = [],
  options: SurfaceProjectionOptions = {},
) {
  const epochRef = useRef<number | undefined>(undefined);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const loadedRef = useRef<T | null>(null);
  const requestRef = useRef(0);
  const refreshOnFocus = options.refreshOnFocus === true;

  const load = useCallback(async ({ silent = false }: { readonly silent?: boolean } = {}) => {
    const request = ++requestRef.current;
    const preservesExistingData = silent && loadedRef.current !== null;
    // A page keeps the records it already has while a refresh runs. Only the
    // first read of a target owns the loading paper — otherwise every autosave
    // receipt would blank the page it had just written to.
    if (preservesExistingData) {
      setRefreshing(true);
      setRefreshFailure(null);
    } else {
      setLoading(true);
      setFailure(null);
    }
    try {
      const session = await readAuthenticatedSession(epochRef);
      const next = await read({ workspaceEpoch: session.workspaceEpoch });
      // Focus and visibility can fire together. Only the newest request may
      // replace the paper, otherwise a slower stale response can win the race.
      if (request !== requestRef.current) return;
      loadedRef.current = next;
      setData(next);
    } catch (error) {
      if (request !== requestRef.current) return;
      // A silent re-read never reports failure over records that are already on
      // the paper. It does expose a small non-blocking status so a manual
      // “刷新” never looks as though the click was ignored.
      const message = gatewayErrorMessage(error);
      if (preservesExistingData) setRefreshFailure(message);
      else setFailure(message);
    } finally {
      if (request !== requestRef.current) return;
      // Focus can replace an explicit reload with a silent request. That
      // newest request owns both flags, including the older request's loading
      // flag; otherwise successful data can leave the page disabled forever.
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    // A new target (another note, another source) is a first read again.
    loadedRef.current = null;
    setRefreshFailure(null);
    void load();
    return () => { requestRef.current += 1; };
  }, [load]);

  useEffect(() => {
    if (!refreshOnFocus) return undefined;
    const reread = () => {
      // `visibilitychange` fires on the way *into* the background too; only a
      // page that is actually being looked at again is worth re-reading.
      if (document.visibilityState === "hidden") return;
      void load({ silent: true });
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [refreshOnFocus, load]);

  return { data, loading, failure, refreshing, refreshFailure, reload: load, epochRef };
}

/**
 * 一个跟着日历走的"现在"。页面里的「今天 / 昨天 / 已超过 N 天」都从这里取锚点，
 * 所以整夜开着的窗口会自己跨过午夜，而不是把昨天一直叫成今天。重锚是纯本地的
 * ——记录没变，变的只是数日子的那条线——所以它不需要任何服务端读取，也不该
 * 依赖某次刷新成功。
 */
export function useDayAnchor(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const reanchor = () => {
      if (document.visibilityState === "hidden") return;
      setNowMs(Date.now());
    };
    let timer = 0;
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = window.setTimeout(() => {
        setNowMs(Date.now());
        scheduleMidnight();
      }, Math.max(1_000, next.valueOf() - now.valueOf()));
    };
    scheduleMidnight();
    window.addEventListener("focus", reanchor);
    document.addEventListener("visibilitychange", reanchor);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", reanchor);
      document.removeEventListener("visibilitychange", reanchor);
    };
  }, []);
  return nowMs;
}

/** Paper-shaped loading / empty / failure state shared by every page body. */
export function SurfaceDataState({
  kind,
  message,
  detail,
  onRetry,
  action,
}: {
  readonly kind: "loading" | "error" | "empty";
  readonly message: string;
  readonly detail: string;
  readonly onRetry?: () => void;
  /** What the reader can do from an empty page, e.g. start the first note. */
  readonly action?: ReactNode;
}) {
  return (
    <section
      className={`pinboard surface-data-state surface-data-state--${kind}`}
      role={kind === "error" ? "alert" : "status"}
      style={{ display: "grid", placeContent: "center", justifyItems: "center", gap: 9, textAlign: "center" }}
    >
      {kind === "loading" ? <LoaderCircle size={26} aria-hidden="true" className="surface-data-state__spin" /> : null}
      {kind === "error" ? <CircleAlert size={26} aria-hidden="true" /> : null}
      {kind === "empty" ? <FolderOpen size={26} aria-hidden="true" /> : null}
      <strong className="title">{message}</strong>
      <p className="sub" style={{ maxWidth: "46ch" }}>{detail}</p>
      {kind === "error" && onRetry ? (
        <button type="button" className="button primary" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />重新读取
        </button>
      ) : null}
      {action}
    </section>
  );
}

/**
 * 构造 `Intl.DateTimeFormat` 是纯 JS 里最贵的一批调用之一，而下面这两个函数都是**按行**
 * 调的（来源库一次最多铺 500+ 行，每次渲染逐行各建一个）。formatter 本身无状态、可安全
 * 复用，所以提到模块作用域只建一次（0269 轮 M23）。
 */
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function formatDate(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return MONTH_DAY_FORMAT.format(parsed);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  const now = new Date();
  const minutes = Math.round((now.valueOf() - parsed.valueOf()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && isSameCalendarDay(parsed, now)) return `${hours} 小时前`;
  const dayGap = calendarDayGap(parsed, now);
  if (dayGap === 1) return "昨天";
  if (dayGap === 2) return "前天";
  return formatDate(value);
}

/** Midnight-anchored day difference, so "昨天" never depends on the clock time. */
function calendarDayGap(from: Date, to: Date): number {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).valueOf();
  return Math.round((start(to) - start(from)) / 86_400_000);
}

/**
 * Whole calendar days between a stamp and today, or null when it is unreadable.
 * A page that filters by day has to use this and not a rolling 24 hours: a note
 * saved at 23:00 yesterday is "昨天" on its own row, so it must not also be
 * counted under "今天".
 */
export function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return null;
  return calendarDayGap(parsed, new Date());
}

/**
 * The absolute stamp an index row's right column carries, where the row's own
 * detail line already reads the relative one. Printing "4 小时前" twice in the
 * same row was the mockup's one visible slip — and it was still happening for
 * every row older than today, where "昨天" and "9月13日" came out of both
 * columns identically. The clock time is what keeps the two columns distinct
 * and is the half the relative line never carries.
 */
export function formatSourceStamp(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  const clock = CLOCK_FORMAT.format(parsed);
  const dayGap = calendarDayGap(parsed, new Date());
  if (dayGap === 0) return `今天 ${clock}`;
  if (dayGap === 1) return `昨天 ${clock}`;
  if (dayGap === 2) return `前天 ${clock}`;
  return `${formatDate(value)} ${clock}`;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return calendarDayGap(a, b) === 0;
}

/**
 * Parses an image block's stored markdown (`![alt](url)`) into its parts, so a
 * reading surface can render the picture instead of the markup. Returns null
 * for content that is not a well-formed single markdown image.
 *
 * 它和 `noteBlockText` 住在一起：两个都是"一版里存的东西怎么变成给人看的东西"，
 * 而笔记库的封面缩略图与正文图片必须共用同一个解析规则。
 */
export function parseImageBlock(content: string): { readonly alt: string; readonly url: string } | null {
  const html = noteImageHtmlAttrs(content);
  if (html && typeof html.src === "string" && html.src) return { alt: String(html.alt ?? ""), url: html.src };
  const match = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(content.trim());
  if (!match) return null;
  return { alt: match[1] ?? "", url: match[2] ?? "" };
}

/**
 * Note blocks arrive as HTML-ish text. The **reading** surfaces turn their
 * Markdown into elements themselves, so this only flattens the inline HTML
 * wrapper (`<br>`, entities) that a block may carry. Previews must use
 * `noteBlockPlainText` below instead: block content is stored as Markdown, and
 * flattening HTML alone used to print `# heading` / `- item` verbatim.
 */
export function noteBlockText(value: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(value)) return value;
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(?:h[1-6]|p|strong|em|ul|ol|li|blockquote|code|pre)\b[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/**
 * The text a reader actually sees for one block: Markdown syntax removed, runs
 * of whitespace collapsed. Heading markers, list bullets/numbering, emphasis,
 * backticks, link destinations and image syntax leave no characters, while the
 * words they wrap stay. The block is parsed through the same Markdown wrapper
 * the reading view uses for it (`noteBlockMarkdown`), so a heading/list/quote
 * block whose content is stored without its Markdown wrapper still works.
 */
export function noteBlockPlainText(block: Pick<NoteBlockProjectionV1, "type" | "content">): string {
  // 图片块整行存的就是 `![alt](url)`；预览要说的仍是"这一版里有什么"，只留说明文字。
  if (block.type === "image") return parseImageBlock(block.content)?.alt ?? "";
  // A footnote definition is metadata for a reference in prose, not a paragraph:
  // its rendered shell ("脚注", "返回引用") must not leak into a preview.
  if (noteFootnoteBody(block.content)) return "";
  const source = noteBlockMarkdown(block.type, block.content);
  return noteBlockText(markdownPlainText(noteMarkdownTree(source))).replace(/\s+/g, " ").trim();
}

/** Block-level elements separate two runs of displayed prose. */
const PLAIN_TEXT_BLOCK_TAGS: Record<string, true> = {
  p: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
  li: true, blockquote: true, pre: true, ul: true, ol: true,
  table: true, thead: true, tbody: true, tr: true, td: true, th: true,
  div: true, section: true, aside: true, header: true, footer: true,
};

/** Text nodes of a rendered Markdown tree, with block-level separators kept. */
function markdownPlainText(node: NoteMarkdownTree | NoteMarkdownNode): string {
  if (node.type === "text") return node.value;
  if (node.type === "root") return node.children.map(markdownPlainText).join("");
  if (node.type !== "element") return "";
  // An image is an atom; its description is the only readable part.
  if (node.tagName === "img") return String(node.properties.alt ?? "");
  // `<br>` separates two visible lines: without a space English words would fuse.
  if (node.tagName === "br") return " ";
  // A checkbox in a task list has no text of its own; the label follows it.
  if (node.tagName === "input") return "";
  // `[toc]` renders as a nav of heading links: an index, not prose. A shelf
  // preview must not repeat the whole outline.
  if (node.tagName === "nav" && node.properties.dataNoteToc !== undefined) return "";
  // A footnote reference is a superscript number; the sentence itself reads cleaner without it.
  if (node.tagName === "sup" && node.children.some((child) =>
    child.type === "element" && child.tagName === "a" && child.properties.dataFootnoteRef !== undefined)) return "";
  const content = node.children.map(markdownPlainText).join("");
  // Two list items (or two paragraphs inside one stored block) are two runs of
  // prose; joining their text directly would fuse them into one word.
  return PLAIN_TEXT_BLOCK_TAGS[node.tagName] ? ` ${content} ` : content;
}

export type NoteProseOptions = {
  /**
   * The title printed by the surface that shows the prose (a shelf card heading,
   * the reading page header). AI-generated notes start with a `# <title>`
   * heading; that leading copy is dropped from the prose because the title is
   * already on screen. Stored blocks and their ordinals are never changed.
   */
  readonly title?: string | null;
};

/**
 * The first block when it is a heading repeating the note title, else null.
 * Both the shelf card and the reading page print the title above the body, so
 * keeping the body-level copy would show the same title twice.
 */
export function noteLeadingTitleBlock(
  blocks: readonly NoteBlockProjectionV1[],
  title: string | null | undefined,
): NoteBlockProjectionV1 | null {
  const first = blocks[0];
  const expected = title?.replace(/\s+/g, " ").trim();
  if (!first || !expected || first.type !== "heading") return null;
  return noteBlockPlainText(first) === expected ? first : null;
}

function blocksWithoutLeadingTitle(
  blocks: readonly NoteBlockProjectionV1[],
  title: string | null | undefined,
): readonly NoteBlockProjectionV1[] {
  return noteLeadingTitleBlock(blocks, title) ? blocks.slice(1) : blocks;
}

/** The whole version as one line of prose, with runs of whitespace collapsed. */
export function noteBodyText(
  blocks: readonly NoteBlockProjectionV1[],
  options: NoteProseOptions = {},
): string {
  return blocksWithoutLeadingTitle(blocks, options.title)
    .map(noteBlockPlainText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 这一版里有几段"有正文"的段落（审计 F35）。
 *
 * 与 `noteBodyText` **同一口径**：图片块算它有说明文字的那部分（没有说明就不算），
 * 空段落（编辑器光标的落点）不算正文。列表卡以前直接数 `blocks.length`，于是同一张卡上
 * 会同时写"1 段正文"和"这一版还没有正文段落"——两句话互否，而读者只能信一句。
 */
export function noteParagraphCount(
  blocks: readonly NoteBlockProjectionV1[],
  options: NoteProseOptions = {},
): number {
  return blocksWithoutLeadingTitle(blocks, options.title)
    .filter((block) => noteBlockPlainText(block).length > 0).length;
}

/**
 * One status, one word. "待解析" used to mean the tab that filters *failed*
 * material while the strip used "待处理" for failed + running and "需处理" for the
 * tab — three near-synonyms for two different things.
 */
export function formatSourceStatus(status: DesktopSourceListItem["status"]): string {
  switch (status) {
    case "ready": return "已就绪";
    case "processing": return "解析中";
    case "failed": return "解析失败";
    case "archived": return "已归档";
    case "draft": return "待解析";
    default: return status;
  }
}

export function sourceStatusTone(status: DesktopSourceListItem["status"]): string {
  switch (status) {
    case "ready": return "green";
    case "failed": return "red";
    // 归档 and 待解析 stay on the paper's own tag tone: the Warm-First Rule keeps
    // blue for the companion and the star map, not for a status chip.
    default: return "";
  }
}

export function formatSourceKind(item: Pick<DesktopSourceListItem, "type">): string {
  switch (item.type) {
    case "url": return "WEB";
    case "markdown": return "MD";
    case "code": return "CODE";
    default: return "TXT";
  }
}

/** Spoken form of the same kind, used in an index card's detail line. */
export function formatSourceKindLabel(item: Pick<DesktopSourceListItem, "type">): string {
  switch (item.type) {
    case "url": return "网页";
    case "markdown": return "Markdown";
    case "code": return "代码";
    default: return "文本";
  }
}
