import type { Node } from "@milkdown/kit/prose/model";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import { noteImageHtmlAttrs } from "@astella/shared/note-markdown";
import { noteAiLockKey } from "./note-ai-lock";
import { yUndoPluginKey } from "y-prosemirror";

export const isNoteImage = (node: Node) => node.type.name === "image" || node.type.name === "html" && Boolean(noteImageHtmlAttrs(String(node.attrs.value ?? "")));
export function imageParagraph(node: Node): boolean {
  return node.type.name === "paragraph" && node.childCount > 0 && Array.from({ length: node.childCount }, (_, index) => node.child(index))
    .every(child => isNoteImage(child) || child.isText && !child.text?.trim());
}
export function imageRow(node: Node): boolean {
  return imageParagraph(node) && Array.from({ length: node.childCount }, (_, index) => node.child(index)).filter(isNoteImage).length > 1;
}
export function imageRowDecorations(doc: Node) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => { if (imageParagraph(node)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: imageRow(node) ? "note-image-paragraph note-image-row" : "note-image-paragraph" })); });
  return DecorationSet.create(doc, decorations);
}

/** A single image follows the caret; a batch gets one row between the surrounding prose. */
export function insertNoteImages(view: EditorView, paragraph: Node) {
  if (!view.editable) return;
  let tr = view.state.tr;
  if (tr.selection instanceof NodeSelection && isNoteImage(tr.selection.node)) tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
  const $caret = tr.selection.$from;
  const available = ($caret.depth ? (view.nodeDOM($caret.before()) as HTMLElement | null)?.clientWidth : 0) || view.dom.clientWidth || 640;
  if (imageRow(paragraph) && !imageParagraph($caret.parent)) tr.replaceSelection(new Slice(Fragment.from(paragraph), 0, 0));
  else tr.replaceSelection(new Slice(paragraph.content, 0, 0));
  const inserted = new Set<string>(); paragraph.forEach(node => { if (isNoteImage(node)) inserted.add(String(node.attrs.src)); });
  tr.doc.descendants((parent, pos) => {
    if (!imageRow(parent) || !Array.from({ length: parent.childCount }, (_, index) => parent.child(index)).some(node => inserted.has(String(node.attrs.src)))) return;
    const count = Array.from({ length: parent.childCount }, (_, index) => parent.child(index)).filter(isNoteImage).length;
    const width = Math.max(64, Math.round((available - 12 * (count - 1)) / count));
    parent.forEach((node, offset) => { if (isNoteImage(node)) tr.setNodeMarkup(pos + 1 + offset, undefined, { ...node.attrs, width, height: null }); });
  });
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
  view.dispatch(tr.scrollIntoView()); view.focus();
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
}
const unlocked = (view: EditorView, from: number, to: number) => view.editable && !(noteAiLockKey.getState(view.state) ?? []).some(lock => from < lock.to && to > lock.from);
function location(view: EditorView, pos: number) {
  const $pos = view.state.doc.resolve(pos);
  if ($pos.depth !== 1 || !imageParagraph($pos.parent)) return null;
  return { parent: $pos.parent, index: $pos.index(0), from: $pos.before(1), to: $pos.after(1) };
}
export function canJoinImage(view: EditorView, pos: number, direction: -1 | 1): boolean {
  const at = location(view, pos), other = at && view.state.doc.maybeChild(at.index + direction);
  return Boolean(at && other && imageParagraph(other) && unlocked(view, direction < 0 ? at.from - other.nodeSize : at.from, direction > 0 ? at.to + other.nodeSize : at.to));
}
function imagesWithEvidence(parent: Node, view: EditorView): Node[] {
  const result: Node[] = [];
  parent.forEach(child => {
    if (!isNoteImage(child)) return;
    const attrs = child.type.name === "html" ? noteImageHtmlAttrs(String(child.attrs.value))! : child.attrs;
    result.push(view.state.schema.nodes.image!.create({ ...attrs, sourceRef: attrs.sourceRef ?? parent.attrs.sourceRef, imageAssetId: attrs.imageAssetId ?? parent.attrs.imageAssetId }));
  });
  return result;
}
export function joinImage(view: EditorView, pos: number, direction: -1 | 1) {
  if (!canJoinImage(view, pos, direction)) return;
  const at = location(view, pos)!, other = view.state.doc.child(at.index + direction);
  const before = direction < 0 ? other : at.parent, after = direction < 0 ? at.parent : other;
  const from = direction < 0 ? at.from - other.nodeSize : at.from, to = direction > 0 ? at.to + other.nodeSize : at.to;
  const joined = [...imagesWithEvidence(before, view), ...imagesWithEvidence(after, view)];
  const available = Math.max(64 * joined.length, ((view.nodeDOM(at.from) as HTMLElement | null)?.clientWidth || 640) - 12 * (joined.length - 1));
  const total = joined.reduce((sum, image) => sum + (Number(image.attrs.width) || 320), 0);
  const images = joined.map(image => image.type.create({ ...image.attrs, width: Math.round(available * (Number(image.attrs.width) || 320) / total), height: null }));
  const paragraph = view.state.schema.nodes.paragraph!.create(null, images);
  let ownIndex = 0;
  at.parent.forEach((child, offset) => { if (offset < pos - at.from - 1 && isNoteImage(child)) ownIndex++; });
  const selectedIndex = (direction < 0 ? imagesWithEvidence(other, view).length : 0) + ownIndex;
  const tr = view.state.tr.replaceWith(from, to, paragraph);
  tr.setSelection(NodeSelection.create(tr.doc, from + 1 + selectedIndex));
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
  view.dispatch(tr.scrollIntoView()); view.focus();
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
}
export function splitImageRow(view: EditorView, pos: number) {
  const at = location(view, pos);
  if (!at || !imageRow(at.parent) || !unlocked(view, at.from, at.to)) return;
  const images = imagesWithEvidence(at.parent, view);
  const paragraphs = images.map(image => view.state.schema.nodes.paragraph!.create({ sourceRef: image.attrs.sourceRef, imageAssetId: image.attrs.imageAssetId }, image));
  const tr = view.state.tr.replaceWith(at.from, at.to, Fragment.fromArray(paragraphs));
  tr.setSelection(NodeSelection.create(tr.doc, at.from + 1));
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
  view.dispatch(tr.scrollIntoView()); view.focus();
  yUndoPluginKey.getState(view.state)?.undoManager?.stopCapturing();
}

