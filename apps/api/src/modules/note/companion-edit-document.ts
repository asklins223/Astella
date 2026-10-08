import * as Y from "yjs";
import { Fragment, Slice, type Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { markdownToBlocks } from "@astella/shared/markdown-parser";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import { noteBlocksToPmNodes, noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import type { CompanionEditNoteV1, CompanionNoteEditingContextV1 } from "@astella/shared/companion-note-authoring-contracts";
import { noteDocSchema, projectFragmentBlocks } from "./doc-fragment.ts";

export class NoteEditConflict extends Error {}
const conflict = () => { throw new NoteEditConflict("要调整的原文或位置已经变化，请重新选择后再试。正文没有被替换。"); };

/** A model edits a verified range of the live document; unrelated nodes retain identity and provenance. */
export function applyCompanionNoteEdit(doc: Y.Doc, input: CompanionEditNoteV1, editing?: CompanionNoteEditingContextV1): void {
  const fragment = doc.getXmlFragment("content"), schema = noteDocSchema();
  const before = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment));
  const blocks = projectFragmentBlocks(doc);
  const starts: number[] = []; before.forEach((_node, pos) => starts.push(pos));
  const verify = (start: number, end: number, expected: readonly string[]) => {
    if (start < 0 || end >= blocks.length || expected.length !== end - start + 1
      || expected.some((text, i) => blocks[start + i]?.content !== text)) conflict();
  };
  const parsed = (markdown: string) => Fragment.fromArray(noteBlocksToPmNodes(markdownToBlocks(markdown)).map(json => schema.nodeFromJSON(json)));
  const content = parsed(input.markdown ?? "");
  let tr = new Transform(before);
  if (input.operation === "append") {
    tr = tr.insert(before.content.size, content);
  } else if (input.operation.endsWith("blocks")) {
    const first = input.startBlock!, last = input.endBlock!;
    verify(first, last, input.expectedBlocks!);
    tr = tr.replaceWith(starts[first]!, starts[last]! + before.child(last).nodeSize, content);
  } else if (input.operation === "insert_at_cursor") {
    const cursor = editing?.cursor;
    if (!cursor) throw new NoteEditConflict("这轮没有笔记光标。先点一下正文里的插入位置，再发送要求。");
    verify(cursor.block, cursor.block, [cursor.expectedBlock]);
    const node = before.child(cursor.block);
    if (cursor.coordinate === "source") {
      const source = cursor.sourceText ?? noteBlockMarkdown(blocks[cursor.block]!.type, cursor.expectedBlock);
      if (cursor.offset > source.length) conflict();
      const next = parsed(source.slice(0, cursor.offset) + input.markdown + source.slice(cursor.offset));
      tr = tr.replaceWith(starts[cursor.block]!, starts[cursor.block]! + node.nodeSize, next);
    } else {
      const offset = cursor.coordinate === "reading" ? readingPosition(node, blocks[cursor.block]!, cursor.offset) : cursor.offset + 1;
      const position = starts[cursor.block]! + offset;
      if (offset < 1 || offset > node.nodeSize - 1 || !before.resolve(position).parent.inlineContent) conflict();
      tr = insertContent(tr, position, position, content);
    }
  } else {
    const selection = editing?.selection;
    if (!selection) throw new NoteEditConflict("这轮没有可核对的选区。重新选中原文后再发送要求。");
    verify(selection.startBlock, selection.endBlock, selection.expectedBlocks);
    const a = blocks[selection.startBlock]!, b = blocks[selection.endBlock]!;
    const from = starts[selection.startBlock]! + readingPosition(before.child(selection.startBlock), a, selection.startOffset);
    const to = starts[selection.endBlock]! + readingPosition(before.child(selection.endBlock), b, selection.endOffset);
    const excerpt = blocks.slice(selection.startBlock, selection.endBlock + 1).map((block, i, all) => {
      const text = noteBlockRenderedTextV1(block.type, block.content);
      return text.slice(i === 0 ? selection.startOffset : 0, i === all.length - 1 ? selection.endOffset : undefined);
    }).join("\n\n");
    if (excerpt !== selection.excerpt || to <= from) conflict();
    tr = input.operation === "delete_selection" ? tr.deleteRange(from, to) : insertContent(tr, from, to, content);
  }
  const next = tr.doc;
  if (next.eq(before)) throw new NoteEditConflict("这次要求没有改变正文。");
  next.check();
  // updateYFragment emits only changed CRDT items, preserving concurrent work elsewhere.
  doc.transact(() => updateYFragment(doc, fragment, next, { mapping: new Map(), isOMark: new Map() }), "companion-edit");
}

function insertContent(tr: Transform, from: number, to: number, content: Fragment): Transform {
  const node = content.childCount === 1 ? content.firstChild : null;
  if (node?.type.name === "paragraph") return tr.replaceWith(from, to, node.content);
  return tr.replaceRange(from, to, new Slice(content, 0, 0));
}

/** Match rendered text atoms to PM positions; structural newlines are never counted as editable text. */
function readingPosition(node: Node, block: { type: string; content: string }, offset: number): number {
  const text = noteBlockRenderedTextV1(block.type, block.content);
  if (offset < 0 || offset > text.length) return conflict();
  let consumed = 0, position: number | null = null, last = 1;
  node.descendants((child, pos) => {
    if (!child.isText) return;
    const start = text.indexOf(child.text!, consumed);
    if (start < 0) return conflict();
    const end = start + child.text!.length;
    if (position === null && offset >= start && offset <= end) position = pos + 1 + offset - start;
    consumed = end; last = pos + 1 + child.nodeSize;
  });
  if (position !== null) return position;
  if (!text && offset === 0) return 1;
  if (offset === text.length) return last;
  return conflict();
}
