import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import type { NoteDocumentPosition } from "./note-source-bridge";
import { isNoteEditingMode, type NoteBodyMode } from "./note-document-mode";

/** View state stays outside the shared document. Anchors are blocks, never scroll percentages. */
export function useNotebookBodyMode(input: {
  readonly noteId: string | null;
  readonly initialMode: NoteBodyMode | undefined;
  readonly canEdit: boolean;
  readonly editorRef: RefObject<NoteMarkdownEditorHandle | null>;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly readingRoot?: RefObject<HTMLElement | null>;
  readonly onChange: (mode: NoteBodyMode) => void;
}) {
  const [mode, setMode] = useState<NoteBodyMode>("preview");
  const [pendingMode, setPendingMode] = useState<NoteBodyMode | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const positions = useRef<Partial<Record<NoteBodyMode, NoteDocumentPosition>>>({});
  const transfer = useRef<NoteDocumentPosition | null>(null);
  const currentMode = useRef(mode);
  currentMode.current = mode;

  useEffect(() => {
    positions.current = {};
    transfer.current = null;
    setPendingMode(null);
    setMode(latest.current.canEdit ? latest.current.initialMode ?? "preview" : "preview");
  }, [input.noteId]);

  const change = useCallback((next: NoteBodyMode) => {
    const { editorRef, scrollRef, canEdit, readingRoot } = latest.current;
    if (isNoteEditingMode(next) && !canEdit) return;
    if (editorRef.current?.isComposing()) { setPendingMode(next); return; }
    const previous = currentMode.current;
    let position = editorRef.current?.getPosition() ?? { block: 0, offset: 0 };
    if (previous === "preview" && scrollRef.current) {
      const scroller = scrollRef.current;
      const top = scroller.getBoundingClientRect().top;
      const blocks = Array.from((readingRoot?.current ?? scroller).querySelectorAll<HTMLElement>("[data-block-ordinal]"));
      const visible = blocks.find((block) => block.getBoundingClientRect().bottom > top) ?? blocks.at(-1);
      if (visible) position = { block: Number(visible.dataset.blockOrdinal), offset: 0 };
    }
    positions.current[previous] = position;
    const remembered = positions.current[next];
    transfer.current = remembered?.block === position.block ? remembered : position;
    setPendingMode(null);
    setMode(next);
    latest.current.onChange(next);
  }, []);

  // A mode button must not end composition or discard the IME's last sentence.
  useEffect(() => {
    if (!pendingMode) return;
    let frame: number | undefined;
    const afterCommit = () => {
      // ProseMirror may clear composing one frame after compositionend.
      if (latest.current.editorRef.current?.isComposing()) frame = requestAnimationFrame(afterCommit);
      else change(pendingMode);
    };
    const commit = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = requestAnimationFrame(afterCommit); };
    document.addEventListener("compositionend", commit);
    return () => { document.removeEventListener("compositionend", commit); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [pendingMode, change]);

  useEffect(() => {
    if (!input.canEdit && mode !== "preview") change("preview");
  }, [input.canEdit, mode, change]);

  useEffect(() => {
    if (!transfer.current) return;
    const position = transfer.current;
    const frame = requestAnimationFrame(() => {
      if (mode === "preview") {
        const scroller = latest.current.scrollRef.current;
        const target = (latest.current.readingRoot?.current ?? scroller)?.querySelector<HTMLElement>(`[data-block-ordinal="${position.block}"]`);
        if (target && scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      } else latest.current.editorRef.current?.focusPosition(position);
      transfer.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);

  return { mode, changeMode: change, pendingMode };
}
