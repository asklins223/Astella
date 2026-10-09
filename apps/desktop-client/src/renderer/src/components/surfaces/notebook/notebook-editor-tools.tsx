import { NotebookFormatActions, NotebookFormatControls, NotebookBlockFormat, WritingPopover } from "./notebook-format-controls";
import { NotebookWritingMenu } from "./notebook-writing-menu";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Bold, Code, CodeXml, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Plus, Quote, Redo2, SlidersHorizontal, Table2, Undo2, Strikethrough, type LucideIcon } from "lucide-react";
import { NOTE_FORMAT_EVENT, type NoteEditorFormat } from "./note-editor-format";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";

/**
 * Commands use the active document view and keep its selection when a tool is pressed.
 */
type EditorToolSpec = {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly title: string;
  readonly run: (editor: NoteMarkdownEditorHandle) => void;
  readonly active?: keyof NoteEditorFormat;
};

/** 常用操作常驻，余下格式收进明确入口；整行不横向滚动（2026-10-09 用户决定）。 */
const EDITOR_TOOLS: readonly EditorToolSpec[] = [
  { Icon: Undo2, label: "撤销", title: "撤销（⌘/Ctrl+Z）", run: (editor) => editor.undo() },
  { Icon: Redo2, label: "重做", title: "重做（⌘/Ctrl+Shift+Z）", run: (editor) => editor.redo() },
  { Icon: Bold, label: "加粗", title: "加粗（⌘/Ctrl+B）", active: "strong", run: (editor) => editor.toggleStrong() },
  { Icon: Italic, label: "斜体", title: "斜体（⌘/Ctrl+I）", active: "emphasis", run: (editor) => editor.toggleEmphasis() },
  { Icon: Strikethrough, label: "删除线", title: "删除线", active: "strike", run: (editor) => editor.toggleStrikethrough?.() },
  { Icon: Code, label: "行内代码", title: "行内代码", active: "inlineCode", run: (editor) => editor.toggleInlineCode() },
  { Icon: Quote, label: "引用", title: "把这一段变成引用", active: "quote", run: (editor) => editor.toggleBlockquote() },
  { Icon: List, label: "无序列表", title: "变成无序列表", active: "bullet", run: (editor) => editor.toggleBulletList() },
  { Icon: ListOrdered, label: "有序列表", title: "变成有序列表", active: "ordered", run: (editor) => editor.toggleOrderedList() },
];

const INSERT_TOOLS: readonly EditorToolSpec[] = [
  { Icon: Table2, label: "表格", title: "插入两列表格", run: editor => editor.insertText("\n\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n\n") },
  { Icon: CodeXml, label: "代码块", title: "插入代码区块", run: (editor) => editor.insertCodeBlock() },
  { Icon: Minus, label: "分隔线", title: "插入分隔线", run: (editor) => editor.insertHr() },
];

