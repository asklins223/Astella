import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChangeSet, Compartment, EditorState, StateEffect, StateField, Text, type Range } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { useNotebookFullscreenActive } from "./notebook-fullscreen-state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { notifyNoteEditorFormat, type NoteEditorFormat } from "./note-editor-format";
import { tags } from "@lezer/highlight";
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { Code2, Hash, Search, WrapText } from "lucide-react";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { noteSourceOffset, noteSourcePosition, noteSourceBlocks } from "./note-source-structure";
import { placementsByBlock, type AnnotationPlacement } from "./note-annotation-placement";
import type { NoteDocumentPosition } from "./note-source-bridge";
import type { NoteAiRange } from "../../companion/note-companion-editing";
import { changesTouchLockedRange } from "./note-ai-lock";
import { noteImageMarkdown, noteMarkdownSyntax, noteRichStyleCss, cleanNoteRichStyle, richStyleFromCss, noteStyledMdastHtml, type NoteRichStyle } from "@astella/shared/note-markdown";

export type NoteSourceEditorHandle = {
  readonly insertText: (text: string) => void;
  readonly insertImageMarkdown: (text: string) => void;
  readonly surround: (before: string, after?: string, emptyText?: string) => void;
  readonly toggleLinePrefix: (prefix: string, existing: RegExp) => void;
  readonly getPosition: () => NoteDocumentPosition;
  readonly focusPosition: (position: NoteDocumentPosition) => void;
  readonly isComposing: () => boolean;
  readonly focus: () => void;
  readonly openSearch: () => void;
  readonly getFormatState: () => NoteEditorFormat;
  readonly getSelectedMarkdown: () => string;
  readonly setTextStyle: (style: NoteRichStyle) => void;
  readonly setParagraphStyle: (style: NoteRichStyle) => void;
};

