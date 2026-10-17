import { $markSchema, $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Mark } from "@milkdown/kit/prose/model";
import { yUndoPluginKey } from "y-prosemirror";
import { cleanNoteRichStyle, noteRichStyleCss, richStyleFromCss } from "@astella/shared/note-markdown";
export const noteRichStyleMark = $markSchema("noteStyle", () => ({
  attrs: { noteStyle: { default: null } }, toDOM: mark => ["span", { style: noteRichStyleCss(mark.attrs.noteStyle) }, 0],
  parseDOM: [{ tag: "span[style]", getAttrs: dom => { const noteStyle = richStyleFromCss((dom as HTMLElement).getAttribute("style")); return Object.keys(noteStyle).length ? { noteStyle } : false; } }],
  parseMarkdown: { match: node => node.type === "noteStyle", runner: (state, node, type) => { state.openMark(type, { noteStyle: cleanNoteRichStyle(node.noteStyle) }); state.next(node.children); state.closeMark(type); } },
  toMarkdown: { match: mark => mark.type.name === "noteStyle", runner: (state, mark) => { state.withMark(mark, "noteStyle", undefined, { noteStyle: mark.attrs.noteStyle }); } },
}));
type Brush = { marks: readonly Mark[]; paragraph: unknown } | null;
export const noteFormatBrushKey = new PluginKey<Brush>("note-format-brush");
export function noteFormatBrushPlugin() { return $prose(() => new Plugin<Brush>({ key: noteFormatBrushKey,
  state: { init: () => null, apply: (tr, brush) => tr.getMeta(noteFormatBrushKey) === undefined ? brush : tr.getMeta(noteFormatBrushKey) },
  props: { attributes: state => ({ "data-format-brush": String(Boolean(noteFormatBrushKey.getState(state))) }), handleDOMEvents: {
    mouseup(view) {
      const brush = noteFormatBrushKey.getState(view.state); if (!brush || !view.editable || view.composing) return false;
      queueMicrotask(() => { if (view.isDestroyed || !view.editable || view.composing || noteFormatBrushKey.getState(view.state) !== brush) return; const { from, to, empty } = view.state.selection; if (empty) return;
        const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing();
        const tr = view.state.tr.removeMark(from, to); brush.marks.forEach(mark => tr.addMark(from, to, mark));
        view.state.doc.nodesBetween(from, to, (node, pos) => { if (["paragraph", "heading"].includes(node.type.name)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, noteStyle: brush.paragraph ?? null }); });
        view.dispatch(tr.setMeta(noteFormatBrushKey, null)); undo?.stopCapturing();
      }); return false;
    }, keydown(view, raw) { const event = raw as KeyboardEvent; if (event.key === "Escape" && noteFormatBrushKey.getState(view.state)) { event.preventDefault(); view.dispatch(view.state.tr.setMeta(noteFormatBrushKey, null)); return true; } return false; },
  } },
})); }