export function NotebookEditorTools(props: {
  readonly editorRef: RefObject<NoteMarkdownEditorHandle | null>;
  readonly editable: boolean;
  readonly canUpload: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onImages: (files: FileList | null) => void;
  readonly title?: string;
  readonly onLink: () => void;
  readonly writing?: Omit<Parameters<typeof NotebookWritingMenu>[0], "editorRef" | "editable" | "title">;
  readonly legend?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<NoteEditorFormat | null>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const holder = root.current?.closest<HTMLElement>(".notebook-volume__tools"), workspace = root.current?.closest<HTMLElement>(".notebook-workspace");
    if (!holder) return;
    const measure = () => {
      // A fullscreen island hugs its contents. Measure the space between the fixed controls to avoid width feedback.
      const desk = holder.closest<HTMLElement>(".notebook-desk"), ribbon = desk?.querySelector<HTMLElement>(".notebook-focus-ribbon");
      const besideRibbon = desk && ribbon ? desk.clientWidth - ribbon.getBoundingClientRect().width - 152 : null;
      const capacity = besideRibbon === null ? holder.clientWidth : besideRibbon < 520 ? desk!.clientWidth - 136 : besideRibbon;
      setCompact(capacity < 740);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(holder); if (workspace) observer.observe(workspace);
    const ribbon = holder.closest(".notebook-desk")?.querySelector(".notebook-focus-ribbon"); if (ribbon) observer.observe(ribbon);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const surface = root.current?.closest(".notebook-workspace") ?? document;
    const read = () => {
      const next = props.editorRef.current?.getFormatState?.() ?? null;
      setFormat(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    surface.addEventListener(NOTE_FORMAT_EVENT, read); read();
    return () => surface.removeEventListener(NOTE_FORMAT_EVENT, read);
  }, [props.editorRef, props.editable]);
  const disabled = (spec: EditorToolSpec) => !props.editable || (spec.label === "撤销" && format?.canUndo === false) || (spec.label === "重做" && format?.canRedo === false);
  const run = (spec: EditorToolSpec) => { if (props.editorRef.current) { spec.run(props.editorRef.current); props.editorRef.current.focus(); } };
  const tool = (spec: EditorToolSpec) => (
    <span key={spec.label} className="editor-tools-item">
      <button type="button" className="tool" disabled={disabled(spec)}
        aria-pressed={spec.active ? Boolean(format?.[spec.active]) : undefined} aria-label={spec.label} title={spec.title} onMouseDown={event => event.preventDefault()}
        onClick={() => run(spec)}><spec.Icon size={16} aria-hidden="true" /></button>
    </span>
  );
  return <>
    <div ref={root} className="editor-tools" data-compact={compact || undefined} role="toolbar" aria-label="Markdown 格式工具">
      {tool(EDITOR_TOOLS[0])}
      <span className="editor-tools-divider" aria-hidden="true" />
      <WritingPopover label="插入" disabled={!props.editable} trigger={<><Plus size={16} aria-hidden="true" /><span className="editor-tools__insert-label">插入</span></>} onClose={() => props.editorRef.current?.focus()}>{close => (
        <div className="writing-menu-grid editor-tools-insert">
          <button type="button" title="图片可粘贴或拖入正文" disabled={!props.editable || !props.canUpload} onClick={() => { close(); props.fileInputRef.current?.click(); }}><ImagePlus size={15} aria-hidden="true" />图片</button>
          {INSERT_TOOLS.map(spec => <button key={spec.label} type="button" title={spec.title} onClick={() => { close(); if (props.editorRef.current) { spec.run(props.editorRef.current); props.editorRef.current.focus(); } }}><spec.Icon size={15} aria-hidden="true" />{spec.label}</button>)}
          <button type="button" title="插入链接（⌘/Ctrl+K）" onClick={() => { close(); props.onLink(); }}><Link2 size={15} aria-hidden="true" />链接</button>
        </div>
      )}</WritingPopover>
      {!compact ? <span className="editor-tools-item"><NotebookBlockFormat heading={format?.heading ?? 0} editable={props.editable} editorRef={props.editorRef} /></span> : null}
      {tool(EDITOR_TOOLS[2])}
      {!compact ? tool(EDITOR_TOOLS[3]) : null}
      <span className="editor-tools-divider" aria-hidden="true" />
      <NotebookFormatControls editorRef={props.editorRef} editable={props.editable} format={format} actions={false} compact={compact} />
      <WritingPopover label="更多格式" disabled={!props.editable} trigger={<><SlidersHorizontal size={16} aria-hidden="true" /><span>更多</span></>} className="editor-tools-overflow" onClose={() => props.editorRef.current?.focus()}>{close => <>
        {compact ? <div className="editor-tools-overflow__headings" aria-label="段落格式">{[0, 1, 2, 3, 4, 5, 6].map(level => <button type="button" key={level} aria-label={level ? `标题 ${level}` : "正文段落"} aria-pressed={(format?.heading ?? 0) === level} onMouseDown={event => event.preventDefault()} onClick={() => { props.editorRef.current?.toggleHeading(level); close(); }}>{level ? `H${level}` : "正文"}</button>)}</div> : null}
        <div className="writing-menu-grid editor-tools-overflow__commands">
          {[EDITOR_TOOLS[1], ...(compact ? [EDITOR_TOOLS[3]] : []), ...EDITOR_TOOLS.slice(4)].map(spec => <button key={spec.label} type="button" disabled={disabled(spec)} aria-pressed={spec.active ? Boolean(format?.[spec.active]) : undefined} title={spec.title} onMouseDown={event => event.preventDefault()} onClick={() => { close(); run(spec); }}><spec.Icon size={16} aria-hidden="true" /><span>{spec.label}</span></button>)}
          {compact ? <button type="button" aria-pressed={Boolean(format?.highlight)} onMouseDown={event => event.preventDefault()} onClick={() => { props.editorRef.current?.toggleExtension?.("highlight"); close(); }}><Highlighter size={16} aria-hidden="true" /><span>文本高亮</span></button> : null}
          <NotebookFormatActions editorRef={props.editorRef} editable={props.editable} format={format} labels onDone={close} />
        </div>
      </>}</WritingPopover>
      <NotebookWritingMenu {...props.writing} editorRef={props.editorRef} editable={props.editable} title={props.title} />
      <span className="editor-tools-legend">{props.legend ?? "改动自动同步 · 图片可粘贴或拖入"}</span>
      <input ref={props.fileInputRef} className="note-image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
        multiple tabIndex={-1} aria-hidden="true" onChange={event => { props.onImages(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
  </>;
}
