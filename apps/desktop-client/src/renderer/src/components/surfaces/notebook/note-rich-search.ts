import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { yUndoPluginKey } from "y-prosemirror";
export const noteSearchKey = new PluginKey<SearchState>("note-rich-search");
type SearchState = { query: string; sensitive: boolean; matches: { from: number; to: number }[]; index: number };
export function findNoteText(doc: Node, query: string, sensitive = false) {
  const matches: { from: number; to: number }[] = [];
  if (!query) return matches;
  const needle = sensitive ? query : query.toLocaleLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    let text = "", positions: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) { text += child.text; for (let i = 0; i < child.nodeSize; i++) positions.push(pos + 1 + offset + i); }
      else { text += "\ufffc"; positions.push(pos + 1 + offset); }
    });
    const haystack = sensitive ? text : text.toLocaleLowerCase();
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + Math.max(1, needle.length))) {
      matches.push({ from: positions[at]!, to: positions[at + needle.length - 1]! + 1 });
    }
    return false;
  }); return matches;
}
export function noteRichSearchPlugin() {
  return $prose(() => new Plugin<SearchState>({ key: noteSearchKey,
    state: { init: () => ({ query: "", sensitive: false, matches: [], index: 0 }), apply(tr, previous) {
      const next = { ...previous, ...tr.getMeta(noteSearchKey) };
      if (tr.docChanged || tr.getMeta(noteSearchKey)) next.matches = findNoteText(tr.doc, next.query, next.sensitive);
      next.index = Math.min(next.index, Math.max(0, next.matches.length - 1)); return next;
    } },
    props: { decorations(state) {
      const search = noteSearchKey.getState(state)!;
      return DecorationSet.create(state.doc, search.matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === search.index ? "note-search-current" : "note-search-match" })));
    }, handleDOMEvents: { keydown(view, raw) {
      const event = raw as KeyboardEvent;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !event.isComposing) {
        event.preventDefault(); view.dom.dispatchEvent(new CustomEvent("note-open-search")); return true;
      } return false;
    } } },
    view(view) {
      const panel = document.createElement("form"); panel.className = "note-search-panel"; panel.setAttribute("aria-label", "正文查找和替换"); panel.hidden = true;
      const query = document.createElement("input"); query.setAttribute("aria-label", "查找文字"); query.placeholder = "查找正文";
      const replacement = document.createElement("input"); replacement.setAttribute("aria-label", "替换为"); replacement.placeholder = "替换为";
      const status = document.createElement("output"); status.setAttribute("aria-live", "polite");
      const sensitive = document.createElement("input"); sensitive.type = "checkbox"; sensitive.setAttribute("aria-label", "区分大小写");
      const sensitivity = document.createElement("label"); sensitivity.append(sensitive, "Aa");
      const button = (name: string, run: () => void) => { const element = document.createElement("button"); element.type = "button"; element.textContent = name; element.addEventListener("click", run); panel.append(element); return element; };
      const search = () => view.dispatch(view.state.tr.setMeta(noteSearchKey, { query: query.value, sensitive: sensitive.checked, index: 0 }));
      const move = (delta: number) => {
        const current = noteSearchKey.getState(view.state)!; if (!current.matches.length) return;
        const index = (current.index + delta + current.matches.length) % current.matches.length, match = current.matches[index]!;
        view.dispatch(view.state.tr.setMeta(noteSearchKey, { index }).setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView());
      };
      const close = () => { panel.hidden = true; view.dispatch(view.state.tr.setMeta(noteSearchKey, { query: "" })); view.focus(); };
      panel.append(query, status, sensitivity); button("上一个", () => move(-1)); button("下一个", () => move(1)); panel.append(replacement);
      const replace = button("替换", () => {
        const current = noteSearchKey.getState(view.state)!, match = current.matches[current.index]; if (!match || !view.editable) return;
        const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing();
        view.dispatch(view.state.tr.insertText(replacement.value, match.from, match.to)); undo?.stopCapturing(); move(0);
      });
      const all = button("全部替换", () => {
        if (!view.editable) return; const matches = noteSearchKey.getState(view.state)!.matches, tr = view.state.tr;
        for (const match of [...matches].reverse()) tr.insertText(replacement.value, match.from, match.to);
        if (tr.docChanged) { const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing(); view.dispatch(tr); undo?.stopCapturing(); }
      }); button("关闭", close);
      const open = () => { panel.hidden = false; const selected = view.state.doc.textBetween(view.state.selection.from, view.state.selection.to); if (selected) query.value = selected; search(); query.focus(); query.select(); };
      query.addEventListener("input", search); sensitive.addEventListener("change", search);
      panel.addEventListener("submit", event => { event.preventDefault(); move(1); });
      panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } });
      view.dom.addEventListener("note-open-search", open);
      view.dom.closest(".note-editor")?.prepend(panel);
      return { update() { const current = noteSearchKey.getState(view.state)!; status.textContent = `${current.matches.length ? current.index + 1 : 0} / ${current.matches.length}`; replace.disabled = all.disabled = !view.editable; }, destroy() { panel.remove(); view.dom.removeEventListener("note-open-search", open); } };
    },
  }));
}
