import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";

type SourceCache = { readonly text: string; readonly document: string };
export const NOTE_SOURCE_INPUT_ORIGIN = Symbol("note-source-input");

/** Provenance defaults can be filled by Yjs after parsing; they do not change Markdown. */
export function noteSourceSignature(node: ProseNode): string {
  type ContentJSON = { attrs?: Record<string, unknown>; content?: ContentJSON[] };
  const json = node.toJSON();
  const strip = (value: ContentJSON) => {
    if (value.attrs) {
      delete value.attrs.sourceRef;
      delete value.attrs.imageAssetId;
      if (value.attrs.title === "") value.attrs.title = null;
      if (value.attrs.alignment === null) value.attrs.alignment = "left";
      if (!Object.keys(value.attrs).length) delete value.attrs;
    }
    value.content?.forEach(strip);
  };
  strip(json);
  return JSON.stringify(json);
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
  const position = view.state.selection.from;
  let start = 0;
  let block = 0;
  for (; block < view.state.doc.childCount - 1; block += 1) {
    const size = view.state.doc.child(block).nodeSize;
    if (start + size >= position) break;
    start += size;
  }
  return { block, offset: Math.max(0, position - start - 1) };
}
