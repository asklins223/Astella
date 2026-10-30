import { Fragment, Slice, Schema, type Node } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { markdownToBlocks } from "./markdown-parser.ts";
import { noteBlockMarkdown } from "./note-markdown.ts";
import { noteBlocksToPmNodes, noteBlockRenderedTextV1, pmNodesToNoteBlocks, noteDocSchemaSpec, type NoteDocBlockSpec } from "./note-doc-schema.ts";
import type { CompanionEditNoteV1, CompanionNoteEditingContextV1 } from ".././contracts/companion/companion-note-authoring-contracts.ts";

export class NoteEditConflict extends Error {}
export type NoteCompanionTransformRuntime = { Fragment: typeof Fragment; Slice: typeof Slice; Transform: typeof Transform };

/** A disposable projection; never writes the user's document or save queue. */
export function previewCompanionNoteEdit(blocks: readonly NoteDocBlockSpec[], input: CompanionEditNoteV1,
  editing?: CompanionNoteEditingContextV1): NoteDocBlockSpec[] {
  const schema = new Schema(noteDocSchemaSpec as never);
  const before = schema.nodeFromJSON({ type: "doc", content: noteBlocksToPmNodes([...blocks]) });
  return pmNodesToNoteBlocks(transformCompanionNoteEdit(before, input, editing).toJSON().content ?? []);
}
const conflict = () => { throw new NoteEditConflict("要调整的原文或位置已经变化，请重新选择后再试。正文没有被替换。"); };

/** A model edits a verified range of the live document; unrelated nodes retain identity and provenance. */
export function transformCompanionNoteEdit(before: Node, input: CompanionEditNoteV1, editing?: CompanionNoteEditingContextV1,
  runtime: NoteCompanionTransformRuntime = { Fragment, Slice, Transform }): Node {
  // Constructors must belong to the document's PM runtime. Separate packages
  // can resolve identical versions to distinct module instances.
  const { Fragment, Transform } = runtime;
  const schema = before.type.schema;
  const blocks = pmNodesToNoteBlocks(before.toJSON().content ?? []);
  const starts: number[] = []; before.forEach((_node, pos) => starts.push(pos));
  const verify = (start: number, end: number, expected: readonly string[]) => {
    if (start < 0 || end >= blocks.length || expected.length !== end - start + 1
      || expected.some((text, i) => blocks[start + i]?.content !== text)) conflict();
  };
  const parsed = (markdown: string) => Fragment.fromArray(noteBlocksToPmNodes(markdownToBlocks(markdown)).map(json => schema.nodeFromJSON(json)));
  let content = parsed(input.markdown ?? "");
  let tr = new Transform(before);
  if (input.operation === "append") {
    tr = tr.insert(before.content.size, content);
  } else if (input.operation.endsWith("blocks")) {
    const first = input.startBlock!, last = input.endBlock!;
    verify(first, last, input.expectedBlocks!);
    if (input.operation === "replace_blocks" && input.preserveBlockStructure !== false) {
      const preserved = content.childCount === last - first + 1
        ? Array.from({ length: content.childCount }, (_, index) =>
          preservingBlockStructure(before.child(first + index), content.child(index), Fragment)) : [];
      if (preserved.length === 0 || preserved.some(node => node === null)) throw new NoteEditConflict(
        `这次替换会改变原文的标题、列表、表格或段落结构，尚未保存。范围包含 ${last - first + 1} 块，Markdown 解析为 ${content.childCount} 块。`
        + "独立段落用空行分隔；markdown 只填替换范围，不包含范围外正文。只改文字或数值时保留原段落的类型与格式。",
      );
      content = Fragment.fromArray(preserved as Node[]);
    }
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
      tr = insertContent(tr, position, position, content, runtime.Slice);
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
    tr = input.operation === "delete_selection" ? tr.deleteRange(from, to) : insertContent(tr, from, to, content, runtime.Slice);
  }
  const next = tr.doc;
  if (next.eq(before)) throw new NoteEditConflict("这次要求没有改变正文。");
  next.check();
  return next;
}

/** Source/style provenance is not Markdown syntax. Preserve it while checking
 * nested list/table shape; inline text can change without replacing a block. */
function preservingBlockStructure(original: Node, replacement: Node, FragmentRuntime: typeof Fragment): Node | null {
  const syntaxAttrs = (node: Node) => Object.fromEntries(Object.entries(node.attrs)
    .filter(([key]) => key !== "sourceRef" && key !== "noteStyle"));
  if (original.type.name !== replacement.type.name
    || JSON.stringify(syntaxAttrs(original)) !== JSON.stringify(syntaxAttrs(replacement))) return null;
  let children = replacement.content;
  if (!original.isTextblock && !original.isLeaf) {
    if (original.childCount !== replacement.childCount) return null;
    const preserved = Array.from({ length: original.childCount }, (_, index) =>
      preservingBlockStructure(original.child(index), replacement.child(index), FragmentRuntime));
    if (preserved.some(node => node === null)) return null;
    children = FragmentRuntime.fromArray(preserved as Node[]);
  }
  return replacement.type.create({ ...replacement.attrs,
    ...("sourceRef" in original.attrs ? { sourceRef: original.attrs.sourceRef } : {}),
    ...("noteStyle" in original.attrs ? { noteStyle: original.attrs.noteStyle } : {}),
  }, children, replacement.marks);
}

function insertContent(tr: Transform, from: number, to: number, content: Fragment, SliceRuntime: typeof Slice): Transform {
  const node = content.childCount === 1 ? content.firstChild : null;
  if (node?.type.name === "paragraph") return tr.replaceWith(from, to, node.content);
  return tr.replaceRange(from, to, new SliceRuntime(content, 0, 0));
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
