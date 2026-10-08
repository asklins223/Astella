import { $prose, callCommand } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { goToNextCell, isInTable, selectedRect, TableMap, deleteRow, deleteColumn, deleteTable } from "@milkdown/kit/prose/tables";
import { addRowAfterCommand, addRowBeforeCommand, addColAfterCommand, addColBeforeCommand, setAlignCommand, selectColCommand, moveRowCommand, moveColCommand } from "@milkdown/kit/preset/gfm";
import type { EditorView } from "@milkdown/kit/prose/view";
import { noteAiLockKey } from "./note-ai-lock";
import { yUndoPluginKey } from "y-prosemirror";

const writable = (view: EditorView, pos: number) => view.editable && !(noteAiLockKey.getState(view.state) ?? []).some(lock => pos >= lock.from && pos < lock.to);

/** Native checkboxes have the same keyboard and read-only behaviour as text input. */
export function noteListItemViewPlugin() {
  return $prose(() => {
    const refreshers = new Set<() => void>();
    return new Plugin({ props: { nodeViews: { list_item(initial, view, getPos) {
      let node = initial;
      const dom = document.createElement("li"), contentDOM = document.createElement("div");
      contentDOM.className = "note-list-item__content";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.contentEditable = "false";
      checkbox.setAttribute("aria-label", "完成这一项"); dom.append(checkbox, contentDOM);
      const refresh = () => {
        const task = node.attrs.checked !== null && node.attrs.checked !== undefined;
        dom.classList.toggle("note-task-item", task); checkbox.hidden = !task;
        checkbox.checked = Boolean(node.attrs.checked); const pos = getPos(); checkbox.disabled = pos === undefined || !writable(view, pos);
      };
      checkbox.addEventListener("change", () => { const pos = getPos(); if (pos !== undefined && writable(view, pos)) {
        const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing();
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: checkbox.checked })); undo?.stopCapturing();
      } });
      refresh(); refreshers.add(refresh);
      return { dom, contentDOM, update(next) { if (next.type !== node.type) return false; node = next; refresh(); return true; },
        stopEvent: event => event.target === checkbox,
        ignoreMutation: mutation => mutation.type !== "selection" && (mutation.target === dom || mutation.target === checkbox),
        destroy: () => { refreshers.delete(refresh); } };
    } } }, view: () => ({ update: () => refreshers.forEach(refresh => refresh()) }) });
  });
}

/** Tab extends a table at its last cell; Mod+Enter inserts a row below the caret. */
export function noteTableKeyboardPlugin() {
  return $prose(ctx => new Plugin({ props: { handleDOMEvents: { keydown(view, rawEvent) {
    const event = rawEvent as KeyboardEvent;
    if (event.isComposing || !view.editable || !isInTable(view.state)) return false;
    const { from } = view.state.selection;
    if (!writable(view, from)) return false;
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const direction = event.shiftKey ? -1 : 1;
      if (goToNextCell(direction)(view.state, view.dispatch)) { event.preventDefault(); return true; }
      if (direction < 0) return false;
      callCommand(addRowAfterCommand.key)(ctx); goToNextCell(1)(view.state, view.dispatch); event.preventDefault(); return true;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      const before = selectedRect(view.state);
      callCommand(addRowAfterCommand.key)(ctx);
      const after = selectedRect(view.state), map = TableMap.get(after.table);
      const cell = map.positionAt(Math.min(before.bottom, map.height - 1), before.left, after.table);
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(after.tableStart + cell + 1))).scrollIntoView());
      event.preventDefault(); return true;
    }
    return false;
  } } } }));
}