/** A retained code view of the live document. Undo remains in the document, not CodeMirror. */
export function NoteSourceEditor(props: {
  readonly editor: NoteMarkdownEditorHandle;
  readonly handleRef: RefObject<NoteSourceEditorHandle | null>;
  readonly disabled: boolean;
  readonly onChange: (source: string) => void;
  readonly onImagePaste?: (file: File) => void;
  readonly onImagesPaste?: (files: readonly File[]) => void;
  /**
   * 纯编辑态的批注记号（41 §1.4）。
   *
   * **只在行边画**，不往正文里插任何装饰标记：这份源码就是这篇笔记的正文，
   * 往里写 `<!-- -->` 之类的东西等于把装饰混进 Markdown。点那一行仍打开同一张旁页。
   */
  readonly annotationPlacements?: readonly AnnotationPlacement[];
  readonly aiRanges?: readonly NoteAiRange[];
  readonly onOpenAnnotation?: (annotationId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const fullscreen = useNotebookFullscreenActive();
  useLayoutEffect(() => { if (settingsRef.current) settingsRef.current.open = !fullscreen; }, [fullscreen]);
  const viewRef = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const gutter = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;
  const [numbered, setNumbered] = useState(true);
  const [wrapped, setWrapped] = useState(true);
  const [position, setPosition] = useState({ line: 1, column: 1, lines: 1, selected: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!root.current) return;
    let fromDocument = false;
    let fromSource = false;
    const write = (source: string, before: string, changes: ChangeSet) => {
      if (latest.current.disabled) return;
      const documentSource = latest.current.editor.getMarkdown() ?? before;
      // A peer may have updated the document during IME composition. Map this input
      // over that change instead of parsing a stale snapshot over the peer's text.
      if (before !== documentSource) {
        const remote = ChangeSet.of(sourceDifference(before, documentSource), before.length);
        source = changes.map(remote).apply(Text.of(documentSource.split("\n"))).toString();
      }
      fromSource = true;
      const applied = latest.current.editor.applySource(source);
      fromSource = false;
      if (applied) {
        setError(null);
        latest.current.onChange(source);
      } else setError("这处语法暂时无法同步，源码仍在这里。请保留纯编辑并核对这一处。");
    };
    const view = new EditorView({ parent: root.current, state: EditorState.create({
      doc: props.editor.getMarkdown() ?? "",
      extensions: [markdown(), syntaxHighlighting(sourceHighlightStyle), bracketMatching(), drawSelection(),
        highlightActiveLine(), highlightActiveLineGutter(), highlightSelectionMatches(),
        search({ top: true }), wrapping.current.of(EditorView.lineWrapping),
        EditorState.phrases.of({
          Find: "查找", Replace: "替换", next: "下一处", previous: "上一处", all: "选择全部",
          "match case": "区分大小写", regexp: "正则表达式", "by word": "完整词语",
          replace: "替换", "replace all": "全部替换", close: "关闭查找",
          "Go to line": "跳到行", go: "跳转", "No matches": "没有找到匹配内容",
        }),
        EditorView.contentAttributes.of({ "aria-label": "笔记 Markdown 源码", "aria-multiline": "true" }),
        readOnly.current.of(EditorState.readOnly.of(props.disabled)), gutter.current.of(lineNumbers()),
        annotationPlacementsField,
        EditorState.transactionFilter.of(tr => {
          if (!tr.docChanged || fromDocument) return tr;
          const blocks = noteSourceBlocks(tr.startState.doc.toString());
          let blocked = false;
          tr.changes.iterChangedRanges((from, to) => {
            for (const range of latest.current.aiRanges ?? []) {
              const first = blocks[range.startBlock], last = blocks[range.endBlock];
              if (first && last && changesTouchLockedRange(from, to, first.from - 1, last.to + 1)) blocked = true;
            }
          });
          return blocked ? [] : tr;
        }),
        EditorView.decorations.compute(["doc", annotationPlacementsField], state => {
          const blocks = noteSourceBlocks(state.doc.toString());
          const decorations: Range<Decoration>[] = [];
          const lines = new Map<number, string>();
          for (const range of latest.current.aiRanges ?? []) for (let ordinal = range.startBlock; ordinal <= range.endBlock; ordinal++) {
            const block = blocks[ordinal]; if (!block) continue;
            const first = state.doc.lineAt(block.from).number, last = state.doc.lineAt(block.to).number;
            for (let line = first; line <= last; line++) lines.set(state.doc.line(line).from, range.label);
          }
          for (const [from, label] of lines) decorations.push(Decoration.line({ attributes: { class: "note-ai-working", "data-ai-label": label, "aria-busy": "true" } }).range(from));
          return Decoration.set(decorations, true);
        }),
        // CM6 在**每次 view update** 时重算这条，所以「用户改源码 → 块下标变 →
        // 记号跟着挪」不需要任何 React 重渲染来驱动。
        EditorView.decorations.compute([annotationPlacementsField, "doc"], (state) =>
          annotationDecorations(state, state.field(annotationPlacementsField, false) ?? [])),
        keymap.of([
          { key: "Mod-z", run: () => { if (latest.current.disabled) return false; latest.current.editor.undo(); sync(); return true; } },
          { key: "Mod-Shift-z", run: () => { if (latest.current.disabled) return false; latest.current.editor.redo(); sync(); return true; } },
          { key: "Mod-y", run: () => { if (latest.current.disabled) return false; latest.current.editor.redo(); sync(); return true; } },
          ...searchKeymap, indentWithTab, ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({
          compositionend: () => { queueMicrotask(sync); },
          click: (event) => {
            // 点那一行的记号 → 打开**同一张**旁页。键盘也走这一条（Enter / Space），
            // 所以装饰带 role/tabindex。
            const id = annotationIdAt(event.target);
            if (!id) return false;
            latest.current.onOpenAnnotation?.(id);
            return true;
          },
          keydown: (event) => {
            if (event.key !== "Enter" && event.key !== " ") return false;
            const id = annotationIdAt(event.target);
            if (!id) return false;
            event.preventDefault();
            latest.current.onOpenAnnotation?.(id);
            return true;
          },
          paste: (event) => {
            if (latest.current.disabled || !latest.current.onImagePaste && !latest.current.onImagesPaste) return false;
            const files = Array.from(event.clipboardData?.items ?? []);
            if (!files.length || files.some((item) => !item.type.startsWith("image/"))) return false;
            const images = files.map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
            if (latest.current.onImagesPaste) latest.current.onImagesPaste(images); else images.forEach(file => latest.current.onImagePaste?.(file));
            return true;
          },
          drop: event => {
            if (latest.current.disabled || !latest.current.onImagePaste && !latest.current.onImagesPaste) return false;
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (!files.length || files.some(file => !file.type.startsWith("image/"))) return false;
            const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (at !== null) view.dispatch({ selection: { anchor: at } });
            if (latest.current.onImagesPaste) latest.current.onImagesPaste(files); else files.forEach(file => latest.current.onImagePaste?.(file));
            event.preventDefault(); event.stopPropagation(); return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !fromDocument) write(update.state.doc.toString(), update.startState.doc.toString(), update.changes);
          if (update.docChanged || update.selectionSet) updatePosition(update.state);
        }),
      ],
    }) });
    function updatePosition(state: EditorState) {
      const selection = state.selection.main;
      const line = state.doc.lineAt(selection.head);
      setPosition({ line: line.number, column: selection.head - line.from + 1, lines: state.doc.lines, selected: selection.to - selection.from });
      notifyNoteEditorFormat(view.dom);
      if (view.hasFocus && root.current?.closest(".notebook-workspace")?.getAttribute("data-typewriter") === "true") queueMicrotask(() => { if (viewRef.current === view && view.state.selection.main.head === selection.head) view.dispatch({ effects: EditorView.scrollIntoView(selection.head, { y: "center" }) }); });
    }
    updatePosition(view.state);
    function sync() {
      // An IME owns its composition until it commits; a remote update must not cut it short.
      if (view.compositionStarted || fromSource) return;
      const next = latest.current.editor.getMarkdown();
      if (next === null || next === view.state.doc.toString()) return;
      fromDocument = true;
      view.dispatch({ changes: sourceDifference(view.state.doc.toString(), next) });
      fromDocument = false;
    }
    const unsubscribe = props.editor.subscribe(sync);
    viewRef.current = view;
    const insertText = (text: string) => {
      if (latest.current.disabled) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    };
    props.handleRef.current = {
      insertText,
      insertImageMarkdown: text => {
        if (latest.current.disabled) return;
        const paragraph = noteMarkdownSyntax(text).children[0];
        const images = paragraph?.type === "paragraph" ? paragraph.children.filter(node => node.type === "image") : [];
        if (images.length < 2) { insertText(text); return; }
        const width = Math.max(64, Math.round(((view.scrollDOM.clientWidth || 640) - 12 * (images.length - 1)) / images.length));
        const row = images.map(image => noteImageMarkdown({ src: image.url, alt: image.alt, title: image.title, width }, true)).join(" ");
        insertText(`\n\n${row}\n\n`);
      },
      surround: (before, after = "", emptyText = "") => {
        if (latest.current.disabled) return;
        const range = view.state.selection.main;
        const selected = view.state.sliceDoc(range.from, range.to) || emptyText;
        const wrapped = after.length > 0 && range.from >= before.length
          && view.state.sliceDoc(range.from - before.length, range.from) === before
          && view.state.sliceDoc(range.to, range.to + after.length) === after;
        if (wrapped) {
          view.dispatch({ changes: [
            { from: range.from - before.length, to: range.from, insert: "" },
            { from: range.to, to: range.to + after.length, insert: "" },
          ], selection: { anchor: range.from - before.length, head: range.to - before.length } });
        } else {
          view.dispatch({ changes: { from: range.from, to: range.to, insert: `${before}${selected}${after}` },
            selection: { anchor: range.from + before.length, head: range.to + before.length } });
        }
        view.focus();
      },
      toggleLinePrefix: (prefix, existing) => {
        if (latest.current.disabled) return;
        const selection = view.state.selection;
        const range = selection.main;
        const first = view.state.doc.lineAt(range.from).number;
        const last = view.state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to).number;
        const lines = Array.from({ length: last - first + 1 }, (_, offset) => view.state.doc.line(first + offset));
        const remove = lines.every(line => line.text.trimStart().startsWith(prefix));
        const changes = ChangeSet.of(lines.map(line => {
          const indent = line.text.length - line.text.trimStart().length;
          const content = line.text.slice(indent);
          const oldPrefix = existing.exec(content)?.[0] ?? "";
          return { from: line.from + indent, to: line.from + indent + oldPrefix.length, insert: remove ? "" : prefix };
        }), view.state.doc.length);
        view.dispatch({ changes, selection: selection.map(changes) });
        view.focus();
      },
      getPosition: () => noteSourcePosition(view.state.doc.toString(), view.state.selection.main.head),
      focusPosition: (position) => {
        const at = noteSourceOffset(view.state.doc.toString(), position);
        view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
        view.focus();
      },
      isComposing: () => view.compositionStarted,
      focus: () => view.focus(),
      openSearch: () => { openSearchPanel(view); },
      getSelectedMarkdown: () => { const range = view.state.selection.main; return range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to); },
      setTextStyle: style => {
        if (latest.current.disabled) return; const range = view.state.selection.main, selected = view.state.sliceDoc(range.from, range.to);
        const content = noteMarkdownSyntax(selected).children.map(node => noteStyledMdastHtml(node)).join("<br>");
        const before = `<span style="${noteRichStyleCss(style)}">`;
        view.dispatch({ changes: { from: range.from, to: range.to, insert: `${before}${content}</span>` }, selection: { anchor: range.from + before.length, head: range.from + before.length + content.length } }); view.focus();
      },
      setParagraphStyle: style => {
        if (latest.current.disabled) return; const range = view.state.selection.main, source = view.state.doc.toString();
        const definitions = noteMarkdownSyntax(source).children.filter(node => node.type === "footnoteDefinition").map(node => source.slice(node.position?.start.offset, node.position?.end.offset)).join("\n\n");
        const blocks = noteSourceBlocks(source).filter(block => block.to >= range.from && block.from <= range.to);
        const changes = blocks.map(block => { const old = source.slice(block.from, block.to), node = noteMarkdownSyntax(`${old}\n\n${definitions}`).children[0]; if (!node || !["paragraph", "heading"].includes(node.type)) return null;
          const current = cleanNoteRichStyle((node.data as { noteStyle?: unknown })?.noteStyle), next = { ...current, ...style, ...(style.indent === undefined ? {} : { indent: Math.max(0, Math.min(8, (current.indent ?? 0) + style.indent)) }) }, tag = node.type === "heading" ? `h${node.depth}` : "p";
          return { from: block.from, to: block.to, insert: `<${tag} style="${noteRichStyleCss(next)}">${noteStyledMdastHtml(node)}</${tag}>` };
        }).filter(change => change !== null); if (!changes.length) return;
        const changeSet = ChangeSet.of(changes, view.state.doc.length); view.dispatch({ changes: changeSet, selection: view.state.selection.map(changeSet) }); view.focus();
      },
      getFormatState: () => {
        const names = new Set<string>();
        let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1);
        while (node) { names.add(node.name); if (!node.parent) break; node = node.parent; }
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(Array.from(names).find(name => name.includes("Heading")) ?? "");
        const history = latest.current.editor.getFormatState?.();
        const head = view.state.selection.main.head, source = view.state.doc.toString(), block = noteSourceBlocks(source).find(block => block.from <= head && block.to >= head), paragraph = block ? noteMarkdownSyntax(source.slice(block.from, block.to)).children[0] : undefined;
        const span = source.slice(block?.from ?? 0, head).match(/<span\s+style="([^"]*)">[^<]*$/);
        return { source: true, textStyle: span ? richStyleFromCss(span[1]) : {}, paragraphStyle: cleanNoteRichStyle((paragraph?.data as { noteStyle?: unknown })?.noteStyle), heading: Number(heading?.[1] ?? 0), strong: names.has("StrongEmphasis"), emphasis: names.has("Emphasis"), inlineCode: names.has("InlineCode"), strike: names.has("Strikethrough"),
          quote: names.has("Blockquote"), bullet: names.has("BulletList"), ordered: names.has("OrderedList"), canUndo: history?.canUndo ?? false, canRedo: history?.canRedo ?? false };
      },
    };
    return () => { unsubscribe(); props.handleRef.current = null; viewRef.current = null; view.destroy(); };
  }, [props.editor, props.handleRef]);

  useEffect(() => { viewRef.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(props.disabled)) }); }, [props.disabled]);
  useEffect(() => { viewRef.current?.dispatch({ effects: gutter.current.reconfigure(numbered ? lineNumbers() : []) }); }, [numbered]);
  useEffect(() => { viewRef.current?.dispatch({ effects: wrapping.current.reconfigure(wrapped ? EditorView.lineWrapping : []) }); }, [wrapped]);
  // 批注集合进 StateField；装饰依赖集合和 doc，两者变化都会重算位置。
  const placements = props.annotationPlacements;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setAnnotationPlacements.of(placements ?? []) });
  }, [placements, props.aiRanges]);

  return <div className="note-source-editor">
    <details className="note-source-editor__settings" ref={settingsRef}>
      <summary>源码设置</summary>
      <div className="note-source-editor__tools">
        <span className="note-source-editor__label"><Code2 size={16} aria-hidden="true" />Markdown<span className="note-source-editor__caret">{position.line} 行 · {position.column} 列</span></span>
        <div className="note-source-editor__actions">
          <button type="button" aria-pressed={numbered} onClick={() => setNumbered((value) => !value)}><Hash size={15} aria-hidden="true" />行号</button>
          <button type="button" aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)}><WrapText size={15} aria-hidden="true" />自动换行</button>
          <button type="button" title="查找 / 替换（⌘F / Ctrl+F）" onClick={() => { if (viewRef.current) openSearchPanel(viewRef.current); }}><Search size={15} aria-hidden="true" />查找 / 替换</button>
        </div>
      </div>
    </details>
    <div className="note-source-editor__input" ref={root} />
    <div className="note-source-editor__status">
      <span>第 {position.line} 行 · 第 {position.column} 列{position.selected ? ` · 已选 ${position.selected.toLocaleString()} 字符` : ""}</span>
      <span>{position.lines.toLocaleString()} 行{props.disabled ? " · 只读" : ""}</span>
    </div>
    {error ? <p className="note-source-editor__error" role="alert">{error}</p> : null}
  </div>;
}

const sourceHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "#3e6b50", fontWeight: "750" },
  { tag: tags.processingInstruction, color: "#9d8061" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "750" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "#4f7897" },
  { tag: tags.monospace, color: "#92583c" },
  { tag: [tags.tagName, tags.typeName, tags.keyword], color: "#76649b" },
  { tag: [tags.attributeName, tags.propertyName], color: "#4f7897" },
  { tag: tags.string, color: "#5b7a47" },
  { tag: [tags.number, tags.bool], color: "#ac7540" },
  { tag: [tags.comment, tags.meta], color: "#8a907d" },
]);

/**
 * 批注落位放在 state 里：它一变就触发一次重算，而它本身不该进 undo 历史。
 *
 * 装饰由 `EditorView.decorations.from(field)` 挂出去（见扩展数组）——CM6 会在
 * **每次 view update** 时重算它，所以「用户改源码 → 块下标变 → 记号跟着挪」
 * 不需要任何 React 重渲染来驱动。
 */
const setAnnotationPlacements = StateEffect.define<readonly AnnotationPlacement[]>();

const annotationPlacementsField: StateField<readonly AnnotationPlacement[]> = StateField.define({
  create: (): readonly AnnotationPlacement[] => [],
  update: (value, tr): readonly AnnotationPlacement[] => {
    for (const effect of tr.effects) if (effect.is(setAnnotationPlacements)) return effect.value;
    return value;
  },
});

