/**
 * 速看产出的两条纪律：**长度不设本地配额**、**核不上的引用逐条剔除而不是整份失败**。
 *
 * 原先三处固定字数（gist 180／quote 200／explanation 200）与提示词里那串数字
 * （120／160／140）互相打架：模型按提示词写、按合同被拒，用户看到的是"速看结果缺少
 * 清楚的重点或原文依据"——而内容本身是合法的。引用那头还有一道 500 字闸，
 * 超了同样判"核不回原文"，于是整份速看跟着失败。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exactQuote,
  orderOverviewPoints,
  parseOverviewChunk,
  resolveOverviewPoints,
} from "../note-overview-generate.ts";
import { NoteOverviewOutputError } from "../../lib/non-retryable-errors.ts";

const SOURCE = "把复习安排在快要忘记的时候，比反复重读同一段材料更有效。间隔越长，回忆越费力，记住的也越牢。";

function chunk(points: { blockOrdinal: number; quote: string; explanation: string }[], gist = "这一段讲的是复习该安排在什么时候。") {
  return JSON.stringify({ gist, points });
}

test("长 gist、长引用、长解释都收得下：长度由内容定，不由本地配额定", () => {
  const longGist = "这一段先说清楚为什么在快要忘记的时候复习最有效，".repeat(20) + "再说间隔怎么影响记忆。";
  const longQuote = SOURCE;
  const longExplanation = "读者需要知道的是复习时机比复习次数更关键。".repeat(20) + "所以安排复习要看距离上次多久。";
  assert.ok(longGist.length > 180 && longExplanation.length > 200, "用例必须真的越过原来那三道闸");
  const parsed = parseOverviewChunk(chunk([{ blockOrdinal: 3, quote: longQuote, explanation: longExplanation }], longGist));
  assert.equal(parsed.gist, longGist, "长 gist 要原样留下，不能被剪尾");
  assert.equal(parsed.points[0]!.explanation, longExplanation);
});

test("超过 500 字的引用仍然核得回原文：不再因此判整份速看失败", () => {
  const long = "记忆的保持取决于回忆时的费力程度。".repeat(40);
  assert.ok(long.length > 500);
  assert.equal(exactQuote(long, long), long);
});

test("核不上的那一条剔掉，同一段里已经核实的其他重点照留，并报出剔了几条", () => {
  const blocks = new Map([
    [0, { ordinal: 0, type: "text", content: SOURCE }],
    [1, { ordinal: 1, type: "image", content: SOURCE }],
  ]);
  const resolved = resolveOverviewPoints([
    { blockOrdinal: 0, quote: "把复习安排在快要忘记的时候", explanation: "复习时机比次数重要。" },
    { blockOrdinal: 0, quote: "这句话原文里根本没有出现过", explanation: "编出来的。" },
    { blockOrdinal: 1, quote: "把复习安排在快要忘记的时候", explanation: "图片段不是可引用原文。" },
    { blockOrdinal: 9, quote: "把复习安排在快要忘记的时候", explanation: "这一段不在本段范围里。" },
  ], (ordinal) => blocks.get(ordinal));
  assert.equal(resolved.points.length, 1, "只留核得回原文的那一条");
  assert.equal(resolved.points[0]!.quote, "把复习安排在快要忘记的时候");
  assert.equal(resolved.dropped, 3, "剔掉几条要能报出来，否则少给的重点是无声的");
});

test("要点清单按原文顺序排，同一段同一句只留一条", () => {
  const ordered = orderOverviewPoints([
    [
      { blockOrdinal: 7, quote: "第七段的一句话在这里", explanation: "后出现的段。" },
      { blockOrdinal: 2, quote: "第二段的一句话在这里", explanation: "先出现的段。" },
    ],
    [
      { blockOrdinal: 2, quote: "第二段的一句话在这里", explanation: "相邻那一段又引了同一句。" },
      { blockOrdinal: 5, quote: "第五段的一句话在这里", explanation: "中间那一段。" },
    ],
  ]);
  assert.deepEqual(ordered.map((point) => point.blockOrdinal), [2, 5, 7], "编号清单的顺序就是读的顺序");
  assert.equal(ordered.length, 3, "重复引用的同一条不再出现两次");
});

test("正文里有 emoji 时，引用照样核得回原文（码元下标与码点下标不是一回事）", () => {
  const block = "😀先看这张图的意思：把复习安排在快要忘记的时候更有效。";
  assert.equal(exactQuote(block, "把复习安排在快要忘记的时候更有效"), "把复习安排在快要忘记的时候更有效");
  assert.equal(exactQuote("😀😀第二段也有话说，这里再讲一遍。", "第二段也有话说，这里再讲"), "第二段也有话说，这里再讲");
  // 低于"至少 8 字"那条下限的引用仍然不收：太短认不出说的是哪件事
  assert.equal(exactQuote("😀😀第二段也有话说，这里再讲一遍。", "第二段"), null);
});

test("行首编号与表格竖线不算内容差别：长文里这两类引文不该被判掉", () => {
  // 判据现在三条链共用一份（note-grounding-source.ts）；这两句是长笔记实测里
  // 速看悄悄 pointsDropped 的形状：模型照抄 `1. ` 与竖线，渲染后的正文里没有它们。
  // 行首 `1. ` 不进正文，落库从正文第一个字开始；行中的 `**` 是原文里真在的，照留。
  assert.equal(exactQuote("1. **单次调用可以是完整执行。** 明确的小任务允许直接完成。", "1. **单次调用可以是完整执行。** 明确的小任务允许直接完成"),
    "单次调用可以是完整执行。** 明确的小任务允许直接完成");
  // 真实形状：底本是渲染后的正文（竖线已剥），模型引的是原始 markdown（带竖线）。
  assert.equal(exactQuote("当前交流当前请求、相关记忆与方法明确长期要求", "当前交流 | 当前请求、相关记忆与方法 | 明确长期要求"),
    "当前交流当前请求、相关记忆与方法明确长期要求");
});

test("该拒的照拒：不是可核对的结构化内容、或者一条重点都没有", () => {
  for (const raw of ["这不是 JSON", chunk([])]) {
    assert.throws(() => parseOverviewChunk(raw), (error: unknown) => error instanceof NoteOverviewOutputError);
  }
});
