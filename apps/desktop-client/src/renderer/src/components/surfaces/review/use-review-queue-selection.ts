/**
 * 复习台的**队列与选中**（2026-09-30 从 `ReviewSurface.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * `ReviewSurface` 原来 1382 行、**单个组件 1310 行**——`component-size-guard` 的软线是
 * 1200。这一段回答的是「**桌上现在摆着哪些牌、我脚下是第几张、还能不能往前往后**」：
 *
 * · 离开页面时把阅读位置交回 store（下次进来停在上次那张）
 * · `reload` / `loadMore` 两个取数动作
 * · 窗口重新可见时静默重读（别处完成了某张，回到页面要跟上）
 * · 默认落点的选择（**这里有审计 F28 的硬规矩**，不是「默认第一张」）
 * · 牌堆窗口的起止与可见切片
 *
 * 这些是**队列的规则**，不是**桌面的摆位**。留在组件里，
 * 读摆位的人要一路滑过它们才知道「为什么这里只显示 5 张」。
 *
 * ## 拆的是位置，不是行为
 *
 * 一行没改，依赖数组一个没动。**审计 F28 那段规矩原样保留**——
 * 队首若是「正式验证缺冻结证据」的条目，它的结算必然 fail closed，
 * 默认落点必须跳过它，否则主操作又把人引到注定无效的路上。
 *
 * ## 那些 ref 为什么标成 `MutableRefObject`
 *
 * `deckBoundsRef`（手势在 `window` 的收束口里结算）与 `startCommandIdsRef`
 * （离开队列的卡要清掉幂等命令 id）**是这个 hook 在写**。
 * 标成 `RefObject` 就写成只读了，而**运行时照样能改**（ref 就是个对象），
 * tsc 却会在别处报出一片与真因无关的错误。
 * `epochRef` / `selectedReviewIdRef` / `seatRef` 同理——读也要写。
 *
 * ## deps 的类型一个都没有手写
 *
 * `Dispatch<SetStateAction<…>>` / `MutableRefObject<…>` 是 React 的原样类型；
 * `LoadedReviewQueue` / `ReviewFailure` / `ReviewItem` 来自 `./review-types`
 * （**从组件那边搬过去的，不是重写的**）。
 * 2026-09-30 这一天，同一个错误犯了两次：**手写 deps 类型 → 33 条 `is not assignable`
 * 而运行时完全正常**。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { gatewayErrorMessage } from "../../../app/desktop-client";
import { REVIEW_WINDOW_SIZE, reviewWindowStart, uniqueReviewItems } from "./review-deck";
import type { LoadedReviewQueue, ReviewFailure, ReviewItem } from "./review-types";

/** 这一段要驱动组件的哪些状态与引用。 */
export type ReviewQueueSelectionDeps = {
  readonly setReviewQueueResume: (value: {
    workspaceEpoch: number | null;
    selectedReviewId: string | null;
    selectedIndex: number;
  }) => void;
  readonly epochRef: MutableRefObject<number | undefined>;
  readonly selectedReviewIdRef: MutableRefObject<string | null>;
  readonly seatRef: MutableRefObject<number>;
  readonly deckBoundsRef: MutableRefObject<{ canPrevious: boolean; canNext: boolean; hasMore: boolean }>;
  readonly startCommandIdsRef: MutableRefObject<Map<string, string>>;
  readonly queue: LoadedReviewQueue | null;
  readonly selectedReviewId: string | null;
  readonly setSelectedReviewId: Dispatch<SetStateAction<string | null>>;
  readonly loading: boolean;
  readonly failure: ReviewFailure | null;
  readonly setLoading: Dispatch<SetStateAction<boolean>>;
  readonly loadingMore: boolean;
  readonly setLoadingMore: Dispatch<SetStateAction<boolean>>;
  readonly setFailure: Dispatch<SetStateAction<ReviewFailure | null>>;
  readonly setQueue: Dispatch<SetStateAction<LoadedReviewQueue | null>>;
  readonly loadQueue: (options: { targetIndex: number }) => Promise<unknown>;
  readonly fetchPage: (cursor: string) => Promise<LoadedReviewQueue>;
};

/** 队列侧派生出来、组件要摆位用到的东西。 */
export type ReviewQueueSelection = {
  readonly reload: () => void;
  readonly loadMore: () => Promise<ReviewItem[] | null>;
  readonly selectedIndex: number;
  readonly boundary: {
    readonly kind: "loading" | "error" | "empty";
    readonly message: string;
    readonly detail: string;
  } | null;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly front: ReviewItem | null;
  readonly visibleItems: ReviewItem[];
  /** 组件后面还要用（拖拽的落点计算）——所以带出去。 */
  readonly windowStart: number;
};

