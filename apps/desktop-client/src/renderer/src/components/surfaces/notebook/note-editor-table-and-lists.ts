import { $prose, callCommand } from "@milkdown/kit/utils";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { goToNextCell, isInTable, selectedRect, TableMap, deleteRow, deleteColumn, deleteTable } from "@milkdown/kit/prose/tables";
import { addRowAfterCommand, addRowBeforeCommand, addColAfterCommand, addColBeforeCommand, setAlignCommand, selectColCommand, selectRowCommand, selectTableCommand, moveRowCommand, moveColCommand } from "@milkdown/kit/preset/gfm";
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
      button.addEventListener("click", () => { if (isInTable(view.state) && writable(view, view.state.selection.from)) { const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing(); run(); undo?.stopCapturing(); } menu.open = false; view.focus(); }); items.append(button);
    };
    button("在上方插入行", () => callCommand(addRowBeforeCommand.key)(ctx));
    button("在下方插入行", () => callCommand(addRowAfterCommand.key)(ctx));
    button("在左侧插入列", () => callCommand(addColBeforeCommand.key)(ctx));
    button("在右侧插入列", () => callCommand(addColAfterCommand.key)(ctx));
    button("删除当前行", () => {
      const rect = selectedRect(view.state);
      if (rect.top > 0) { deleteRow(view.state, view.dispatch); return; }
      if (rect.bottom >= rect.table.childCount) { deleteTable(view.state, view.dispatch); return; }
      // Milkdown requires a distinct header row. Promote the next surviving row atomically.
      const remaining = Array.from({ length: rect.table.childCount - rect.bottom }, (_, index) => rect.table.child(rect.bottom + index));
      const header = remaining[0]!, cells = Array.from({ length: header.childCount }, (_, index) => { const cell = header.child(index); return view.state.schema.nodes.table_header!.create(cell.attrs, cell.content); });
      const content = [view.state.schema.nodes.table_header_row!.create(header.attrs, cells), ...remaining.slice(1)];
      if (content.length === 1) content.push(view.state.schema.nodes.table_row!.create(undefined, cells.map(cell => view.state.schema.nodes.table_cell!.createAndFill(cell.attrs)!)));
      const replacement = rect.table.type.create(rect.table.attrs, content), pos = rect.tableStart - 1, tr = view.state.tr.replaceWith(pos, pos + rect.table.nodeSize, replacement);
      view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3))));
    });
    button("删除当前列", () => { deleteColumn(view.state, view.dispatch); });
    for (const [label, axis, delta] of [["上移当前行", "row", -1], ["下移当前行", "row", 1], ["左移当前列", "column", -1], ["右移当前列", "column", 1]] as const) button(label, () => {
      const rect = selectedRect(view.state), from = axis === "row" ? rect.top : rect.left, to = from + delta;
      if (to < (axis === "row" ? 1 : 0) || to >= (axis === "row" ? rect.map.height : rect.map.width) || axis === "row" && from === 0) return;
      if (axis === "row") callCommand(moveRowCommand.key, { from, to })(ctx); else callCommand(moveColCommand.key, { from, to })(ctx);
    });
    button("选中整行", () => callCommand(selectRowCommand.key, { index: selectedRect(view.state).top })(ctx));
    button("选中整列", () => callCommand(selectColCommand.key, { index: selectedRect(view.state).left })(ctx));
    button("选中整张表", () => callCommand(selectTableCommand.key)(ctx));
    const dimensions = document.createElement("div"); dimensions.className = "note-table-dimensions";
    const count = (name: string) => { const input = document.createElement("input"); input.type = "number"; input.min = "1"; input.max = "100"; input.setAttribute("aria-label", name); const label = document.createElement("label"); label.append(name, input); dimensions.append(label); return input; };
    const rows = count("正文行数"), columns = count("列数"); items.append(dimensions);
    button("应用表格大小", () => {
      const rect = selectedRect(view.state), height = Math.min(100, Math.max(1, Math.floor(Number(rows.value) || 1))) + 1, width = Math.min(100, Math.max(1, Math.floor(Number(columns.value) || 1)));
      const content = Array.from({ length: height }, (_, row) => {
        const previous = row < rect.table.childCount ? rect.table.child(row) : null, type = view.state.schema.nodes[row ? "table_row" : "table_header_row"]!;
        return type.create(previous?.attrs, Array.from({ length: width }, (_, col) => previous && col < previous.childCount ? previous.child(col) : view.state.schema.nodes[row ? "table_cell" : "table_header"]!.createAndFill()!));
      });
      const replacement = rect.table.type.create(rect.table.attrs, content), pos = rect.tableStart - 1, undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing();
      const tr = view.state.tr.replaceWith(pos, pos + rect.table.nodeSize, replacement); view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 3)))); undo?.stopCapturing();
    });
    let drag: { axis: "row" | "column"; from: number; to: number; pos: number; table: HTMLElement } | null = null;
    const dragListeners: (() => void)[] = [];
    const indicator = document.createElement("div"); indicator.className = "note-table-drop-indicator"; indicator.hidden = true; document.body.append(indicator);
    for (const axis of ["row", "column"] as const) {
      const handle = document.createElement("button"); handle.type = "button"; handle.textContent = axis === "row" ? "↕ 行" : "↔ 列"; handle.setAttribute("aria-label", axis === "row" ? "拖动当前行" : "拖动当前列"); popup.append(handle);
      handle.addEventListener("pointerdown", event => { if (event.button !== 0 || !isInTable(view.state) || !writable(view, view.state.selection.from)) return;
        const rect = selectedRect(view.state), table = view.nodeDOM(rect.tableStart - 1) as HTMLElement; const from = axis === "row" ? rect.top : rect.left;
        if (axis === "row" && from === 0) return; event.preventDefault(); drag = { axis, from, to: from, pos: view.state.selection.from, table }; handle.setPointerCapture(event.pointerId);
      });
      const movePointer = (event: PointerEvent) => { if (!drag || drag.axis !== axis) return;
        const candidates = axis === "row" ? [...drag.table.querySelectorAll("tr")].slice(1) : [...drag.table.querySelectorAll("tr:first-child th")];
        let distance = Infinity; candidates.forEach((cell, index) => { const bounds = cell.getBoundingClientRect(), d = Math.abs((axis === "row" ? event.clientY : event.clientX) - (axis === "row" ? bounds.top + bounds.height / 2 : bounds.left + bounds.width / 2));
          if (d >= distance) return; distance = d; drag!.to = index + (axis === "row" ? 1 : 0);
          const tableBounds = drag!.table.getBoundingClientRect(); indicator.hidden = false; Object.assign(indicator.style, axis === "row" ? { left: `${tableBounds.left}px`, top: `${bounds.top}px`, width: `${tableBounds.width}px`, height: "3px" } : { left: `${bounds.left}px`, top: `${tableBounds.top}px`, width: "3px", height: `${tableBounds.height}px` });
        });
      };
      handle.addEventListener("pointermove", movePointer);
      const cancel = () => { drag = null; indicator.hidden = true; };
      const finish = (event: PointerEvent) => { if (!drag || drag.axis !== axis) return; // The last move can be coalesced; the release point is authoritative.
        movePointer(event); const move = drag; cancel(); if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        if (move && move.from !== move.to && writable(view, move.pos)) {
          const undo = yUndoPluginKey.getState(view.state)?.undoManager; undo?.stopCapturing();
          callCommand(axis === "row" ? moveRowCommand.key : moveColCommand.key, { from: move.from, to: move.to, pos: move.pos })(ctx); undo?.stopCapturing();
        } view.focus();
      };
      document.addEventListener("pointerup", finish, true); window.addEventListener("blur", cancel);
      dragListeners.push(() => { document.removeEventListener("pointerup", finish, true); window.removeEventListener("blur", cancel); });
      handle.addEventListener("pointercancel", cancel); handle.addEventListener("keydown", event => { if (event.key === "Escape" && drag) { event.stopPropagation(); event.preventDefault(); cancel(); } });
    }
    button("删除表格", () => { hide(); deleteTable(view.state, view.dispatch); });
    const align = document.createElement("div"); align.className = "note-table-alignment"; align.setAttribute("aria-label", "当前列对齐");
    for (const [alignment, label] of [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]] as const) {
      const choice = document.createElement("button"); choice.type = "button"; choice.textContent = label; choice.dataset.alignment = alignment;
      choice.addEventListener("mousedown", event => event.preventDefault()); choice.addEventListener("click", () => {
        if (!isInTable(view.state) || !writable(view, view.state.selection.from)) return;
        const selection = view.state.selection.getBookmark(), index = selectedRect(view.state).left;
        callCommand(selectColCommand.key, { index })(ctx); callCommand(setAlignCommand.key, alignment)(ctx);
        view.dispatch(view.state.tr.setSelection(selection.resolve(view.state.doc))); view.focus();
      }); align.append(choice);
    }
    popup.append(align);
    const hint = document.createElement("span"); hint.textContent = "Tab 下一格 · ⌘/Ctrl+Enter 新行"; popup.append(hint);
    const update = () => {
      if (!view.editable || !isInTable(view.state) || !writable(view, view.state.selection.from) || !view.hasFocus() && !popup.contains(document.activeElement)) { hide(); return; }
      const rect = selectedRect(view.state), table = view.nodeDOM(rect.tableStart - 1) as HTMLElement | null;
      if (!table) return;
      popup.hidden = false; if (typeof popup.showPopover === "function" && !popup.matches(":popover-open")) popup.showPopover();
      if (!dimensions.contains(document.activeElement)) { rows.value = String(rect.map.height - 1); columns.value = String(rect.map.width); }
      const bounds = table.getBoundingClientRect(), height = popup.offsetHeight || 38;
      popup.style.left = `${Math.max(12, Math.min(window.innerWidth - popup.offsetWidth - 12, bounds.left))}px`;
      popup.style.top = `${Math.max(12, bounds.top - height - 7)}px`;
      for (const choice of align.querySelectorAll("button")) choice.setAttribute("aria-pressed", String(choice.dataset.alignment === (rect.table.firstChild?.maybeChild(rect.left)?.attrs.alignment ?? "left")));
    };
    const outside = (event: PointerEvent) => { if (!popup.contains(event.target as Node) && !view.dom.contains(event.target as Node)) hide(); };
    const refresh = () => update();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("scroll", refresh, true); window.addEventListener("resize", refresh);
    popup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); view.focus(); } });
    return { update, destroy() { hide(); dragListeners.forEach(remove => remove()); popup.remove(); indicator.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", refresh, true); window.removeEventListener("resize", refresh); } };
  } }));
}
