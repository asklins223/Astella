/**
 * 卡库按笔记成组（39d W7-6；39 §8.5 第一段与第二段）。
 *
 * §8.5 写死三件事，这一份把它们变成**可跑的判据**而不是屏上的一段 JSX：
 *  1. **顶层按笔记显示卡组，一篇笔记至多一个组**。键必须是 `noteId`，不是标题——
 *     按标题分组等于按可改的名字分组：同一篇改了标题分成两组，两篇同名并成一组。
 *  2. **「未关联笔记」是一个组，不是一堆散行**。§8.5「显示为『未关联笔记』，
 *     **不按标题猜造**笔记或卡组」——所以那一档的键是常量，不是"把没标题的凑一堆"。
 *  3. **组内三类数分开，且状态来源不同分别标明**。待复习／可用／待核对**不是同一
 *     个状态轴上的三档**，各自有自己的出处（见下面三个判据函数），合成一个数就会
 *     让屏上出现"待复习 2、可用 0、待核对 0"而其实有 2 张待核对。
 *
 * 纯函数、无 React、无 IO：屏上、伴星读页面、以及将来的"今日练习跨组"共用同一份。
 * 同一个分组在两处各算一次，就是两处各有一个"这篇有几张卡"的答案。
 */
import type { ObjectiveListItemV3, ObjectiveNoteChangeImpactV1 } from "./contracts/learning-objective-surface-contracts.ts";

/** §8.5「未关联笔记」那一组的键。它是常量：真实笔记 id 永远是 uuid，撞不上。 */
/** 分组只需要这几格；写成 Pick 是为了让判据能被小夹具直接调。 */
export type ObjectiveListItemV2Input = Pick<
  ObjectiveListItemV3,
  "objectiveId" | "primaryNoteId" | "primaryNoteTitle" | "freshness" | "noteChangeImpact" | "progress"
> & Partial<Pick<ObjectiveListItemV3, "conceptLabel">>;

export const UNGROUPED_NOTE_KEY = "ungrouped-note" as const;
export const UNGROUPED_NOTE_LABEL = "未关联笔记";

/** 一组里的三档。它们**互斥**：一张卡同时"待复习"和"待核对"时归后者的前者，见 `cardBucketV2`。 */
export type ObjectiveCardBucketV2 = "due" | "usable" | "needs_check";

export interface ObjectiveCardGroupV2<TItem extends ObjectiveListItemV2Input = ObjectiveListItemV2Input> {
  /** `noteId`，或 `UNGROUPED_NOTE_KEY`。键稳定：标题改了不换组。 */
  readonly noteKey: string;
  readonly title: string;
  /** §8.5「不按标题猜造」：这一组是真的没有笔记，不是因为读不到标题。 */
  readonly ungrouped: boolean;
  readonly items: readonly TItem[];
  /** 三个数**分开回**，屏上各写各的标签（§8.5「状态来源不同应分别标明」）。 */
  readonly dueCount: number;
  readonly usableCount: number;
  readonly needsCheckCount: number;
}

/**
 * 那一格是不是「待核对」（39 §8.5「待核对卡数」＋ D3 §5.1 的四层只读判定）。
 *
 * **两个来源，缺一不可**：
 *  - `noteChangeImpact.status` 是 `affected` / `uncertain`（引用的段落变了 / 对不上）；
 *  - `freshness === "source_outdated"`（来源已有更新，尚未影响引用）。
 *
 * 只认其中一个的后果是确定的：只认 impact 会漏掉"来源更新了但引用还没判定"那一格，
 * 只认 freshness 会漏掉"来源没变、但引用的那一段被别处改过"。两者都是**读得出来**
 * 的事实，所以两个都算，而屏上要念出哪一个由 `cardBucketV2` 下面的 reason 给出。
 */
export function isNeedsNoteCheckV2(item: Pick<ObjectiveListItemV2Input, "noteChangeImpact" | "freshness">): boolean {
  const impact = item.noteChangeImpact as ObjectiveNoteChangeImpactV1 | null | undefined;
  const impactSaysCheck = impact?.status === "affected" || impact?.status === "uncertain";
  return impactSaysCheck || item.freshness === "source_outdated";
}

