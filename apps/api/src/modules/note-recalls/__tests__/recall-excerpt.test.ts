import test from "node:test";
import assert from "node:assert/strict";
import { groundedRecallExcerpt, nextRecallExcerpt, recallExcerptCandidates } from "../recall-excerpt.ts";

const blocks = [
  { ordinal: 0, type: "heading", text: "复利如何计算" },
  { ordinal: 1, type: "paragraph", text: "上一轮新增的利息会加入本金，下一轮计算利息时，也会把这笔新增的利息算进去。" },
  { ordinal: 2, type: "image", text: "![图片](/api/uploads/object.webp)" },
  { ordinal: 3, type: "heading", text: "通货膨胀与购买力" },
  { ordinal: 4, type: "paragraph", text: "通货膨胀会降低货币的购买力，名义上的金额相同，能买到的商品数量却减少了。" },
  { ordinal: 5, type: "code", text: "return amount * rate;" },
  { ordinal: 6, type: "paragraph", text: "https://example.com/long-reference" },
];

test("回想只取真实段落，排除图片、代码和纯链接，并保留原始位置", () => {
  const candidates = recallExcerptCandidates(blocks);
  assert.deepEqual(candidates.map(c => c.ordinal), [1, 4]);
  assert.equal(candidates[0]!.title, "复利如何计算");
  assert.equal(candidates[0]!.text, blocks[1]!.text);
});
test("新问题轮换没有用过的段落；用完以后沿上次位置继续，不以自评推断掌握", () => {
  const candidates = recallExcerptCandidates(blocks);
  assert.equal(nextRecallExcerpt(candidates, [])?.ordinal, 1);
  assert.equal(nextRecallExcerpt(candidates, [1])?.ordinal, 4);
  assert.equal(nextRecallExcerpt(candidates, [4, 1])?.ordinal, 1);
});
test("伴星问题只对应一处有依据的片段；不明问题不能退回整篇快照", () => {
  const candidates = recallExcerptCandidates(blocks);
  const basis = groundedRecallExcerpt(candidates, "复利下一轮计算时，为什么要把新增的利息也算进去？");
  assert.equal(basis?.ordinal, 1);
  assert.equal(basis?.text, blocks[1]!.text);
  assert.equal(groundedRecallExcerpt(candidates, "怎么学习这篇笔记？"), null);
  assert.equal(groundedRecallExcerpt([candidates[0]!, { ...candidates[0]!, ordinal: 7 }], "新增的利息为什么加入本金？"), null);
});
test("很长的一段有限摘录，截在真实句子边界，不拼接其他段落", () => {
  const text = "一个完整的句子讲清原来的原因。".repeat(100);
  const [basis] = recallExcerptCandidates([{ ordinal: 9, type: "paragraph", text }]);
  assert.ok(basis && basis.text.length <= 900 && basis.truncated);
  assert.ok(basis.text.endsWith("。"));
  assert.ok(text.startsWith(basis.text));
});
