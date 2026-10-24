import assert from "node:assert/strict";
import test from "node:test";
import { boundedReaderBlocks } from "../reader-page.ts";

test("a long note returns a bounded contiguous page without re-numbering its anchors", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ ordinal: 240 + index, content: "内容" }));
  const page = boundedReaderBlocks(rows, 24);
  assert.equal(page.blocks.length, 24);
  assert.equal(page.blocks[0]?.ordinal, 240);
  assert.equal(page.blocks.at(-1)?.ordinal, 263);
  assert.equal(page.hasMore, true);
});

test("a byte boundary counts UTF-8 Chinese text and never splits a paragraph", () => {
  const rows = [{ ordinal: 1, content: "学".repeat(4) }, { ordinal: 2, content: "习".repeat(4) }];
  assert.deepEqual(boundedReaderBlocks(rows, 24, 20), { blocks: [rows[0]], hasMore: true });
  assert.deepEqual(boundedReaderBlocks(rows, 24, 5), { blocks: [rows[0]], hasMore: true });
});

test("an empty or exact final page has no endless next cursor", () => {
  assert.deepEqual(boundedReaderBlocks([], 24), { blocks: [], hasMore: false });
  const row = { ordinal: 7, content: "最后一段" };
  assert.deepEqual(boundedReaderBlocks([row], 24), { blocks: [row], hasMore: false });
});
