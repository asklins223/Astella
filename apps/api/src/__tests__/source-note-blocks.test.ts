import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseContent, type ParsedSegment } from "@ailearn/shared/markdown-parser";
import { emptyFragmentNoteDoc, projectFragmentBlocks, writeFragmentBlocks } from "../modules/note/doc-fragment.ts";
import { sourceNoteBlocks } from "../modules/source/source-note-blocks.ts";

function segment(text: string, segmentType: ParsedSegment["segmentType"]): ParsedSegment {
  return { text, segmentType, charStart: 0, charEnd: text.length };
}

describe("source to rich note blocks", () => {
  it("normalizes only block wrappers while retaining source offsets, inline marks and evidence refs", () => {
    const raw = "# Heading\n\nA **bold** idea.\n\n> A quote\n> Another line\n\n- First\n- Second\n\n```ts\nconst value = '**literal**';\n```";
    const segments = parseContent(raw, "markdown");
    const original = structuredClone(segments);
    const blocks = sourceNoteBlocks(segments, "markdown");
    assert.deepEqual(blocks, [
      { type: "heading", content: "Heading" },
      { type: "paragraph", content: "A **bold** idea." },
      { type: "quote", content: "A quote\nAnother line" },
      { type: "list", content: "First\nSecond" },
      { type: "code", content: "const value = '**literal**';" },
    ]);
    assert.deepEqual(segments, original);
    for (const part of segments) assert.equal(raw.slice(part.charStart, part.charEnd), part.text);

    const doc = emptyFragmentNoteDoc();
    try {
      const referenced = blocks.map((block, index) => ({
        ...block,
        sourceRef: { sourceId: "source-1", segmentId: `segment-${index}` },
      }));
      writeFragmentBlocks(doc, referenced);
      assert.deepEqual(projectFragmentBlocks(doc), referenced.map((block, ordinal) => ({ ordinal, ...block })));
    } finally {
      doc.destroy();
    }
  });

  it("keeps literal plain text, code and image Markdown intact", () => {
    assert.deepEqual(sourceNoteBlocks([segment("# Literal\n- Literal", "paragraph")], "text"), [
      { type: "paragraph", content: "# Literal\n- Literal" },
    ]);
    assert.deepEqual(sourceNoteBlocks([segment("# shell comment\nvalue = 1", "paragraph")], "code"), [
      { type: "code", content: "# shell comment\nvalue = 1" },
    ]);
    assert.deepEqual(sourceNoteBlocks([segment("![diagram](https://example.test/image.png)", "image")], "url"), [
      { type: "image", content: "![diagram](https://example.test/image.png)" },
    ]);
  });

  it("removes ordered markers and fences without removing code from an unfinished fence", () => {
    assert.deepEqual(sourceNoteBlocks([
      segment("1. First\n2. Second", "list"),
      segment("~~~js\nlet x = 1;\n~~~", "code"),
      segment("```js\nlet y = 2;", "code"),
      segment("```js\nlet z = 3;\n~~~, not a closing fence", "code"),
    ], "markdown").map((block) => block.content), [
      "First\nSecond", "let x = 1;", "let y = 2;", "let z = 3;\n~~~, not a closing fence",
    ]);
  });
});