/** Table operations follow the current cell without becoming part of the table's editable DOM. */
export function noteTableContextPlugin() {
  return $prose(ctx => new Plugin({ view: view => {
    const popup = document.createElement("div"); popup.className = "note-table-context"; popup.popover = "manual";
    popup.hidden = true; popup.contentEditable = "false"; popup.setAttribute("role", "toolbar"); popup.setAttribute("aria-label", "当前表格操作");
    document.body.append(popup);
    const hide = () => { popup.hidden = true; if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover(); };
    const menu = document.createElement("details"), summary = document.createElement("summary"), items = document.createElement("div");
    summary.textContent = "行与列"; items.className = "note-table-context__menu"; menu.append(summary, items); popup.append(menu);
    const button = (label: string, run: () => void) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => { if (isInTable(view.state) && writable(view, view.state.selection.from)) run(); menu.open = false; view.focus(); }); items.append(button);
    };
    button("在上方插入行", () => callCommand(addRowBeforeCommand.key)(ctx));
    button("在下方插入行", () => callCommand(addRowAfterCommand.key)(ctx));
    button("在左侧插入列", () => callCommand(addColBeforeCommand.key)(ctx));
    button("在右侧插入列", () => callCommand(addColAfterCommand.key)(ctx));
    button("删除当前行", () => { deleteRow(view.state, view.dispatch); });
    button("删除当前列", () => { deleteColumn(view.state, view.dispatch); });
    for (const [label, axis, delta] of [["上移当前行", "row", -1], ["下移当前行", "row", 1], ["左移当前列", "column", -1], ["右移当前列", "column", 1]] as const) button(label, () => {
      const rect = selectedRect(view.state), from = axis === "row" ? rect.top : rect.left, to = from + delta;
      if (to < (axis === "row" ? 1 : 0) || to >= (axis === "row" ? rect.map.height : rect.map.width) || axis === "row" && from === 0) return;
      if (axis === "row") callCommand(moveRowCommand.key, { from, to })(ctx); else callCommand(moveColCommand.key, { from, to })(ctx);
    });
    button("删除表格", () => { hide(); deleteTable(view.state, view.dispatch); });
    const align = document.createElement("select"); align.setAttribute("aria-label", "当前列对齐");
    for (const [value, label] of [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]]) { const option = document.createElement("option"); option.value = value!; option.textContent = label!; align.append(option); }
    popup.append(align);
    align.addEventListener("change", () => {
      if (!isInTable(view.state) || !writable(view, view.state.selection.from)) return;
      const selection = view.state.selection.getBookmark(), index = selectedRect(view.state).left, alignment = align.value as "left" | "center" | "right";
      callCommand(selectColCommand.key, { index })(ctx); callCommand(setAlignCommand.key, alignment)(ctx);
      view.dispatch(view.state.tr.setSelection(selection.resolve(view.state.doc))); view.focus();
    });
    const hint = document.createElement("span"); hint.textContent = "Tab 下一格 · ⌘/Ctrl+Enter 新行"; popup.append(hint);
    const update = () => {
      if (!view.editable || !isInTable(view.state) || !writable(view, view.state.selection.from) || !view.hasFocus() && !popup.contains(document.activeElement)) { hide(); return; }
      const rect = selectedRect(view.state), table = view.nodeDOM(rect.tableStart - 1) as HTMLElement | null;
      if (!table) return;
      popup.hidden = false; if (typeof popup.showPopover === "function" && !popup.matches(":popover-open")) popup.showPopover();
      const bounds = table.getBoundingClientRect(), height = popup.offsetHeight || 38;
      popup.style.left = `${Math.max(12, Math.min(window.innerWidth - popup.offsetWidth - 12, bounds.left))}px`;
      popup.style.top = `${Math.max(12, bounds.top - height - 7)}px`;
      if (document.activeElement !== align) align.value = String(rect.table.child(0).child(rect.left).attrs.alignment ?? "left");
    };
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && !view.dom.contains(event.target as Node)) hide(); };
    const refresh = () => update();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("scroll", refresh, true); window.addEventListener("resize", refresh);
    popup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); view.focus(); } });
    return { update, destroy() { hide(); popup.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", refresh, true); window.removeEventListener("resize", refresh); } };
  } }));
}
