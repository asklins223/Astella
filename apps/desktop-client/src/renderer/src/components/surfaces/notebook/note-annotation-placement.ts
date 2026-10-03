/**
 * 批注记号在**可编辑预览**与**纯编辑**里的落位计算（纯函数，无 DOM、无编辑器依赖）。
 *
 * ## 为什么要有这一层
 *
 * 41 §1.4 要求「可编辑预览保留记号但不阻断输入」「纯编辑可在对应源码行的侧边
 * 显示批注记号」。此前只有 `note-reading-inline.tsx`（预览态）挂 `NoteAnnotationMark`，
 * 两个编辑器里 annotation 零命中——用户切到编辑态，已有的原句批注**全部消失**，
 * 切回预览才回来。
 *
 * 三个视图共用**同一个块下标空间**，这是实测确认的：
 * `use-note-doc-live-view.ts` 是 `pmNodesToNoteBlocks(json.content).map((b, ordinal) => ...)`，
 * 而 `pmNodesToNoteBlocks` 对顶层节点是 **1:1**（引用块的内部段落被 join 成一整块、
 * 列表项被 join 成一整块），不摊平成多个 ordinal。`noteSourceBlocks(source)`
 * 走的是同一个 Markdown 块序列。**块 ordinal 就是顶层节点下标**，两边对得上。
 *
 * ## 唯一一条不许越过的线
 *
 * 锚点核不上当前正文就**不画**。41 §2.3：「改版后只有能可靠验证同一锚点才挂靠；
 * 否则留在旧版记录，不按相似文本猜一个新位置。」所以这里收进来的必须是调用方
 * 已经验过的集合（页面上是 `currentNoteAnnotations`），本模块**不再**自己猜。
 */
import { noteAnchorBlockRangeV1, noteAnchorMatchesV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";

/** 本模块只需要块的这三样：与 `AnchorBlock` 同形。 */
export type PlacementBlock = { readonly ordinal: number; readonly type: string; readonly content: string };

/** API records arrive newest first; paper numbers grow in creation order. */
export function chronologicalAnnotations(annotations: readonly NoteAnnotationV1[]): NoteAnnotationV1[] {
  return [...annotations].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.annotationId.localeCompare(b.annotationId));
}

/** 一条批注落在哪些块上，以及每块里那一段的**渲染文本**范围。 */
export type AnnotationPlacement = {
  readonly annotationId: string;
  /** 1 起的显示序号，与阅读态那张纸上的记号一致。 */
  readonly number: number;
  readonly blocks: readonly {
    readonly ordinal: number;
    /**
     * 块内范围（渲染文本坐标）。`null` = 这一块拿不准，就只画块级记号，不画句内高亮。
     *
     * 宁可少画一段，也不画错一段：块级记号仍然把用户带到正确的原句，句内高亮画错了
     * 则是「这枚记号说的是另一句话」——比没有记号更坏。
     */
    readonly range: readonly [number, number] | null;
  }[];
};

/**
 * 只画**当前正文上仍能验证**的批注。
 *
 * 调用方按创建时间排列；新批注接在最后，已有记号不会因新增而重排。
 */
export function annotationPlacements(
  annotations: readonly NoteAnnotationV1[],
  blocks: readonly PlacementBlock[],
): AnnotationPlacement[] {
  const placements: AnnotationPlacement[] = [];
  for (const annotation of annotations) {
    // 核不上就整条不画。调用方通常已经筛过一遍，这里是**第二道**，因为两个编辑器的
    // 落位发生在正文继续被编辑之后，而调用方那次筛选只代表它筛选那一刻。
    if (!noteAnchorMatchesV1(blocks, annotation.anchor)) continue;
    const covered: AnnotationPlacement["blocks"][number][] = [];
    for (const block of blocks) {
      if (block.ordinal < annotation.anchor.startBlockOrdinal || block.ordinal > annotation.anchor.endBlockOrdinal) continue;
      covered.push({ ordinal: block.ordinal, range: noteAnchorBlockRangeV1(block, annotation.anchor) });
    }
    if (!covered.length) continue;
    placements.push({ annotationId: annotation.annotationId, number: placements.length + 1, blocks: covered });
  }
  return placements;
}

/** 块下标 → 落在它上面的批注。一个块被多条批注覆盖时是多项。 */
export function placementsByBlock(placements: readonly AnnotationPlacement[]): ReadonlyMap<number, readonly AnnotationPlacement[]> {
  const map = new Map<number, AnnotationPlacement[]>();
  for (const placement of placements) {
    for (const block of placement.blocks) {
      const list = map.get(block.ordinal);
      if (list) list.push(placement);
      else map.set(block.ordinal, [placement]);
    }
  }
  return map;
}
