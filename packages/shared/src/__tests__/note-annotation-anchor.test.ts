import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noteAnchorBlockRangeV1, noteAnchorMatchesV1, noteAnnotationAnchorV1Schema, readNoteAnchorTextV1 } from "../contracts/note-annotation-contracts.ts";

const blocks = [
  { ordinal: 0, type: "paragraph", content: "利息加入**本金**后，下一轮继续生息。" },
  { ordinal: 1, type: "heading", content: "为什么增长" },
  { ordinal: 2, type: "paragraph", content: "每轮新增利息也会参与计算。" },
];
const bounds = { startBlockOrdinal: 0, endBlockOrdinal: 2, startOffset: 4, endOffset: 6 };
const anchor = { noteVersionId: "11111111-4111-8111-8111-111111111111", ...bounds,
  excerpt: "本金后，下一轮继续生息。\n\n为什么增长\n\n每轮新增利息", prefix: "利息加入", suffix: "也会参与计算。" };
describe("跨段选区冻结与定位", () => {
  it("跨段可以保存，依正文顺序和显示文字核对，不比较两段的局部 offset 大小", () => {
    assert.deepEqual(noteAnnotationAnchorV1Schema.parse(anchor), anchor);
    assert.deepEqual(readNoteAnchorTextV1([...blocks].reverse(), bounds), { excerpt: anchor.excerpt, prefix: anchor.prefix, suffix: anchor.suffix });
    assert.equal(noteAnchorMatchesV1(blocks, anchor), true);
    assert.deepEqual(noteAnchorBlockRangeV1(blocks[0]!, anchor), [4, 16]);
    assert.deepEqual(noteAnchorBlockRangeV1(blocks[1]!, anchor), [0, 5]);
    assert.deepEqual(noteAnchorBlockRangeV1(blocks[2]!, anchor), [0, 6]);
  });
  it("中间段漂移、段落缺失或端点越界都拒绝，不猜测相似原句", () => {
    assert.equal(noteAnchorMatchesV1(blocks.map(block => block.ordinal === 1 ? { ...block, content: "另一个标题" } : block), anchor), false);
    assert.equal(noteAnchorMatchesV1([blocks[0]!, blocks[2]!], anchor), false);
    assert.equal(noteAnchorMatchesV1(blocks, { ...anchor, endOffset: 999 }), false);
    assert.equal(noteAnnotationAnchorV1Schema.safeParse({ ...anchor, endBlockOrdinal: -1 }).success, false);
  });
  it("同段原句仍用原来的 offsets，跨段不会改变它的格式", () => {
    const single = { ...anchor, endBlockOrdinal: 0, endOffset: 6, excerpt: "本金", suffix: "后，下一轮继续生息。" };
    assert.equal(noteAnchorMatchesV1(blocks, single), true);
    assert.equal(noteAnchorBlockRangeV1(blocks[1]!, single), null);
  });
});