export function useReviewQueueSelection(deps: ReviewQueueSelectionDeps): ReviewQueueSelection {
  const {
    setReviewQueueResume, epochRef, selectedReviewIdRef, seatRef, deckBoundsRef, startCommandIdsRef,
    queue, selectedReviewId, setSelectedReviewId, loading, failure, setLoading, loadingMore,
    setLoadingMore, setFailure, setQueue, loadQueue, fetchPage,
  } = deps;

  // 离开页面时把阅读位置交回 store。只存位置，不存数据：回来时按位置重新读到
  // 的永远是服务端当前的真实队列。
  useEffect(() => () => {
    setReviewQueueResume({
      workspaceEpoch: epochRef.current ?? null,
      selectedReviewId: selectedReviewIdRef.current,
      selectedIndex: seatRef.current,
    });
  }, [setReviewQueueResume]);

  const reload = useCallback(() => {
    setLoading(true);
    setFailure(null);
    void loadQueue({ targetIndex: seatRef.current })
      .catch((error) => setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => setLoading(false));
  }, [loadQueue]);

  const loadMore = useCallback(async () => {
    const cursor = queue?.nextCursor;
    if (!cursor || loadingMore) return null;
    setLoadingMore(true);
    setFailure(null);
    try {
      const page = await fetchPage(cursor);
      setQueue((current) => current
        ? {
            version: 2,
            items: uniqueReviewItems([...current.items, ...page.items]),
            total: page.total,
            // 同一个游标回来 = 没有前进：停在这里，按钮不再是无底洞。
            nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          }
        : current);
      return page.items;
    } catch (error) {
      setFailure({ message: gatewayErrorMessage(error), source: "pagination" });
      return null;
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, queue?.nextCursor]);

  // 复习可能在页面停在队列时于别处被完成或延后；窗口重新可见时静默重读——
  // 成功才换数据，失败保留桌上已有的队列，与 useSurfaceProjection 的 silent
  // 语义一致。重读深度跟着当前选中位置走，所以翻过的页和脚下的这张都不会丢。
  const silentRefreshRef = useRef(false);
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === "hidden" || silentRefreshRef.current) return;
      silentRefreshRef.current = true;
      void loadQueue({ targetIndex: seatRef.current })
        .catch(() => {
          // A failed silent re-read keeps the readable queue; it never turns
          // the desk into an error state.
        })
        .finally(() => { silentRefreshRef.current = false; });
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [loadQueue]);

  const selectedIndex = queue?.items.findIndex((item) => item.reviewId === selectedReviewId) ?? -1;
  selectedReviewIdRef.current = selectedReviewId;

  const boundary = loading
    ? { kind: "loading" as const, message: "正在读取复习队列", detail: "正在确认真实到期项与开始条件。" }
    : failure?.source === "queue" && !queue?.items.length
      ? { kind: "error" as const, message: "无法读取真实复习队列", detail: failure.message }
      : queue && queue.items.length === 0
        ? { kind: "empty" as const, message: "今天没有到期项", detail: "现在没有可以开始的到期复习。" }
        : null;

  /**
   * 往后/往前还有没有牌。`hasNext` 把"服务端还有下一页"也算进去，所以按钮不会在
   * 已载入的末尾变灰；`loadedNext` 只数已经拿到的卡，拖拽靠它区分"滑一格"和
   * "该读下一页了"。
   */
  const loadedNext = Boolean(queue && selectedIndex >= 0 && selectedIndex < queue.items.length - 1);
  const loadedPrevious = selectedIndex > 0;
  const hasNext = loadedNext || Boolean(queue?.nextCursor);
  const hasPrevious = loadedPrevious;
  // 松手判定与阻尼都发生在 window 的收束口里，那里读不到这一帧的闭包，所以留一份。
  deckBoundsRef.current = {
    canPrevious: loadedPrevious,
    canNext: loadedNext,
    hasMore: Boolean(queue?.nextCursor),
  };

  // 只记录有效的座位：队列换掉的那一帧 selectedIndex 是 -1，不能用它覆盖记忆。
  useEffect(() => {
    if (selectedIndex >= 0) seatRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    if (!queue?.items.length) {
      setSelectedReviewId(null);
      return;
    }
    setSelectedReviewId((current) => {
      if (current && queue.items.some((item) => item.reviewId === current)) return current;
      // 脚下的卡被别处复习掉或延后了：留在同一位置，不回到队首。
      const seat = seatRef.current >= 0
        ? queue.items[Math.min(seatRef.current, queue.items.length - 1)]
        : null;
      /**
       * 审计 F28：队首那张如果是「正式验证缺冻结证据」的条目，它的结算必然
       * fail closed——用户做完一切、排程也不动。默认落点要跳过这种条目，
       * 否则主操作又把人引到那条注定无效的路上；它仍留在队列里，只是不当
       * 默认落点（`?? queue.items[0]` 兜底：整条队列都有缺口时才落到它）。
       */
      const firstCompletable = queue.items
        .slice(0, REVIEW_WINDOW_SIZE)
        .find((item) => item.startability.kind === "ready" && item.formalValidationBlocked === null);
      return seat?.reviewId
        ?? firstCompletable?.reviewId
        ?? queue.items.find((item) => item.startability.kind === "ready")?.reviewId
        ?? queue.items[0].reviewId;
    });
  }, [queue]);

  // 已离开队列的卡不再需要记着幂等命令 id；不清理的话它会随会话一直长。
  useEffect(() => {
    if (!queue) return;
    const live = new Set(queue.items.map((item) => item.reviewId));
    for (const reviewId of [...startCommandIdsRef.current.keys()]) {
      if (!live.has(reviewId)) startCommandIdsRef.current.delete(reviewId);
    }
  }, [queue]);

  const front = selectedIndex >= 0 ? queue?.items[selectedIndex] ?? null : null;
  const windowStart = reviewWindowStart(selectedIndex, queue?.items.length ?? 0);
  const windowEnd = Math.min(windowStart + REVIEW_WINDOW_SIZE, queue?.items.length ?? 0);
  const visibleItems = useMemo(
    () => queue?.items.slice(windowStart, windowEnd) ?? [],
    [queue, windowEnd, windowStart],
  );

  return { reload, loadMore, selectedIndex, boundary, hasNext, hasPrevious, front, visibleItems, windowStart };
}
