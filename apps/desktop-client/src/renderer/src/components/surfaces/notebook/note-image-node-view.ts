import type { RefObject } from "react";
import { $prose } from "@milkdown/kit/utils";
import { DOMSerializer, type Node } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { sourceImageObjectKeyFromUrl } from "@astella/shared/source-image-contracts";
import { noteImageHtmlAttrs, noteImageSize } from "@astella/shared/note-markdown";
import { yUndoPluginKey } from "y-prosemirror";
import { loadSourceImageBlobUrl } from "../source/source-image";
import { noteAiLockKey } from "./note-ai-lock";
import { canJoinImage, imageRow, imageRowDecorations, joinImage, splitImageRow, resizeImageRow } from "./note-image-layout";
import type { NoteImageUploadView } from "./note-image-uploads";

type Uploads = ReadonlyMap<string, NoteImageUploadView>;
export const noteImageUploadsKey = new PluginKey<Uploads>("NOTE_IMAGE_UPLOAD_STATES");

/** Image content stays inline. Its property popover never participates in document layout or selection. */
export function createNoteImageNodeView(initialNode: Node, onZoom: (src: string, alt: string) => void, view: EditorView, getPos: () => number | undefined): NodeView & { refreshUpload: (uploads: Uploads) => void } {
  const asImage = (candidate: Node) => candidate.type.name === "image" ? candidate : candidate.type.name === "html"
    ? (() => { const attrs = noteImageHtmlAttrs(String(candidate.attrs.value ?? "")); return attrs ? view.state.schema.nodes.image!.create(attrs) : null; })() : null;
  let node = asImage(initialNode)!;
  let shown: string | null = null, disposed = false, selected = false;
  let uploads: Uploads = new Map(), retryTimer: ReturnType<typeof setTimeout> | null = null;
  let frameRequest = 0;
  let drag: { id: number; x: number; width: number; next: number; max: number; row?: { available: number; otherWeight: number } } | null = null;
  const dom = document.createElement("span"); dom.className = "note-image-node"; dom.contentEditable = "false";
  const frame = document.createElement("span"); frame.className = "note-image-node__frame";
  const image = document.createElement("img"); image.className = "note-image-node__image"; image.draggable = false;
  const placeholder = document.createElement("span"); placeholder.className = "note-image-node__placeholder"; placeholder.setAttribute("role", "status");
  const name = document.createElement("span"); name.className = "note-image-node__name";
  const badge = document.createElement("span"); badge.className = "note-image-node__badge"; placeholder.append(name, badge);
  const resize = document.createElement("button"); resize.type = "button"; resize.className = "note-image-node__resize";
  resize.setAttribute("role", "slider"); resize.setAttribute("aria-label", "调整图片宽度"); resize.setAttribute("aria-valuemin", "64"); resize.setAttribute("aria-valuemax", "4096"); resize.title = "拖动调整宽度；方向键微调"; resize.hidden = true;
  frame.append(image, placeholder, resize); dom.append(frame);

  const popup = document.createElement("div"); popup.className = "note-image-properties"; popup.popover = "manual";
  popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "图片属性"); popup.dataset.noteEditorUi = "";
  popup.hidden = true; document.body.append(popup);
  const field = (label: string, type = "text") => {
    const wrapper = document.createElement("label"); wrapper.textContent = label;
    const input = document.createElement("input"); input.type = type; input.maxLength = 2000; wrapper.append(input); popup.append(wrapper); return input;
  };
  const srcInput = field("图片地址"), altInput = field("图片说明"), widthInput = field("宽度（px）", "number");
  widthInput.min = "64"; widthInput.max = "4096"; widthInput.step = "8"; widthInput.placeholder = "自动";
  const actions = document.createElement("div"); actions.className = "note-image-properties__actions"; popup.append(actions);
  const menu = document.createElement("details"); menu.className = "note-image-properties__menu";
  const summary = document.createElement("summary"); summary.textContent = "图片选项"; menu.append(summary);
  const menuItems = document.createElement("div"); menuItems.className = "note-image-properties__menu-items"; menu.append(menuItems); actions.append(menu);
  const current = () => { const pos = getPos(); const raw = pos === undefined ? null : view.state.doc.nodeAt(pos); return pos === undefined || !raw ? null : { pos, node: asImage(raw) }; };
  const editable = () => { const pos = getPos(); return view.editable && pos !== undefined && !(noteAiLockKey.getState(view.state) ?? []).some(lock => pos >= lock.from && pos < lock.to); };
  const commit = (attrs: Record<string, unknown>) => {
    const at = current(); if (!editable() || !at?.node) return;
    if (Object.entries(attrs).every(([key, value]) => at.node!.attrs[key] === value)) return;
    const tr = typeof attrs.width === "number" ? resizeImageRow(view, at.pos, attrs.width) ?? view.state.tr.setNodeMarkup(at.pos, view.state.schema.nodes.image, { ...at.node.attrs, ...attrs })
      : view.state.tr.setNodeMarkup(at.pos, view.state.schema.nodes.image, { ...at.node.attrs, ...attrs });
    yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at.pos)));
    yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
  };
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const control = document.createElement("button"); control.type = "button"; control.textContent = label;
    control.addEventListener("mousedown", event => event.preventDefault());
    control.addEventListener("click", event => { event.stopPropagation(); action(); menu.open = false; }); parent.append(control); return control;
  };
  const zoomButton = button(actions, "查看原图", () => { hidePopup(); onZoom(image.src, image.alt); });
  for (const percent of [25, 50, 75, 100]) button(menuItems, `${percent}% 宽度`, () => commit({ width: Math.round((dom.parentElement?.clientWidth ?? 640) * percent / 100), height: null }));
  button(menuItems, "恢复原尺寸", () => commit({ width: null, height: null }));
  const joinPrevious = button(menuItems, "与前图放在同一段", () => { const pos = getPos(); if (pos !== undefined) joinImage(view, pos, -1); });
  const joinNext = button(menuItems, "与后图放在同一段", () => { const pos = getPos(); if (pos !== undefined) joinImage(view, pos, 1); });
  const split = button(menuItems, "每张图片另起一段", () => { const pos = getPos(); if (pos !== undefined) splitImageRow(view, pos); });
  button(menuItems, "移除图片", () => { const at = current(); if (editable() && at?.node) { hidePopup(); view.dispatch(view.state.tr.delete(at.pos, at.pos + at.node.nodeSize)); view.focus(); } });

  function hidePopup() { popup.hidden = true; if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover(); menu.open = false; }
  function positionPopup() {
    if (!selected || popup.hidden || disposed || drag) return;
    const bounds = frame.getBoundingClientRect();
    if (!bounds.width) return;
    if (bounds.bottom < 0 || bounds.top > window.innerHeight) { hidePopup(); return; }
    const width = Math.min(420, window.innerWidth - 24); popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, bounds.left + (bounds.width - width) / 2))}px`;
    const height = popup.getBoundingClientRect().height || 156;
    const below = bounds.bottom + 10;
    popup.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, below + height < window.innerHeight ? below : bounds.top - height - 10))}px`;
  }
  const schedulePosition = () => { if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; positionPopup(); }); };
  function showPopup() {
    if (!editable() || drag) return;
    popup.hidden = false;
    if (typeof popup.showPopover === "function" && !popup.matches(":popover-open")) popup.showPopover();
    refreshFields(); positionPopup();
  }
  function refreshFields() {
    const pending = String(node.attrs.src).startsWith("uploading:");
    srcInput.disabled = pending; widthInput.disabled = dom.dataset.state !== "ready";
    for (const [input, value] of [[srcInput, String(node.attrs.src ?? "")], [altInput, String(node.attrs.alt === "上传中…" ? "" : node.attrs.alt ?? "")], [widthInput, String(noteImageSize(node.attrs.width) ?? "")]] as const) {
      if (document.activeElement !== input) input.value = value;
    }
    zoomButton.disabled = dom.dataset.state !== "ready";
    const pos = getPos();
    joinPrevious.hidden = pos === undefined || !canJoinImage(view, pos, -1);
    joinNext.hidden = pos === undefined || !canJoinImage(view, pos, 1);
    split.hidden = pos === undefined || !imageRow(view.state.doc.resolve(pos).parent);
  }
  const applyField = (input: HTMLInputElement) => {
    if (!editable() || input.disabled) return;
    if (input === srcInput) {
      const src = input.value.trim();
      const valid = Boolean(src) && (/^https?:\/\//i.test(src) || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src));
      input.setAttribute("aria-invalid", String(!valid)); if (valid) commit({ src });
    } else if (input === altInput) commit({ alt: input.value });
    else { const width = noteImageSize(input.value); if (!input.value || width && width >= 64) commit({ width, height: null }); }
  };
  for (const input of [srcInput, altInput, widthInput]) {
    input.addEventListener("blur", () => applyField(input));
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); applyField(input); hidePopup(); view.focus(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hidePopup(); view.focus(); }
    });
  }
  const outside = (event: PointerEvent) => {
    if (!popup.contains(event.target as globalThis.Node) && !dom.contains(event.target as globalThis.Node)) {
      if (document.activeElement instanceof HTMLInputElement && popup.contains(document.activeElement)) applyField(document.activeElement);
      hidePopup();
    }
  };
  const escapePopup = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || popup.hidden) return;
    event.preventDefault(); event.stopPropagation(); hidePopup(); view.focus();
  };
  document.addEventListener("keydown", escapePopup, true);
  document.addEventListener("pointerdown", outside, true); document.addEventListener("scroll", schedulePosition, true); window.addEventListener("resize", schedulePosition);
  const size = () => {
    const width = noteImageSize(node.attrs.width); frame.style.width = width ? `${width}px` : "";
    dom.style.setProperty("--note-image-width", String(width ?? 320)); image.title = String(node.attrs.title ?? "");
    resize.hidden = !selected || !editable() || dom.dataset.state !== "ready";
    resize.setAttribute("aria-valuenow", String(width ?? (Math.round(frame.getBoundingClientRect().width) || 1)));
    refreshFields(); schedulePosition();
  };
  const select = () => { const at = current(); if (!at?.node) return; view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos))); view.focus(); showPopup(); };
  function finishDrag(apply: boolean) {
    if (!drag) return; const { next, id } = drag; drag = null;
    if (resize.hasPointerCapture?.(id)) resize.releasePointerCapture(id);
    if (apply) commit({ width: next, height: null }); size();
  }
  resize.addEventListener("pointerdown", event => {
    if (!editable() || event.button !== 0) return;
    event.preventDefault(); select(); hidePopup();
    const width = frame.getBoundingClientRect().width;
    drag = { id: event.pointerId, x: event.clientX, width, next: Math.round(width), max: dom.parentElement?.clientWidth || 4096 };
    if (dom.dataset.inRow === "true") {
      const siblings = Array.from(dom.parentElement!.querySelectorAll<HTMLElement>(".note-image-node"));
      drag.row = { available: siblings.reduce((sum, item) => sum + (item.querySelector<HTMLElement>(".note-image-node__frame")?.getBoundingClientRect().width ?? 0), 0),
        otherWeight: siblings.filter(item => item !== dom).reduce((sum, item) => sum + (Number(item.style.getPropertyValue("--note-image-width")) || 320), 0) };
      drag.max = drag.row.available - 64 * (siblings.length - 1);
    }
    resize.setPointerCapture(event.pointerId); resize.focus({ preventScroll: true });
  });
  resize.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.next = Math.round(Math.max(64, Math.min(drag.max, drag.width + (drag.row ? 1 : 2) * (event.clientX - drag.x))));
    frame.style.width = `${drag.next}px`; resize.setAttribute("aria-valuenow", String(drag.next));
    dom.style.setProperty("--note-image-width", String(drag.row ? drag.next * drag.row.otherWeight / Math.max(1, drag.row.available - drag.next) : drag.next));
  });
  resize.addEventListener("pointerup", () => finishDrag(true)); resize.addEventListener("pointercancel", () => finishDrag(false)); resize.addEventListener("lostpointercapture", () => finishDrag(false));
  resize.addEventListener("click", event => { event.stopPropagation(); resize.focus({ preventScroll: true }); });
  resize.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) { event.preventDefault(); event.stopPropagation(); finishDrag(false); return; }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const max = dom.parentElement?.clientWidth || 4096, width = frame.getBoundingClientRect().width || noteImageSize(node.attrs.width) || 320;
    commit({ width: event.key === "Home" ? 64 : event.key === "End" ? max : Math.max(64, Math.min(max, width + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 32 : 8))), height: null });
  });
  const pending = (state: string, label: string, fileName: string) => {
    dom.dataset.state = state; dom.setAttribute("aria-busy", String(state === "uploading" || state === "loading"));
    image.hidden = true; placeholder.hidden = false; name.textContent = fileName; badge.textContent = label; size();
  };
  const refreshUpload = (next: Uploads) => {
    uploads = next; const pos = getPos(); dom.dataset.inRow = String(pos !== undefined && imageRow(view.state.doc.resolve(pos).parent));
    if (!editable()) hidePopup(); refreshFields(); size();
    const src = String(node.attrs.src ?? ""); if (!src.startsWith("uploading:")) return;
    const upload = uploads.get(src.slice("uploading:".length));
    if (!upload) { pending("unavailable", "上传已中断，请重新插入", "图片"); return; }
    pending(upload.status === "failed" ? "failed" : "uploading", upload.status === "failed" ? "上传未成功，可重试" : upload.status === "queued" ? "图片排队中…" : "图片上传中…", upload.name || "图片");
    if (upload.previewUrl) { image.src = upload.previewUrl; image.hidden = false; dom.dataset.preview = "true"; }
  };
  const ready = () => { dom.dataset.state = "ready"; dom.setAttribute("aria-busy", "false"); image.hidden = false; placeholder.hidden = true; size(); };
  image.addEventListener("load", () => { if (!disposed && image.getAttribute("src") && !String(node.attrs.src).startsWith("uploading:")) ready(); });
  image.addEventListener("error", () => { if (!disposed) pending("unavailable", "图片暂时无法显示", image.alt || "图片"); });
  frame.addEventListener("click", event => { if (event.target === resize) return; event.stopPropagation(); if (view.editable) select(); else if (dom.dataset.state === "ready") onZoom(image.src, image.alt); });
  frame.addEventListener("dblclick", () => { if (dom.dataset.state === "ready") { hidePopup(); onZoom(image.src, image.alt); } });
  frame.addEventListener("contextmenu", event => { if (!editable()) return; event.preventDefault(); select(); menu.open = true; positionPopup(); });
  const show = (src: string, alt: string, attempt = 0) => {
    image.alt = alt; size(); if (src === shown && attempt === 0) { refreshUpload(uploads); return; }
    shown = src; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    image.removeAttribute("src"); delete dom.dataset.preview;
    if (src.startsWith("uploading:")) { refreshUpload(uploads); return; }
    pending("loading", "正在载入图片…", alt || "图片");
    const objectKey = sourceImageObjectKeyFromUrl(src);
    if (!objectKey) { if (src) image.src = src; else pending("unavailable", "图片暂时无法显示", alt || "图片"); return; }
    void loadSourceImageBlobUrl(objectKey).then(blobUrl => {
      if (disposed || shown !== src) return;
      if (blobUrl) { image.src = blobUrl; return; }
      if (attempt >= 2) { pending("unavailable", "图片暂时无法显示", alt || "图片"); return; }
      retryTimer = setTimeout(() => { if (!disposed && shown === src) show(src, alt, attempt + 1); }, 1200 * (attempt + 1));
    });
  };
  show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? ""));
  return {
    dom, refreshUpload,
    update(next) { const parsed = asImage(next); if (!parsed) return false; node = parsed; show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? "")); return true; },
    selectNode() { selected = true; dom.classList.add("ProseMirror-selectednode"); size(); showPopup(); },
    deselectNode() { selected = false; dom.classList.remove("ProseMirror-selectednode"); hidePopup(); finishDrag(false); size(); },
    stopEvent: event => event.target === resize || event.type === "click" || event.type === "dblclick" || event.type === "contextmenu",
    ignoreMutation: () => true,
    destroy() { disposed = true; finishDrag(false); hidePopup(); popup.remove(); if (retryTimer) clearTimeout(retryTimer); if (frameRequest) cancelAnimationFrame(frameRequest); document.removeEventListener("keydown", escapePopup, true); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", schedulePosition, true); window.removeEventListener("resize", schedulePosition); },
  };
}

