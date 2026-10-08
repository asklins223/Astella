import { useEffect, useRef, type RefObject } from "react";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@astella/shared/note-projection-contracts";
import type { CompanionNoteEditingContextV1 } from "@astella/shared/companion-note-authoring-contracts";
import type { NoteAnnotationAnchorV1 } from "@astella/shared/note-annotation-contracts";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { noteReadingOffset } from "./note-reading-text";
import { noteSourceBlocks } from "./note-source-structure";
import { registerCompanionNotePaper } from "../../companion/note-companion-editing";
import { createRequestMeta, unwrapGatewayResult, requireWorkspaceEpoch } from "../../../app/desktop-client";

export function useNotebookCompanionEditing(input: {
  note: NoteDetailV1 | null; blocks: readonly NoteBlockProjectionV1[]; mode: string; editable: boolean;
  bodyRef: RefObject<HTMLDivElement | null>; editorRef: RefObject<NoteMarkdownEditorHandle | null>;
  selection: { anchor: NoteAnnotationAnchorV1 | null } | null;
  flush: () => Promise<unknown>;
}) {
  const latest = useRef(input); latest.current = input;
  const remembered = useRef<CompanionNoteEditingContextV1>({});
  const previousNote = useRef(input.note?.noteId);
  if (previousNote.current !== input.note?.noteId) { remembered.current = {}; previousNote.current = input.note?.noteId; }
  if (input.selection?.anchor) {
    const a = input.selection.anchor;
    remembered.current.selection = { startBlock: a.startBlockOrdinal, endBlock: a.endBlockOrdinal,
      startOffset: a.startOffset, endOffset: a.endOffset, excerpt: a.excerpt,
      expectedBlocks: input.blocks.slice(a.startBlockOrdinal, a.endBlockOrdinal + 1).map(b => b.content) };
  }
  useEffect(() => {
    const capture = (event: Event) => {
      const { blocks, editorRef, mode, bodyRef } = latest.current;
      if (!(event.target instanceof Element) || !event.target.closest(".note-document-editor, .note-transcript")) return;
      delete remembered.current.selection;
      if (mode === "preview") {
        const selection = window.getSelection();
        if (!selection?.isCollapsed || !selection.rangeCount || !bodyRef.current?.contains(selection.anchorNode)) return;
        const parent = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
        const root = parent?.closest<HTMLElement>("[data-block-ordinal]");
        const block = Number(root?.dataset.blockOrdinal), content = root?.querySelector<HTMLElement>("[data-note-block-content]");
        if (!content || !blocks[block]) return;
        remembered.current.cursor = { block, offset: noteReadingOffset(content, selection.anchorNode!, selection.anchorOffset, 0, "start"), coordinate: "reading", expectedBlock: blocks[block]!.content };
      } else {
        const position = editorRef.current?.getPosition();
        if (!position || !blocks[position.block]) return;
        const source = mode === "source" ? editorRef.current?.getMarkdown() : null;
        const part = source ? noteSourceBlocks(source)[position.block] : null;
        remembered.current.cursor = { ...position, coordinate: mode === "source" ? "source" : "document", expectedBlock: blocks[position.block]!.content,
          ...(part && source ? { sourceText: source.slice(part.from, part.to) } : {}) };
      }
    };
    document.addEventListener("pointerup", capture); document.addEventListener("keyup", capture); document.addEventListener("input", capture); document.addEventListener("compositionend", capture);
    return () => { document.removeEventListener("pointerup", capture); document.removeEventListener("keyup", capture); document.removeEventListener("input", capture); document.removeEventListener("compositionend", capture); };
  }, []);
  useEffect(() => {
    if (!input.note?.noteId || !input.editable) return;
    return registerCompanionNotePaper({ noteId: input.note.noteId, prepare: async () => {
      const current = latest.current;
      if (!current.note?.currentVersionId || !current.editable || current.editorRef.current?.isComposing()) throw new Error("先完成当前输入，再交给伴星调整正文。");
      const editing = structuredClone(remembered.current);
      const tail = current.blocks.at(-1);
      if (tail) editing.tail = { block: tail.ordinal, expectedBlock: tail.content };
      const outcome = await current.flush();
      if (outcome === "queued") throw new Error("笔记还在离线保存队列里，联网保存后再交给伴星修改。");
      const saved = unwrapGatewayResult(await window.astella.note.get({ meta: createRequestMeta(await requireWorkspaceEpoch()), noteId: current.note.noteId }));
      if (!saved.currentVersionId) throw new Error("笔记还没有可编辑的当前版本。");
      return { noteVersionId: saved.currentVersionId, editing };
    } });
  }, [input.note?.noteId, input.editable]);
}
