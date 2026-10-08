import { useEffect, useRef, useState, type RefObject } from "react";
import { Bold, Code, CodeXml, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Quote, Redo2, Undo2, Strikethrough, Table2, type LucideIcon } from "lucide-react";
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
  { Icon: Table2, label: "插入表格", title: "插入两列表格", run: editor => editor.insertText("\n\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n\n") },
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
  return <>
    <div ref={root} className="editor-tools" role="toolbar" aria-label="Markdown 格式工具">
      {EDITOR_TOOLS.map((tool, index) => <span key={tool.label} className="editor-tools-item">
        {index === 2 ? <label className="editor-block-format"><select aria-label="段落格式" value={format?.heading ?? 0} disabled={!props.editable}
          onChange={event => { props.editorRef.current?.toggleHeading(Number(event.target.value)); }}>
          <option value={0}>正文</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>标题 {level}</option>)}
        </select></label> : null}
        {[2, 6, 9].includes(index) ? <span className="editor-tools-divider" aria-hidden="true" /> : null}
        <button type="button" className="tool" disabled={!props.editable || (tool.label === "撤销" && format?.canUndo === false) || (tool.label === "重做" && format?.canRedo === false)}
        aria-pressed={tool.active ? Boolean(format?.[tool.active]) : undefined} aria-label={tool.label} title={tool.title} onMouseDown={event => event.preventDefault()}
        onClick={() => { if (props.editorRef.current) { tool.run(props.editorRef.current); props.editorRef.current.focus(); } }}><tool.Icon size={16} aria-hidden="true" /></button></span>)}
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
