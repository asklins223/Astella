import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAtomsDeterministicWithStats } from "../card-generation-v2-pipeline/planner-service.ts";

/**
 * 确定性提取的两道规则各记各的数（2026-10-12）。
 *
 * 「这篇笔记到底在哪一步变短的」以前只能拿原子数减候选数去猜，而句子太短、被判成操作记录
 * 这两道发生在大模型选目标之前，连那个差值都不含它们——C16 那一发 `candidateCount:1`
 * 而三个计数器全空，就是这么读不出来的。
 */
test("太短与判成操作记录的句子分别计数，与留下的原子同源", () => {
  const result = extractAtomsDeterministicWithStats([
    { blockId: "b1", type: "paragraph", ordinal: 0, content: "好的。明白。光合作用把光能转成化学能储存在糖分子里。" },
    { blockId: "b2", type: "paragraph", ordinal: 1, content: "明天上午记得把实验报告交上去，顺便核对一下截止日期的安排。" },
  ]);
  assert.equal(result.atoms.length, 1, "该留下的那句被挡掉了");
  // 分句会把句末标点去掉，留的是句子本身
  assert.equal(result.atoms[0]?.proposition, "光合作用把光能转成化学能储存在糖分子里");
  assert.equal(result.excluded.tooShort, 2, "两句短句没有各自记数");
  assert.equal(result.excluded.operational, 1, "被判成操作记录的那句没有记数");
});
