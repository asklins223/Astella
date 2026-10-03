import { useEffect, useRef, useState, type RefObject } from "react";
import { ChangeSet, Compartment, EditorState, StateEffect, StateField, Text, type Range } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { noteSourceOffset, noteSourcePosition, noteSourceBlocks } from "./note-source-structure";
import { placementsByBlock, type AnnotationPlacement } from "./note-annotation-placement";
import type { NoteDocumentPosition } from "./note-source-bridge";

export type NoteSourceEditorHandle = {
  readonly insertText: (text: string) => void;
  readonly surround: (before: string, after?: string) => void;
  readonly getPosition: () => NoteDocumentPosition;
  readonly focusPosition: (position: NoteDocumentPosition) => void;
  readonly isComposing: () => boolean;
};

/** A retained code view of the live document. Undo remains in the document, not CodeMirror. */
export function NoteSourceEditor(props: {
  readonly editor: NoteMarkdownEditorHandle;
  readonly handleRef: RefObject<NoteSourceEditorHandle | null>;
  readonly disabled: boolean;
  readonly onChange: (source: string) => void;
  readonly onImagePaste?: (file: File) => void;
  /**
   * 纯编辑态的批注记号（41 §1.4）。
   *
   * **只在行边画**，不往正文里插任何装饰标记：这份源码就是这篇笔记的正文，
   * 往里写 `<!-- -->` 之类的东西等于把装饰混进 Markdown。点那一行仍打开同一张旁页。
   */
  readonly annotationPlacements?: readonly AnnotationPlacement[];
  readonly onOpenAnnotation?: (annotationId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const gutter = useRef(new Compartment());
  const latest = useRef(props);
  latest.current = props;
  const [numbered, setNumbered] = useState(true);
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
      extensions: [markdown(), syntaxHighlighting(defaultHighlightStyle), bracketMatching(), drawSelection(),
        search({ top: true }), EditorView.lineWrapping,
        EditorState.phrases.of({
          Find: "查找", Replace: "替换", next: "下一处", previous: "上一处", all: "选择全部",
          "match case": "区分大小写", regexp: "正则表达式", "by word": "完整词语",
          replace: "替换", "replace all": "全部替换", close: "关闭查找",
          "Go to line": "跳到行", go: "跳转", "No matches": "没有找到匹配内容",
        }),
        EditorView.contentAttributes.of({ "aria-label": "笔记 Markdown 源码", "aria-multiline": "true" }),
        readOnly.current.of(EditorState.readOnly.of(props.disabled)), gutter.current.of(lineNumbers()),
        annotationPlacementsField,
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
            if (latest.current.disabled) return false;
            const files = Array.from(event.clipboardData?.items ?? []);
            if (!files.length || files.some((item) => !item.type.startsWith("image/"))) return false;
            for (const item of files) { const file = item.getAsFile(); if (file) latest.current.onImagePaste?.(file); }
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !fromDocument) write(update.state.doc.toString(), update.startState.doc.toString(), update.changes);
        }),
      ],
    }) });
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
      surround: (before, after = "") => {
        const range = view.state.selection.main;
        const selected = view.state.sliceDoc(range.from, range.to);
        insertText(`${before}${selected}${after}`);
      },
      getPosition: () => noteSourcePosition(view.state.doc.toString(), view.state.selection.main.head),
      focusPosition: (position) => {
        const at = noteSourceOffset(view.state.doc.toString(), position);
        view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start" }) });
        view.focus();
      },
      isComposing: () => view.compositionStarted,
    };
    return () => { unsubscribe(); props.handleRef.current = null; viewRef.current = null; view.destroy(); };
  }, [props.editor, props.handleRef]);

  useEffect(() => { viewRef.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(props.disabled)) }); }, [props.disabled]);
  useEffect(() => { viewRef.current?.dispatch({ effects: gutter.current.reconfigure(numbered ? lineNumbers() : []) }); }, [numbered]);
  // 批注集合进 StateField；装饰依赖集合和 doc，两者变化都会重算位置。
  const placements = props.annotationPlacements;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setAnnotationPlacements.of(placements ?? []) });
  }, [placements]);

  return <div className="note-source-editor">
    <div className="note-source-editor__tools">
      <button type="button" className="text-action" aria-pressed={numbered} onClick={() => setNumbered((value) => !value)}>行号</button>
      <button type="button" className="text-action" onClick={() => { if (viewRef.current) openSearchPanel(viewRef.current); }}>查找 / 替换</button>
    </div>
    <div className="note-source-editor__input" ref={root} />
    {error ? <p className="small" role="alert">{error}</p> : null}
  </div>;
}

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
