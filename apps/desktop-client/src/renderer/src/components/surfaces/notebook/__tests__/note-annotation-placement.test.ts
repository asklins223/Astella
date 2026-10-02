/**
 * 批注落位计算的判据（41 §1.4 / §2.3 / §7.1「三态与批注」）。
 *
 * 这一层是**纯函数**，所以每一条都能在这里被量到——真实窗口量的是它画出来好不好看，
 * 这里量的是它**画在哪、画不画**。两条都不该省。
 */
import { describe, expect, it } from "vitest";
import { annotationPlacements, placementsByBlock, type PlacementBlock } from "../note-annotation-placement.ts";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";

const BLOCK0 = "提取练习让大脑重新构建记忆痕迹。";
const BLOCK1 = "第二段讲间隔效应。";
const BLOCK2 = "第三段是结尾。";

const BLOCKS: PlacementBlock[] = [
  { ordinal: 0, type: "paragraph", content: BLOCK0 },
  { ordinal: 1, type: "paragraph", content: BLOCK1 },
  { ordinal: 2, type: "paragraph", content: BLOCK2 },
];

/**
 * 造一条锚点。
 *
 * `excerpt/prefix/suffix` **必须逐字等于**当前正文里那一段的切片——合同
 * （`noteAnchorMatchesV1`）比的就是这三样，所以这里按块文本算出来，而不是手写：
 * 手写过一次，四个用例的锚点全部核不上，症状是「一条都画不出来」，
 * 而读起来像落位算错了。
 */
const anchor = (a: {
  id: string;
  from: { block: number; offset: number };
  to: { block: number; offset: number };
}): NoteAnnotationV1["anchor"] => {
  const texts = [BLOCK0, BLOCK1, BLOCK2];
  const span = texts.slice(a.from.block, a.to.block + 1);
  const excerpt = span
    .map((text, index) =>
      text.slice(
        index === 0 ? a.from.offset : 0,
        index === span.length - 1 ? a.to.offset : text.length,
      ),
    )
    .join("\n\n");
  const head = texts[a.from.block]!;
  const tail = texts[a.to.block]!;
  return {
    noteVersionId: "v-1",
    startBlockOrdinal: a.from.block,
    startOffset: a.from.offset,
    endBlockOrdinal: a.to.block,
    endOffset: a.to.offset,
    excerpt,
    prefix: head.slice(Math.max(0, a.from.offset - 120), a.from.offset),
    suffix: tail.slice(a.to.offset, a.to.offset + 120),
  };
};

const annotation = (a: Parameters<typeof anchor>[0]): NoteAnnotationV1 => ({
  annotationId: a.id,
  noteId: "n-1",
  anchor: anchor(a),
  explanation: "这是解释",
  sourceMessageId: null,
  generationJobId: null,
  revision: 1,
  versionState: "current",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});