export function noteImageViewPlugin(onZoom: RefObject<((src: string, alt: string) => void) | undefined>) {
  return $prose(() => {
    const views = new Set<ReturnType<typeof createNoteImageNodeView>>();
    const create = (node: Node, view: EditorView, getPos: () => number | undefined) => {
      const leaf = createNoteImageNodeView(node, (src, alt) => onZoom.current?.(src, alt), view, getPos);
      leaf.refreshUpload(noteImageUploadsKey.getState(view.state) ?? new Map()); views.add(leaf);
      return { ...leaf, destroy() { views.delete(leaf); leaf.destroy?.(); } };
    };
    return new Plugin<Uploads>({ key: noteImageUploadsKey,
      state: { init: () => new Map(), apply: (tr, previous) => { const next = tr.getMeta(noteImageUploadsKey) as readonly NoteImageUploadView[] | undefined; return next ? new Map(next.map(upload => [upload.id, upload])) : previous; } },
      props: { decorations: state => imageRowDecorations(state.doc), nodeViews: {
        image: create,
        html(node, view, getPos) { return noteImageHtmlAttrs(String(node.attrs.value ?? "")) ? create(node, view, getPos) : { dom: DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node)).dom as HTMLElement }; },
      } },
      view: () => ({ update(view) { const next = noteImageUploadsKey.getState(view.state); if (next) views.forEach(leaf => leaf.refreshUpload(next)); } }),
    });
  });
}