/**
 * 块下标 → 源码行边装饰。
 *
 * `noteSourceBlocks` 返回的数组下标**就是**块 ordinal（见 note-annotation-placement.ts
 * 头部那条实测：三个视图共用同一个块下标空间），所以这里直接按下标取。
 *
 * 装饰覆盖**块本身的那段范围**，`Decoration.mark` 不改文档内容——源码里一个字符
 * 都不会多。这一点是 41 §1.4 的硬要求：「不把批注文字或装饰标记写进 Markdown」。
 *
 * 为什么不是 `line.from` 处一个零宽记号：CM6 的 mark 装饰**不许为空区间**
 * （实测 `RangeError: Mark decorations may not be empty`）。而画在行首会压住标题的
 * `#` 与列表的 `-`，让人以为那一行少了语法符号。所以标记跨**整块**，由 CSS 在
 * 行边画那道竖线——既是「侧边记号」，又不碰任何一个字符。
 */
function annotationDecorations(state: EditorState, placements: readonly AnnotationPlacement[]): DecorationSet {
  if (!placements.length) return Decoration.none;
  const source = state.doc.toString();
  const blocks = noteSourceBlocks(source);
  const byBlock = placementsByBlock(placements);
  const decorations: Range<Decoration>[] = [];
  for (const [ordinal, entries] of byBlock) {
    const block = blocks[ordinal];
    if (!block) continue;
    const from = Math.min(block.from, state.doc.length);
    const to = Math.min(block.to, state.doc.length);
    if (from >= to) continue;
    decorations.push(Decoration.mark({
      class: "note-annotation-source",
      attributes: {
        "data-annotation-id": entries[0]!.annotationId,
        "data-annotation-number": String(entries[0]!.number),
        "data-annotation-ids": entries.map((entry) => entry.annotationId).join(" "),
        "aria-label": entries.length > 1 ? `这一段有 ${entries.length} 条批注` : "这一段有批注",
        title: entries.length > 1 ? `${entries.length} 条批注` : "有批注",
        role: "button",
        tabindex: "0",
      },
    }).range(from, to));
  }
  return Decoration.set(decorations, true);
}

/** 从事件目标回溯到那一枚记号（装饰自己不是一个可点元素，得往上找）。 */
function annotationIdAt(target: EventTarget | null): string | null {
  const element = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-annotation-id]") : null;
  return element?.dataset.annotationId ?? null;
}

function sourceDifference(before: string, after: string) {  let start = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end += 1;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}
