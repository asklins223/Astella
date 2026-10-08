import { NotebookFormatControls, NotebookBlockFormat, WritingPopover } from "./notebook-format-controls";
import { NotebookWritingMenu } from "./notebook-writing-menu";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Bold, Code, CodeXml, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Plus, Quote, Redo2, Table2, Undo2, Strikethrough, type LucideIcon } from "lucide-react";
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

/** 一行里直接点到的开关；插入类动作收进「插入」菜单，整条工具条因此排得成一行（2026-10-08 用户要求）。 */
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
  useEffect(() => {
    const surface = root.current?.closest(".notebook-workspace") ?? document;
    const read = () => {
      const next = props.editorRef.current?.getFormatState?.() ?? null;
      setFormat(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    surface.addEventListener(NOTE_FORMAT_EVENT, read); read();
    return () => surface.removeEventListener(NOTE_FORMAT_EVENT, read);
  }, [props.editorRef, props.editable]);
  const tool = (spec: EditorToolSpec) => (
    <span key={spec.label} className="editor-tools-item">
      <button type="button" className="tool" disabled={!props.editable || (spec.label === "撤销" && format?.canUndo === false) || (spec.label === "重做" && format?.canRedo === false)}
        aria-pressed={spec.active ? Boolean(format?.[spec.active]) : undefined} aria-label={spec.label} title={spec.title} onMouseDown={event => event.preventDefault()}
        onClick={() => { if (props.editorRef.current) { spec.run(props.editorRef.current); props.editorRef.current.focus(); } }}><spec.Icon size={16} aria-hidden="true" /></button>
    </span>
  );
  return <>
    <div ref={root} className="editor-tools" role="toolbar" aria-label="Markdown 格式工具">
      {EDITOR_TOOLS.slice(0, 2).map(tool)}
      <span className="editor-tools-divider" aria-hidden="true" />
      <WritingPopover label="插入" disabled={!props.editable} trigger={<><Plus size={16} aria-hidden="true" /><span>插入</span></>} onClose={() => props.editorRef.current?.focus()}>{close => (
        <div className="writing-menu-grid editor-tools-insert">
          <button type="button" title="图片可粘贴或拖入正文" disabled={!props.editable || !props.canUpload} onClick={() => { close(); props.fileInputRef.current?.click(); }}><ImagePlus size={15} aria-hidden="true" />图片</button>
          {INSERT_TOOLS.map(spec => <button key={spec.label} type="button" title={spec.title} onClick={() => { close(); if (props.editorRef.current) { spec.run(props.editorRef.current); props.editorRef.current.focus(); } }}><spec.Icon size={15} aria-hidden="true" />{spec.label}</button>)}
          <button type="button" title="插入链接（⌘/Ctrl+K）" onClick={() => { close(); props.onLink(); }}><Link2 size={15} aria-hidden="true" />链接</button>
        </div>
      )}</WritingPopover>
      <span className="editor-tools-item"><NotebookBlockFormat heading={format?.heading ?? 0} editable={props.editable} editorRef={props.editorRef} /></span>
      {EDITOR_TOOLS.slice(2).map(tool)}
      <span className="editor-tools-divider" aria-hidden="true" />
      <NotebookFormatControls editorRef={props.editorRef} editable={props.editable} format={format} />
      <NotebookWritingMenu {...props.writing} editorRef={props.editorRef} editable={props.editable} title={props.title} />
      <span className="editor-tools-legend">{props.legend ?? "改动自动同步 · 图片可粘贴或拖入"}</span>
      <input ref={props.fileInputRef} className="note-image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
        multiple tabIndex={-1} aria-hidden="true" onChange={event => { props.onImages(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
  </>;
}
