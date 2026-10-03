/**
 * 复习台的**数据形状**（2026-09-30 从 `ReviewSurface.tsx` 搬出）。
 *
 * ## 为什么单独一个文件
 *
 * `useReviewQueueSelection` 要用 `LoadedReviewQueue` / `ReviewFailure`，
 * 而它们原本是组件文件里的**私有**类型。
 *
 * **为什么不直接搬进那个 hook 文件？** 因为**组件自己也要用**
 * （`fetchPage` 的返回、`setQueue` 的入参都在组件里）——
 * 那就变成「hook 导出类型、组件 import hook」，**方向反了，会成环**。
 *
 * ## ⚠️ 这里**只有两个**类型是搬过来的，一个都没有重写
 *
 * `LoadedReviewQueue` / `ReviewFailure` 是从 `ReviewSurface.tsx` **一字不改**搬来的。
 * `ReviewItem` **本来就有真身**（`./review-deck.ts`）——**直接 re-export，不要再写一份**。
 *
 * 搬它们的理由是同一个：**手写出来的形状必然在细节上偏一点**，
 * 而**运行时完全正常**、只有 tsc 报一片 `is not assignable`：
 * `source` 的四个字面量、`uniqueReviewItems` 的**可变入参**
 * （`ReviewItem[]` 而非 `readonly ReviewItem[]`）、`setQueue` 的**函数式更新**。
 * 2026-09-30 这一天里，同一个错误犯了两次。
 */
import type { ReviewItem } from "./review-deck";

export type { ReviewItem };

export type LoadedReviewQueue = {
  readonly version: 2;
  readonly items: ReviewItem[];
  /** 服务端确认的到期总数；位置行用它，而不是已载入的条数。 */
  readonly total: number;
  readonly nextCursor: string | null;
};

export type ReviewFailure = {
  readonly message: string;
  readonly source: "queue" | "pagination" | "start" | "defer";
  /** Retry stays bound to the failed item even if the reader flips to another card. */
  readonly reviewId?: string;
};