describe("批注落位（可编辑预览 / 纯编辑共用）", () => {
  it("正控制：锚点核得上就画，且范围落在块内", () => {
    const placed = annotationPlacements(
      [annotation({ id: "a1", from: { block: 0, offset: 0 }, to: { block: 0, offset: 7 } })],
      BLOCKS,
    );
    expect(placed).toHaveLength(1);
    expect(placed[0].annotationId).toBe("a1");
    expect(placed[0].number).toBe(1);
    expect(placed[0].blocks).toEqual([{ ordinal: 0, range: [0, 7] }]);
  });

  /**
   * 反面判据：**锚点核不上就一条都不画**。
   *
   * 这是 41 §2.3「不按相似文本猜一个新位置」的落点。改版之后 excerpt 对不上是
   * 常态（用户改了正文），而画面上那一枚记号若还挂在那儿，用户点开读到的是
   * 「这一段」——可它已经不是这一段了。
   */
  it("锚点核不上当前正文：不画，也不按相似文本猜位置", () => {
    // 正文第一段被改写成另一句话，但锚点的 excerpt 仍指向原文那一段。
    const edited: PlacementBlock[] = [
      { ordinal: 0, type: "paragraph", content: "间隔效应说的是复习的时间点。" },
      BLOCKS[1], BLOCKS[2],
    ];
    const placed = annotationPlacements(
      [annotation({ id: "a1", from: { block: 0, offset: 0 }, to: { block: 0, offset: 7 } })],
      edited,
    );
    expect(placed).toEqual([]);
  });

  it("多段锚点：每一块各算一段，范围按块边界收（中间那块不整块高亮）", () => {
    const placed = annotationPlacements(
      [annotation({ id: "a2", from: { block: 0, offset: 0 }, to: { block: 1, offset: 4 } })],
      BLOCKS,
    );
    expect(placed).toHaveLength(1);
    expect(placed[0].blocks).toEqual([
      { ordinal: 0, range: [0, BLOCK0.length] },
      { ordinal: 1, range: [0, 4] },
    ]);
  });

  it("编号按传入顺序稳定：后加一条不会把先前的记号重排", () => {
    const placed = annotationPlacements([
      annotation({ id: "a1", from: { block: 0, offset: 0 }, to: { block: 0, offset: 7 } }),
      annotation({ id: "a3", from: { block: 2, offset: 0 }, to: { block: 2, offset: 3 } }),
    ], BLOCKS);
    expect(placed.map((p) => [p.annotationId, p.number])).toEqual([["a1", 1], ["a3", 2]]);
  });

  it("核不上的那条不占编号：跳过它，后面的号仍然连着", () => {
    // endOffset 越界 ⇒ 合同核不上 ⇒ 整条跳过。
    const stale = annotation({ id: "stale", from: { block: 0, offset: 0 }, to: { block: 0, offset: 7 } });
    const broken = { ...stale, anchor: { ...stale.anchor, endOffset: 999, excerpt: "对不上的摘录" } };
    const placed = annotationPlacements(
      [broken, annotation({ id: "good", from: { block: 1, offset: 0 }, to: { block: 1, offset: 3 } })],
      BLOCKS,
    );
    expect(placed.map((p) => p.annotationId)).toEqual(["good"]);
    expect(placed[0].number).toBe(1);
  });

  it("placementsByBlock：一个块被多条批注覆盖时列出全部，没被覆盖的块不进表", () => {
    const byBlock = placementsByBlock(annotationPlacements([
      annotation({ id: "a1", from: { block: 0, offset: 0 }, to: { block: 0, offset: 7 } }),
      annotation({ id: "a2", from: { block: 0, offset: 9 }, to: { block: 0, offset: 13 } }),
    ], BLOCKS));
    expect(byBlock.get(0)?.map((p) => p.annotationId)).toEqual(["a1", "a2"]);
    expect(byBlock.has(1)).toBe(false);
    expect(byBlock.has(2)).toBe(false);
  });

  it("范围永不超过该块长度：拿不准的那块降级成 range=null 而不是夹一个假范围", () => {
    // 这条只断言**形状合法**：range 非空时必须落在 [0, 该块渲染长度] 内。
    // 越界时合同自己会核不上（上一条已经量过），所以这里能进到断言的
    // 必然是算得出来的那些——夹一个假范围会让记号指向另一句话，比没有更坏。
    const placed = annotationPlacements([
      annotation({ id: "a1", from: { block: 0, offset: 3 }, to: { block: 0, offset: 12 } }),
      annotation({ id: "a2", from: { block: 1, offset: 0 }, to: { block: 1, offset: BLOCK1.length } }),
    ], BLOCKS);
    const lengths = [BLOCK0.length, BLOCK1.length, BLOCK2.length];
    for (const placement of placed) {
      for (const block of placement.blocks) {
        if (!block.range) continue;
        expect(block.range[0]).toBeGreaterThanOrEqual(0);
        expect(block.range[1]).toBeGreaterThan(block.range[0]);
        expect(block.range[1]).toBeLessThanOrEqual(lengths[block.ordinal]!);
      }
    }
  });
});