/**
 * 那一格是不是「待复习」：**排期行在**（不管今天到没到）。
 *
 * 这个口径是刻意的：§8.5 要的是「本人**待复习**数」——等着回来找她的那些，
 * 含还没到期的。按"今天到期"去数会把「复习 3 天后」的那些算成"可用"，于是组头
 * 那个数在她眼里忽大忽小，而她什么也没做。
 *
 * 「到没到」是**行内**那一层的事：列表行的纸签已经把两者分开说
 * （`objectiveProgressChips`：「复习已到期 N 天」vs「复习 N 天后」），
 * 所以这里不必也不该再判一次——判一次就多一个会分叉的地方。
 */
export function isDueV2(item: Pick<ObjectiveListItemV2Input, "progress">): boolean {
  return typeof item.progress.reviewDueAt === "string" && item.progress.reviewDueAt.length > 0;
}

/**
 * 一张卡归哪一档。**顺序是纪律**：待核对先判。
 *
 * 为什么不是"待复习优先"：§8.5 把待核对单列，是因为它**要用户去核对原文**——
 * 一张既到期又待核对的卡，用户该做的是核对而不是练习。先判到期会让那一张永远
 * 停在"该复习了"，而没人告诉过他原文变了。
 */
export function cardBucketV2(item: ObjectiveListItemV2Input): ObjectiveCardBucketV2 {
  if (isNeedsNoteCheckV2(item)) return "needs_check";
  if (isDueV2(item)) return "due";
  return "usable";
}

/**
 * 把一页列表按笔记成组（39 §8.5）。
 *
 * **组序**：有笔记的按标题排，"未关联笔记"永远**排在最后**——它是切换盘点期的遗留
 * （§8.5「切换盘点中若存在仍有效的无笔记卡」），不是主要内容；让它排在最前面会
 * 把真正的卡组挤出首屏。同名标题**不合并**：两个不同的 `noteId` 就是两篇笔记，
 * 合成一个组等于"按标题猜造"（§8.5 明写不许）。
 *
 * 纯函数，不做分页：分页是读侧的事，屏上分完组再翻页会得到"同一组散在两页"。
 */
export function groupObjectiveCardsByNoteV2<TItem extends ObjectiveListItemV2Input>(
  items: readonly TItem[],
): ObjectiveCardGroupV2<TItem>[] {
  const byKey = new Map<string, { title: string; ungrouped: boolean; items: TItem[] }>();
  for (const item of items) {
    const noteId = item.primaryNoteId;
    const key = noteId ?? UNGROUPED_NOTE_KEY;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.items.push(item);
      // 同一组里标题以**第一条**为准：一组只有一篇笔记，标题理应一致；真不一致时
      // 取第一条而不是拼一堆，那是读侧的数据问题，不该在渲染层编一个标题出来。
      continue;
    }
    byKey.set(key, {
      title: noteId ? (item.primaryNoteTitle ?? "（未命名笔记）") : UNGROUPED_NOTE_LABEL,
      ungrouped: noteId === null,
      items: [item],
    });
  }
  const groups = [...byKey.entries()].map(([noteKey, bucket]) => {
    let dueCount = 0;
    let usableCount = 0;
    let needsCheckCount = 0;
    for (const item of bucket.items) {
      const bucketOf = cardBucketV2(item);
      if (bucketOf === "needs_check") needsCheckCount += 1;
      else if (bucketOf === "due") dueCount += 1;
      else usableCount += 1;
    }
    return {
      noteKey,
      title: bucket.title,
      ungrouped: bucket.ungrouped,
      items: bucket.items,
      dueCount,
      usableCount,
      needsCheckCount,
    };
  });
  groups.sort((a, b) => {
    if (a.ungrouped !== b.ungrouped) return a.ungrouped ? 1 : -1;
    return a.title.localeCompare(b.title, "zh-Hans-CN");
  });
  return groups;
}

