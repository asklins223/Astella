import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { NoteMarkdownEditor, type NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { NoteSourceEditor, type NoteSourceEditorHandle } from "./note-source-editor";
import type { NoteBodyMode } from "./note-document-mode";

/** Both views stay attached to the same document for this note's whole visit. */
export function NoteDocumentEditor({ mode, ref, ...props }: ComponentProps<typeof NoteMarkdownEditor> & { readonly mode: NoteBodyMode }) {
  const richRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const sourceRef = useRef<NoteSourceEditorHandle | null>(null);
  const [editor, setEditor] = useState<NoteMarkdownEditorHandle | null>(null);
  const onReady = useCallback((handle: NoteMarkdownEditorHandle | null) => { richRef.current = handle; setEditor(handle); }, []);
  const latest = useRef({ mode, onChange: props.onChange });
  latest.current = { mode, onChange: props.onChange };
  const onChange = useCallback((value: string) => {
    latest.current.onChange(richRef.current?.getMarkdown() ?? value);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const inSource = () => latest.current.mode === "source" && sourceRef.current !== null;
    const wrap = (before: string, after = "") => sourceRef.current?.surround(before, after);
    const handle: NoteMarkdownEditorHandle = {
      ...editor,
      focus: () => inSource() ? sourceRef.current!.focusPosition(sourceRef.current!.getPosition()) : editor.focus(),
      insertText: (text) => inSource() ? sourceRef.current!.insertText(text) : editor.insertText(text),
      toggleStrong: () => inSource() ? wrap("**", "**") : editor.toggleStrong(),
      toggleEmphasis: () => inSource() ? wrap("*", "*") : editor.toggleEmphasis(),
      toggleInlineCode: () => inSource() ? wrap("`", "`") : editor.toggleInlineCode(),
      toggleHeading: (level) => inSource() ? sourceRef.current!.toggleLinePrefix(`${"#".repeat(level)} `, /^#{1,6} /) : editor.toggleHeading(level),
      toggleBlockquote: () => inSource() ? sourceRef.current!.toggleLinePrefix("> ", /^> /) : editor.toggleBlockquote(),
      toggleBulletList: () => inSource() ? sourceRef.current!.toggleLinePrefix("- ", /^(?:[-+*]|\d+\.) /) : editor.toggleBulletList(),
      toggleOrderedList: () => inSource() ? sourceRef.current!.toggleLinePrefix("1. ", /^(?:[-+*]|\d+\.) /) : editor.toggleOrderedList(),
      toggleLink: (href) => inSource() ? wrap("[", `](${href})`) : editor.toggleLink(href),
      insertCodeBlock: () => inSource() ? wrap("```\n", "\n```") : editor.insertCodeBlock(),
      insertHr: () => inSource() ? wrap("\n---\n") : editor.insertHr(),
      getPosition: () => inSource() ? sourceRef.current!.getPosition() : editor.getPosition(),
      focusPosition: (position) => inSource() ? sourceRef.current!.focusPosition(position) : editor.focusPosition(position),
      isComposing: () => editor.isComposing() || Boolean(sourceRef.current?.isComposing()),
    };
    const write = (value: NoteMarkdownEditorHandle | null) => {
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    };
    write(handle);
    return () => write(null);
  }, [editor, ref]);

  return <div className="note-document-editor" data-body-mode={mode}>
    <div hidden={mode !== "live-preview"}>
      <NoteMarkdownEditor {...props} disabled={props.disabled || mode !== "live-preview"} onChange={onChange} onReady={onReady} />
    </div>
    <div hidden={mode !== "source"}>
      {editor ? <NoteSourceEditor editor={editor} handleRef={sourceRef} disabled={Boolean(props.disabled) || mode !== "source"}
        onChange={props.onChange} onImagePaste={props.onImagePaste}
        annotationPlacements={props.annotationPlacements} onOpenAnnotation={props.onOpenAnnotation} /> : null}
    </div>
  </div>;
}
