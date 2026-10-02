import { markdownLanguage } from "@codemirror/lang-markdown";
import type { NoteDocumentPosition } from "./note-source-bridge";

export type NoteSourceBlock = {
  readonly from: number;
  readonly to: number;
  readonly headingLevel: number | null;
  readonly title: string;
};

/** The Markdown parser excludes fenced code and handles both ATX and setext headings. */
export function noteSourceBlocks(source: string): NoteSourceBlock[] {
  const result: NoteSourceBlock[] = [];
  let node = markdownLanguage.parser.parse(source).topNode.firstChild;
  while (node) {
    if (!node.name.startsWith("LinkReference")) {
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      const text = source.slice(node.from, node.to);
      result.push({ from: node.from, to: node.to, headingLevel: heading ? Number(heading[1]) : null,
        title: heading ? text.replace(/^#{1,6}\s+/, "").replace(/\n[=-]+\s*$/, "").replace(/\s+#+\s*$/, "").trim() : "" });
    }
    node = node.nextSibling;
  }
  return result;
}

export function noteSourcePosition(source: string, caret: number): NoteDocumentPosition {
  const blocks = noteSourceBlocks(source);
  const index = blocks.findIndex((block) => block.to >= caret);
  const block = index < 0 ? Math.max(0, blocks.length - 1) : index;
  return { block, offset: Math.max(0, caret - (blocks[block]?.from ?? 0)) };
}

export function noteSourceOffset(source: string, position: NoteDocumentPosition): number {
  const blocks = noteSourceBlocks(source);
  const block = blocks[Math.min(position.block, blocks.length - 1)];
  return block ? Math.min(block.to, block.from + position.offset) : 0;
}