/** Persist the displayed proportions together, so resizing one member gives room to its neighbours. */
export function resizeImageRow(view: EditorView, pos: number, requested: number) {
  const $pos = view.state.doc.resolve(pos);
  if (!imageRow($pos.parent)) return null;
  const entries: { node: Node; pos: number; width: number }[] = [];
  $pos.parent.forEach((node, offset) => {
    if (!isNoteImage(node)) return;
    const at = $pos.start() + offset;
    const dom = view.nodeDOM(at) as HTMLElement | null;
    entries.push({ node, pos: at, width: dom?.querySelector<HTMLElement>(".note-image-node__frame")?.getBoundingClientRect().width || Number(node.attrs.width) || 320 });
  });
  const total = entries.reduce((sum, entry) => sum + entry.width, 0);
  const width = Math.max(64, Math.min(total - 64 * (entries.length - 1), requested));
  const others = entries.filter(entry => entry.pos !== pos), otherTotal = others.reduce((sum, entry) => sum + entry.width, 0);
  const tr = view.state.tr;
  for (const entry of entries) {
    const attrs = entry.node.type.name === "image" ? entry.node.attrs : noteImageHtmlAttrs(String(entry.node.attrs.value))!;
    tr.setNodeMarkup(entry.pos, view.state.schema.nodes.image, { ...attrs, width: Math.round(entry.pos === pos ? width : (total - width) * entry.width / otherTotal), height: null });
  }
  return tr;
}
