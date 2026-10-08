import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";

type SourceCache = { readonly text: string; readonly document: string };
export const NOTE_SOURCE_INPUT_ORIGIN = Symbol("note-source-input");

/** Provenance defaults can be filled by Yjs after parsing; they do not change Markdown. */
export function noteSourceSignature(node: ProseNode): string {
  type ContentJSON = { type?: string; attrs?: Record<string, unknown>; content?: ContentJSON[] };
  // ProseMirror's toJSON reuses node.attrs. Strip provenance only on a copy;
  // mutating that object silently erases the live document's source anchors.
  const json = structuredClone(node.toJSON());
  const strip = (value: ContentJSON) => {
    if (value.attrs) {
      delete value.attrs.sourceRef;
      delete value.attrs.imageAssetId;
      // Milkdown fills this DOM anchor after rendering, while the Markdown
      // parser leaves it empty. It is derived from the heading's text.
      if (value.type === "heading") delete value.attrs.id;
      if (value.attrs.title === "") value.attrs.title = null;
      if (value.attrs.alignment === null) value.attrs.alignment = "left";
      if (!Object.keys(value.attrs).length) delete value.attrs;
    }
    value.content?.forEach(strip);
  };
  strip(json);
  // Server-seeded and parsed nodes can have the same attributes in different
  // insertion orders. Object order must not make an unchanged block lose its source.
  return JSON.stringify(json, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value);
}

/** A source view cache is usable only for this exact document. It is never replayed into it. */
export function readNoteSource(
  view: EditorView,
  serialize: (doc: ProseNode) => string,
  cache: SourceCache | undefined,
): string {
  return typeof cache?.text === "string" && cache.document === noteSourceSignature(view.state.doc) ? cache.text : serialize(view.state.doc);
}

function sameContent(a: ProseNode, b: ProseNode): boolean {
  return noteSourceSignature(a) === noteSourceSignature(b);
}

/** Reuse unchanged nodes, including their provenance, instead of reconstructing the note. */
export function preserveNoteNodes(previous: ProseNode, parsed: ProseNode): ProseNode {
  const oldNodes: ProseNode[] = [];
  const newNodes: ProseNode[] = [];
  previous.forEach((node) => oldNodes.push(node));
  parsed.forEach((node) => newNodes.push(node));
  let first = 0;
  while (first < Math.min(oldNodes.length, newNodes.length) && sameContent(oldNodes[first]!, newNodes[first]!)) {
    newNodes[first] = oldNodes[first]!;
    first += 1;
  }
  let lastOld = oldNodes.length - 1;
  let lastNew = newNodes.length - 1;
  while (lastOld >= first && lastNew >= first && sameContent(oldNodes[lastOld]!, newNodes[lastNew]!)) {
    newNodes[lastNew] = oldNodes[lastOld]!;
    lastOld -= 1;
    lastNew -= 1;
  }
  // A paste can change several separated blocks. Unchanged blocks between them
  // still have their own evidence; reuse only signatures that are unique on both
  // sides so repeated paragraphs never borrow another paragraph's provenance.
  const originals = new Map<string, ProseNode | null>();
  for (const node of oldNodes) {
    const signature = noteSourceSignature(node);
    originals.set(signature, originals.has(signature) ? null : node);
  }
  const signatures = newNodes.map(noteSourceSignature);
  const counts = new Map<string, number>();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  for (let index = first; index <= lastNew; index += 1) {
    const signature = signatures[index]!;
    const original = originals.get(signature);
    if (original && counts.get(signature) === 1) newNodes[index] = original;
  }
  // Only a single, same-type edited block can inherit its old provenance.
  // Insertions and deletions must not move someone else's source to a new block.
  if (lastOld === first && lastNew === first && oldNodes[first]?.type === newNodes[first]?.type) {
    const node = newNodes[first]!;
    newNodes[first] = node.type.create({ ...node.attrs,
      sourceRef: oldNodes[first]!.attrs.sourceRef ?? null,
      imageAssetId: oldNodes[first]!.attrs.imageAssetId ?? null,
    }, node.content, node.marks);
  }
  return parsed.type.create(parsed.attrs, newNodes, parsed.marks);
}

/** Apply the actual changed range to the live PM/Yjs document, never a stale whole-note copy. */
export function applyNoteSource(view: EditorView, parsed: ProseNode): boolean {
  const next = preserveNoteNodes(view.state.doc, parsed);
  const start = view.state.doc.content.findDiffStart(next.content);
  if (start === null) return false;
  const end = view.state.doc.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(end.a, end.b);
  if (overlap > 0) { end.a += overlap; end.b += overlap; }
  view.dispatch(view.state.tr.replace(start, end.a, next.slice(start, end.b)).setMeta("note-source-input", true));
  return true;
}

export type NoteDocumentPosition = { readonly block: number; readonly offset: number };

export function noteCaretPosition(view: EditorView): NoteDocumentPosition {
  let position = view.state.selection.from;
  // Native selection moves before ProseMirror's selection observer runs. A
  // pointer/key release must retain the location actually visible to the user.
  const selection = view.dom.ownerDocument.getSelection();
  if (selection?.isCollapsed && selection.anchorNode && view.dom.contains(selection.anchorNode)) {
    try { position = view.posAtDOM(selection.anchorNode, selection.anchorOffset); } catch { /* Retain the last valid editor selection. */ }
  }
  let start = 0;
  let block = 0;
  for (; block < view.state.doc.childCount - 1; block += 1) {
    const size = view.state.doc.child(block).nodeSize;
    if (start + size >= position) break;
    start += size;
  }
  return { block, offset: Math.max(0, position - start - 1) };
}
