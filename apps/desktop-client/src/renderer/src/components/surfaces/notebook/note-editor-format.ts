import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import type { EditorState } from "@milkdown/kit/prose/state";
import { yUndoPluginKey } from "y-prosemirror";

export const NOTE_FORMAT_EVENT = "note-editor-format-change";
export type NoteEditorFormat = {
  heading: number;
  strong: boolean;
  emphasis: boolean;
  inlineCode: boolean;
  strike: boolean;
  quote: boolean;
  bullet: boolean;
  ordered: boolean;
  canUndo: boolean;
  canRedo: boolean;
};
export function noteEditorFormat(state: EditorState): NoteEditorFormat {
  const { selection } = state;
  const marks = state.storedMarks ?? selection.$from.marks();
  const mark = (name: string) => selection.empty ? marks.some(item => item.type.name === name)
    : Boolean(state.schema.marks[name] && state.doc.rangeHasMark(selection.from, selection.to, state.schema.marks[name]!));
  const parents = Array.from({ length: selection.$from.depth }, (_, depth) => selection.$from.node(depth + 1));
  const undo = yUndoPluginKey.getState(state)?.undoManager;
  return {
    heading: parents.find(node => node.type.name === "heading")?.attrs.level ?? 0,
    strong: mark("strong"), emphasis: mark("emphasis"), inlineCode: mark("inlineCode"), strike: mark("strike_through"),
    quote: parents.some(node => node.type.name === "blockquote"), bullet: parents.some(node => node.type.name === "bullet_list"), ordered: parents.some(node => node.type.name === "ordered_list"),
    canUndo: Boolean(undo?.canUndo()), canRedo: Boolean(undo?.canRedo()),
  };
}
export const notifyNoteEditorFormat = (dom: HTMLElement) => dom.dispatchEvent(new Event(NOTE_FORMAT_EVENT, { bubbles: true }));
export function noteEditorFormatPlugin() {
  return $prose(() => new Plugin({ view: view => {
    let scheduled = false;
    return { update: () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; if (!view.isDestroyed) notifyNoteEditorFormat(view.dom); });
    } };
  } }));
}
