import { segmentsToBlocks, type ParsedBlock, type ParsedSegment } from "@ailearn/shared/markdown-parser";

/** Source offsets keep raw Markdown; rich note nodes already supply block markers. */
export function sourceNoteBlocks(
  segments: ParsedSegment[],
  sourceType: "text" | "markdown" | "code" | "url",
): ParsedBlock[] {
  const blocks = segmentsToBlocks(segments, sourceType);
  if (sourceType === "text" || sourceType === "code") return blocks;
  return blocks.map((block) => ({ ...block, content: noteBlockContent(block) }));
}

function noteBlockContent(block: ParsedBlock): string {
  switch (block.type) {
    case "heading":
      return block.content.replace(/^#{1,6}\s+/, "");
    case "quote":
      return block.content.replace(/^>\s?/gm, "");
    case "list":
      return block.content.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");
    case "code": {
      const lines = block.content.split("\n");
      const fence = /^\s*(`{3,}|~{3,})[^`~]*$/.exec(lines[0] ?? "");
      if (!fence) return block.content;
      const closing = lines.at(-1)?.trim() ?? "";
      const isClosing = closing.length >= fence[1]!.length
        && [...closing].every((char) => char === fence[1]![0]);
      return lines.slice(1, isClosing ? -1 : undefined).join("\n");
    }
    default:
      return block.content;
  }
}
