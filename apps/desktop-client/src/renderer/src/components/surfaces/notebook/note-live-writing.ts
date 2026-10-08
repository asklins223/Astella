import { $prose } from "@milkdown/kit/utils";
import { noteEmojiEntries } from "@astella/shared/note-markdown";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { liftListItem, sinkListItem } from "@milkdown/kit/prose/schema-list";
import { exitCode, lift, setBlockType } from "@milkdown/kit/prose/commands";
import { toggleMark } from "@milkdown/kit/prose/commands";
import type { EditorState } from "@milkdown/kit/prose/state";

const delimiters: Record<string, [string, string]> = { strong: ["**", "**"], emphasis: ["*", "*"], inlineCode: ["`", "`"], strike_through: ["~~", "~~"], noteHighlight: ["==", "=="], noteSubscript: ["~", "~"], noteSuperscript: ["^", "^"] };
/** Syntax is a view decoration: moving the caret never edits or syncs the document. */
export function liveSyntaxDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [], { from, to } = state.selection;
  state.doc.forEach((node, pos) => { if (from >= pos && from <= pos + node.nodeSize) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "note-writing-active-block" })); });
  state.doc.descendants((block, pos) => {
    if (block.type.name === "blockquote") { const alert = block.firstChild?.textContent.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
      if (alert) { decorations.push(Decoration.node(pos, pos + block.nodeSize, { class: "note-writing-alert", "data-note-alert-title": ({ NOTE: "说明", TIP: "提示", IMPORTANT: "重点", WARNING: "注意", CAUTION: "谨慎" } as Record<string,string>)[alert[1]!.toUpperCase()]! }));
        if (from < pos + 2 || from > pos + 2 + alert[0].length) decorations.push(Decoration.inline(pos + 2, pos + 2 + alert[0].length, { class: "note-writing-alert-source" }));
      }
    }
    if (!block.isTextblock || block.type.name === "code_block" || from > pos + block.nodeSize || to < pos) return;
    const ranges: { from: number; to: number; name: string; href?: string }[] = [];
    block.forEach((node, offset) => {
      for (const mark of node.marks) {
        if (!delimiters[mark.type.name] && mark.type.name !== "link") continue;
        const start = pos + 1 + offset, last = ranges.findLast(range => range.name === mark.type.name && range.to === start && range.href === mark.attrs.href);
        if (last) last.to += node.nodeSize;
        else ranges.push({ from: start, to: start + node.nodeSize, name: mark.type.name, href: mark.attrs.href });
      }
    });
    const token = (at: number, value: string, side: number) => decorations.push(Decoration.widget(at, () => {
      const span = document.createElement("span"); span.className = "note-live-delimiter"; span.textContent = value;
      span.dataset.noteDecoration = "true"; span.contentEditable = "false"; span.setAttribute("aria-hidden", "true"); return span;
    }, { side, key: `${at}:${value}:${side}` }));
    if (block.type.name === "heading") token(pos + 1, `${"#".repeat(block.attrs.level)} `, -10);
    for (const range of ranges) {
      if (from > range.to || to < range.from) continue;
      const [open, close] = range.name === "link" ? ["[", `](${range.href ?? ""})`] : delimiters[range.name]!;
      token(range.from, open, -1); token(range.to, close, 1);
      decorations.push(Decoration.inline(range.from, range.to, { class: "note-live-active-syntax" }));
    }
  });
  return DecorationSet.create(state.doc, decorations);
}
export function noteLiveWritingPlugin() {
  return $prose(() => new Plugin({ props: {
    decorations: liveSyntaxDecorations,
    handleDOMEvents: { keydown(view, raw) {
      const event = raw as KeyboardEvent;
      if (!view.editable || view.composing || event.isComposing || event.keyCode === 229) return false;
      const { state } = view, { $from, empty } = state.selection;
      const mod = event.metaKey || event.ctrlKey;
      let handled = false;
      if (event.key === "Tab" && !mod && !event.altKey && $from.node(-1)?.type.name === "list_item") {
        handled = (event.shiftKey ? liftListItem : sinkListItem)(state.schema.nodes.list_item!)(state, view.dispatch);
      } else if (event.key === "Enter" && mod) {
        if ($from.parent.type.name === "code_block") handled = exitCode(state, view.dispatch);
        else if ($from.depth > 1 && $from.node(-1).type.name === "blockquote") handled = lift(state, view.dispatch);
      } else if (event.key === "Enter" && empty && !$from.parent.content.size && $from.parent.type.name === "heading") {
        handled = setBlockType(state.schema.nodes.paragraph!)(state, view.dispatch);
      } else if (event.key === "Backspace" && empty) {
        // Removing a visible opening/closing delimiter removes its formatting in one undo step.
        const marks = $from.marks();
        for (const mark of marks) {
          if (!delimiters[mark.type.name] && mark.type.name !== "link") continue;
          const previous = $from.nodeBefore, next = $from.nodeAfter;
          if (!previous?.marks.some(candidate => candidate.eq(mark)) || !next?.marks.some(candidate => candidate.eq(mark))) {
            let start = $from.pos, end = start;
            const ranges: { start: number; end: number }[] = [];
            $from.parent.forEach((node, offset) => {
              if (!node.marks.some(candidate => candidate.eq(mark))) return;
              const pos = $from.start() + offset, previous = ranges.at(-1);
              if (previous?.end === pos) previous.end += node.nodeSize;
              else ranges.push({ start: pos, end: pos + node.nodeSize });
            });
            const range = ranges.find(range => range.start <= $from.pos && range.end >= $from.pos);
            if (!range) continue; start = range.start; end = range.end;
            view.dispatch(state.tr.removeMark(start, end, mark.type).removeStoredMark(mark.type)); handled = true; break;
          }
        }
      } else if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
        handled = toggleMark(state.schema.marks.strike_through!)(state, view.dispatch);
      }
      if (handled) { event.preventDefault(); return true; } return false;
    } },
  }, view(view) {
    let frame = 0, items: { name: string; emoji: string }[] = [], selected = 0, start = 0;
    const popup = document.createElement("div"); popup.className = "note-emoji-completion"; popup.popover = "manual"; popup.hidden = true; popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Emoji 补全"); document.body.append(popup);
    const close = () => { popup.hidden = true; if (popup.matches(":popover-open")) popup.hidePopover(); items = []; };
    const pick = (index: number) => { const item = items[index]; if (!item || !view.editable || view.composing) return; view.dispatch(view.state.tr.insertText(item.emoji, start, view.state.selection.from)); close(); view.focus(); };
    const render = () => { popup.replaceChildren(); items.forEach((item, index) => { const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === selected)); button.textContent = `${item.emoji} :${item.name}:`; button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", () => pick(index)); popup.append(button); }); };
    const keydown = (event: KeyboardEvent) => { if (!items.length || event.isComposing || view.composing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopImmediatePropagation(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; render(); }
      else if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); pick(selected); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    }; view.dom.addEventListener("keydown", keydown, true);
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const { $from, empty } = view.state.selection; const before = $from.parent.textBetween(0, $from.parentOffset);
      const match = empty && view.editable && !view.composing && !["code_block", "note_source"].includes($from.parent.type.name) ? before.match(/(?:^|\s):([a-zA-Z0-9_+-]{2,})$/) : null;
      if (match) { start = $from.pos - match[1]!.length - 1; items = noteEmojiEntries.filter(item => item.name.startsWith(match[1]!.toLowerCase())).slice(0, 12); selected = Math.min(selected, Math.max(0, items.length - 1));
        if (items.length) { render(); popup.hidden = false; if (!popup.matches(":popover-open")) popup.showPopover(); const coords = view.coordsAtPos($from.pos); popup.style.left = `${Math.min(coords.left, window.innerWidth - 240)}px`; popup.style.top = `${Math.min(coords.bottom + 6, window.innerHeight - popup.offsetHeight - 12)}px`; } else close();
      } else close();
      if (!view.hasFocus() || view.composing || view.dom.closest(".notebook-workspace")?.getAttribute("data-typewriter") !== "true") return;
      const coords = view.coordsAtPos($from.pos); let container = view.dom.parentElement;
      while (container && container.scrollHeight <= container.clientHeight + 1) container = container.parentElement;
      if (container) { const bounds = container.getBoundingClientRect(), delta = coords.top - (bounds.top + bounds.height * 0.45); if (Math.abs(delta) > 16) container.scrollTop += delta; }
    }); };
    return { update, destroy() { cancelAnimationFrame(frame); close(); popup.remove(); view.dom.removeEventListener("keydown", keydown, true); } };
  } }));
}
