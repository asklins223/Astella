import type { RefObject } from "react";
import { Bold, Code, CodeXml, Heading2, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Quote, Redo2, Undo2, type LucideIcon } from "lucide-react";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";

/**
 * Commands use the active document view and keep its selection when a tool is pressed.
 */
type EditorToolSpec = {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly title: string;
  readonly run: (editor: NoteMarkdownEditorHandle) => void;
};

const EDITOR_TOOLS: readonly EditorToolSpec[] = [
  { Icon: Undo2, label: "撤销", title: "撤销（⌘/Ctrl+Z）", run: (editor) => editor.undo() },
  { Icon: Redo2, label: "重做", title: "重做（⌘/Ctrl+Shift+Z）", run: (editor) => editor.redo() },
  { Icon: Heading2, label: "标题", title: "把这一段变成标题", run: (editor) => editor.toggleHeading(2) },
  { Icon: Bold, label: "加粗", title: "加粗（⌘/Ctrl+B）", run: (editor) => editor.toggleStrong() },
  { Icon: Italic, label: "斜体", title: "斜体（⌘/Ctrl+I）", run: (editor) => editor.toggleEmphasis() },
  { Icon: Code, label: "行内代码", title: "行内代码", run: (editor) => editor.toggleInlineCode() },
  { Icon: Quote, label: "引用", title: "把这一段变成引用", run: (editor) => editor.toggleBlockquote() },
  { Icon: List, label: "无序列表", title: "变成无序列表", run: (editor) => editor.toggleBulletList() },
  { Icon: ListOrdered, label: "有序列表", title: "变成有序列表", run: (editor) => editor.toggleOrderedList() },
  { Icon: CodeXml, label: "代码块", title: "插入代码区块", run: (editor) => editor.insertCodeBlock() },
  { Icon: Minus, label: "分隔线", title: "插入分隔线", run: (editor) => editor.insertHr() },
];

export function NotebookEditorTools(props: {
  readonly editorRef: RefObject<NoteMarkdownEditorHandle | null>;
  readonly editable: boolean;
  readonly canUpload: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onImages: (files: FileList | null) => void;
  readonly onLink: () => void;
}) {
  return <>
    <div className="editor-tools" role="toolbar" aria-label="Markdown 格式工具">
      {EDITOR_TOOLS.map(tool => <button key={tool.label} type="button" className="tool" disabled={!props.editable}
        aria-label={tool.label} title={tool.title} onMouseDown={event => event.preventDefault()}
        onClick={() => { if (props.editorRef.current) tool.run(props.editorRef.current); }}><tool.Icon size={16} aria-hidden="true" /></button>)}
      <button type="button" className="tool" disabled={!props.editable} aria-label="链接" title="插入链接（⌘/Ctrl+K）"
        onMouseDown={event => event.preventDefault()} onClick={props.onLink}><Link2 size={16} aria-hidden="true" /></button>
      <button type="button" className="tool" disabled={!props.editable || !props.canUpload} aria-label="插入图片"
        title="图片可粘贴或拖入正文" onMouseDown={event => event.preventDefault()} onClick={() => props.fileInputRef.current?.click()}><ImagePlus size={16} aria-hidden="true" /></button>
      <span className="editor-tools-legend">改动自动同步 · 图片可粘贴或拖入</span>
      <input ref={props.fileInputRef} className="note-image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
        multiple tabIndex={-1} aria-hidden="true" onChange={event => { props.onImages(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
  </>;
}
