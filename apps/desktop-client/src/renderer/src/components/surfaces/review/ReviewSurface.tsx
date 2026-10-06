import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Clock3, Leaf, RotateCcw } from "lucide-react";
import type { LearningObjectiveSurfaceV3 } from "@astella/shared/learning-objective-surface-contracts";
import type { ReviewQueueV2 } from "@astella/shared/review-queue-v2-contracts";
import type { AnswerModePreferenceV1 } from "@astella/shared/companion-shell-contracts";
import { answerModeToResponsePreference } from "@astella/shared/companion-shell-contracts";
import { useRoomStore } from "../../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../../app/desktop-client";
import { HudPage } from "../../hud/HudPage";
import { useHudPage } from "../../hud/use-hud-page";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { DUE_REVIEW_START_LABEL } from "@astella/shared/review-action-copy";
import { matchesReviewTarget } from "../../review-focus";
import {
  RECALL_READ_NOTE_LABEL_V1,
  recallRevealReceiptLineV1,
  recallWaitingCueV1,
  recallWaitingLineV1,
} from "../notebook/recall-waiting-presenter.ts";
import { RECALL_REVEAL_COPY_V1, type RecallWaitingKindV1 } from "@astella/shared/recall-waiting-v2-contracts";
import { SurfaceDataState, useDayAnchor } from "../notebook/surface-data.tsx";
import {DECK_DRAG_SLOP, REVIEW_WINDOW_SIZE, deckDragOutcome, deckDragShift, reviewDeckPosition, reviewDeckRound, reviewOverdueLabel, reviewReasonFacts, reviewReasonSentence, reviewReasonTag, reviewSequenceAfter, reviewStartabilityLabel, reviewFormalValidationBlockedLabel, reviewWindowStart, sameReviewSubjectAsEarlierLabel, uniqueReviewItems, type ReviewItem} from "./review-deck.ts";
import type { LoadedReviewQueue, ReviewFailure } from "./review-types";
import { useReviewQueueSelection } from "./use-review-queue-selection";
import { useReviewDeckMotion } from "./use-review-deck-motion";
import { useTactileSurface } from "../../motion/use-tactile-surface";


/** 每次向服务端要多少张到期项。服务端 limit 上限 100，20 让「继续读取」足够轻。 */
const REVIEW_PAGE_SIZE = 20;
/**
 * 自动翻页的上限：恢复阅读位置时最多读这么多页，免得一条深队列把内存拉满。
 */
const MAX_AUTO_PAGES = 25;
/**
 * 一张牌有多宽的兜底值。牌宽是列宽的一个份额，真正的值运行时从布局里量；这个常量
 * 只在量不到时兜底 —— 例如 jsdom 里没有布局。抽牌的判定按牌宽的比例算。
 */
const DECK_REACH_FALLBACK = 520;

/**
 * Page 15 「复习队列」. The mockup's desk is one card in front of a paper stack with
 * a reason slip beside it. Everything the mockup wrote by hand on that slip —
 * how late the card is, how many of its own cards are waiting, how it has
 * already been carried, what comes next — is derived here from the queue the
 * server returns, so the slip stays true as the real queue changes.
 */
export function ReviewSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const activeReviewTarget = useRoomStore((state) => state.activeReviewTarget);
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const storedResume = useRoomStore((state) => state.reviewQueueResume);
  const setReviewQueueResume = useRoomStore((state) => state.setReviewQueueResume);
  useHudPage("queue");

  // The surface is unmounted by TaskSurface on every navigation, so the reading
  // position is taken from the store once and written back on the way out.
  const resumeRef = useRef(storedResume);

  const [queue, setQueue] = useState<LoadedReviewQueue | null>(null);
  const [objectives, setObjectives] = useState<Record<string, LearningObjectiveSurfaceV3>>({});
  const [unreadableObjectiveIds, setUnreadableObjectiveIds] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<ReviewFailure | null>(null);
  const [startingReviewId, setStartingReviewId] = useState<string | null>(null);
  const [deferringReviewId, setDeferringReviewId] = useState<string | null>(null);
  const [deferredNotice, setDeferredNotice] = useState<string | null>(null);
  /**
   * 回忆等待态（PRD §7.1；39d W5-4）。开着时**只**展示标题、提取线索与进度状态。
   *
   * 三条边界在这一处集中，理由与实现写在 `recall-waiting-presenter.ts` 的文件头：
   *  1. 标题**不许**回退到 `publicSummary`（那是从笔记正文生成的摘要＝半个答案）；
   *  2. 两种等待**不共用**会提前揭示答案的内容（`mayReadSource` 由服务端那一档决定）；
   *  3. 「先看笔记」是**一次真实暴露**，落进 `learning_exposures_v2`。
   */
  const [recallWaiting, setRecallWaiting] = useState<{ reviewId: string; kind: RecallWaitingKindV1 } | null>(null);
  /** 点过「先看笔记」之后的那一句回执（屏上必须说，§7.1「如实按本次暴露条件处理」）。 */
  const [recallRevealNotice, setRecallRevealNotice] = useState<string | null>(null);
  const [recallRevealing, setRecallRevealing] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  /** 牌堆的拖拽状态：只影响呈现，不影响选中项。 */
  const [deckDragging, setDeckDragging] = useState(false);
  /**
   * 卡叠自己的焦点环。鼠标点在卡面上、拖着卡滑动，section 同样会拿到焦点，但读者
   * 并不是在用键盘 —— 那时画一个 3px 的红框横在整列卡片外面，只会让人以为出错了。
   * 所以环由这里决定，而不是 CSS 里的 :focus：
   *   · 焦点落下的那一刻浏览器已经算好 :focus-visible（Tab 为真、鼠标点卡面为假），
   *     照它决定；
   *   · 应用明确把焦点交还给卡叠时（走到队尾没有下一张、从今日学习带着目标回来）
   *     直接点亮；
   *   · 指针一碰就撤掉，而且不会自动回来 —— 焦点没变，浏览器不会重算 :focus-visible。
   */
  const [deckRing, setDeckRing] = useState(false);
  const deckRef = useRef<HTMLElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  useTactileSurface(deskRef, "queue");
  const commandBusyRef = useRef(false);
  const selectionIntentRef = useRef(0);
  const epochRef = useRef<number | undefined>(undefined);
  const startCommandIdsRef = useRef(new Map<string, string>());
  const focusedReturnTargetRef = useRef<string | null>(null);
  const returnLookupRef = useRef<{ targetKey: string; attemptedCursors: Set<string> } | null>(null);
  /**
   * 最后一次**有效**的选中序号。队列变短时用它退到同一位置，而不是跳回队首；
   * 只有工作区核对通过后才从恢复位置写入。
   */
  const seatRef = useRef(-1);
  /** 离开页面时交给 store 的是"最后一次有效选中"，所以它也要能被 cleanup 读到。 */
  const selectedReviewIdRef = useRef<string | null>(null);
  const nowMs = useDayAnchor();
  /** One busy flag for the whole action row: no request may start mid-request. */
  const busy = startingReviewId !== null || deferringReviewId !== null;
  /** 拖拽的手势状态。位移另存一份 ref，松手时读到的一定是最新值。 */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    velocity: number;
    moved: boolean;
    base: { x: number; y: number; rotate: number };
  } | null>(null);
  /** 手势里最后一次真正落到牌面上的横向位移；松手判定读它，而不是原始 dx。 */
  const dragShiftRef = useRef(0);
  /** 一张牌的宽度：抽多远的判定按它的比例算。 */
  const deckReachRef = useRef(DECK_REACH_FALLBACK);
  /** 这一次手势是拖拽：浏览器在 pointerup 之后还会补一次 click，那不是点选。 */
  const draggedRecentlyRef = useRef(false);
  /**
   * 松手判定要读的队列边界。它们住在 ref 里，因为收束手势的出口挂在 window 上
   * （见 endDeckGestureRef），而那个监听只注册一次 —— 读渲染闭包里的值会停在
   * 挂载那一刻。逐帧改写是安全的：它们只在这一帧的判定里被读一次。
   */
  const deckBoundsRef = useRef({ canPrevious: false, canNext: false, hasMore: false });
  /** 同上的理由：window 上的收口要能调到当前这一帧的 moveSelection。 */
  const moveSelectionRef = useRef<(offset: number) => void>(() => {});
  /** 同上的理由：window 上的收口要能调到当前这一帧的收束逻辑。 */
  const endDeckGestureRef = useRef<(outcome: "release" | "cancel") => void>(() => {});

  const readSession = useCallback(async () => {
    if (!window.astella) throw new Error("desktop API is unavailable");
    const response = await window.astella.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const session = unwrapGatewayResult(response);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    return session;
  }, []);

  /** 读一页到期项。游标是服务端签发的不透明值，客户端只负责原样回传。 */
  const fetchPage = useCallback(async (cursor: string | undefined) => {
    if (!window.astella) throw new Error("desktop API is unavailable");
    const response = await window.astella.review.getQueue({
      meta: createRequestMeta(epochRef.current),
      ...(cursor ? { cursor } : {}),
      limit: REVIEW_PAGE_SIZE,
    });
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    return unwrapGatewayResult(response);
  }, []);

  /**
   * 读到期队列，一直读到覆盖 `targetIndex` 为止。默认只读第一页；恢复阅读位置
   * 或跳转时按服务端返回的 cursor 继续翻。游标是 (nextReviewAt, id) 复合键，
   * 不随集合增减漂移，所以重复走同一条链永远落在同一批卡上。
   *
   * 服务端重复返回同一个游标说明翻页没有前进：立刻停下，别把「继续读取」
   * 变成死循环（对象库那边的 loadMore 也是同一条规则）。
   */
  const loadQueue = useCallback(async (options: { targetIndex?: number; keepFailure?: boolean } = {}) => {
    await readSession();
    const target = Math.max(0, options.targetIndex ?? 0);
    let items: ReviewItem[] = [];
    let total = 0;
    let cursor: string | undefined;
    let nextCursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_AUTO_PAGES; page += 1) {
      const result = await fetchPage(cursor);
      items = uniqueReviewItems([...items, ...result.items]);
      total = result.total;
      nextCursor = result.nextCursor;
      if (!nextCursor || items.length > target || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    setQueue({ version: 2, items, total, nextCursor });
    if (!options.keepFailure) setFailure(null);
    return items;
  }, [fetchPage, readSession]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const resume = resumeRef.current;
    void loadQueue({ targetIndex: resume?.selectedIndex ?? 0 })
      .then((items) => {
        if (!active || items.length === 0) return;
        // 位置只属于同一个工作区：换空间后「第 40 张」不是同一张卡。epochRef 在
        // loadQueue 的会话读取里已经更新成当前值，所以这里可以核对。
        const sameWorkspace = resume
          && (resume.workspaceEpoch === null || resume.workspaceEpoch === epochRef.current);
        if (!sameWorkspace) return;
        seatRef.current = resume.selectedIndex;
        // 位置先按卡 id 恢复；卡已经不在队列里时交给上面的序号退路。
        if (resume.selectedReviewId) setSelectedReviewId((current) => current ?? resume.selectedReviewId);
      })
      .catch((error) => active && setFailure({ message: gatewayErrorMessage(error), source: "queue" }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadQueue]);

  // 「桌上摆着哪些牌、我脚下是第几张、还能不能往前往后」——队列的规则，不是桌面的摆位。
  const {
    reload, loadMore, selectedIndex, boundary, hasNext, hasPrevious, front, visibleItems, windowStart,
  } = useReviewQueueSelection({
    setReviewQueueResume, epochRef, selectedReviewIdRef, seatRef, deckBoundsRef, startCommandIdsRef,
    queue, selectedReviewId, setSelectedReviewId, loading, failure, setLoading, loadingMore,
    setLoadingMore, setFailure, setQueue, loadQueue, fetchPage,
  });


  const deckMotion = useReviewDeckMotion(deckRef, `${front?.reviewId ?? boundary?.kind}:${visibleItems.map(item => item.reviewId).join(",")}`);

  // The deck only needs the labels of the cards it can show, so the objective
  // read follows the visible window instead of the whole queue.
  const missingObjectiveKey = useMemo(() => {
    const seen = new Set<string>();
    const missing: string[] = [];
    for (const item of visibleItems) {
      if (objectives[item.objectiveId] || seen.has(item.objectiveId)) continue;
      seen.add(item.objectiveId);
      missing.push(item.objectiveId);
    }
    return missing.join(",");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleItems, objectives]);

  useEffect(() => {
    if (!missingObjectiveKey || !window.astella) return;
    let active = true;
    const requested = missingObjectiveKey.split(",");
    void Promise.allSettled(requested.map(async (objectiveId) => {
      const response = await window.astella.objective.get({ meta: createRequestMeta(epochRef.current), objectiveId });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      return { objectiveId, surface: unwrapGatewayResult(response) };
    }))
      .then((settled) => {
        if (!active) return;
        const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const unreadable = requested.filter((_, index) => settled[index]?.status === "rejected");
        if (loaded.length > 0) {
          const loadedIds = new Set(loaded.map((entry) => entry.objectiveId));
          setObjectives((current) => {
            const next = { ...current };
            for (const { objectiveId, surface } of loaded) next[objectiveId] = surface;
            return next;
          });
          // 读到了就不再是「读不到」：这个集合只该留住真正还没有标签的目标。
          setUnreadableObjectiveIds((current) => {
            const next = new Set([...current].filter((objectiveId) => !loadedIds.has(objectiveId)));
            return next.size === current.size ? current : next;
          });
        }
        // A label that cannot be read is not worth blanking the deck for; the
        // card falls back to its real position instead of an invented title. The
        // ids are remembered so the card can say the label is unreadable instead
        // of claiming a read that already finished is still running.
        if (unreadable.length > 0) setUnreadableObjectiveIds((current) => new Set([...current, ...unreadable]));
      });
    return () => { active = false; };
  }, [missingObjectiveKey]);

  const labelOf = useCallback(
    (item: ReviewItem): string | null => {
      const surface = objectives[item.objectiveId];
      return surface?.content.conceptLabel ?? surface?.sources.primaryNote?.title ?? null;
    },
    [objectives],
  );

  useEffect(() => {
    if (!activeReviewTarget) {
      focusedReturnTargetRef.current = null;
      returnLookupRef.current = null;
      return;
    }
    if (!queue) return;
    const targetKey = `${activeReviewTarget.scheduleId}:${activeReviewTarget.objectiveId}`;
    if (returnLookupRef.current?.targetKey !== targetKey) {
      returnLookupRef.current = { targetKey, attemptedCursors: new Set() };
    }
    if (focusedReturnTargetRef.current === targetKey) return;
    const item = queue.items.find((candidate) => matchesReviewTarget(candidate, activeReviewTarget));
    if (!item) {
      if (!queue.nextCursor) {
        setActiveReviewTarget(null);
        return;
      }
      const lookup = returnLookupRef.current;
      if (
        lookup
        && !loadingMore
        && failure?.source !== "pagination"
        && !lookup.attemptedCursors.has(queue.nextCursor)
      ) {
        lookup.attemptedCursors.add(queue.nextCursor);
        void loadMore();
      }
      return;
    }
    if (selectedReviewId !== item.reviewId) {
      setSelectedReviewId(item.reviewId);
      return;
    }
    const deck = deckRef.current;
    if (!deck) return;
    focusedReturnTargetRef.current = targetKey;
    setDeckRing(true);
    const frame = window.requestAnimationFrame(() => deck.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [activeReviewTarget, failure?.source, loadMore, loadingMore, queue, selectedReviewId, setActiveReviewTarget]);

  const focusDeck = useCallback(() => {
    const deck = deckRef.current;
    if (!deck) return;
    setDeckRing(true);
    deck.focus({ preventScroll: true });
  }, []);

  /**
   * 把选中项移动 `offset` 格。往前越过已载入的末尾时先读下一页，而不是把「下一张」
   * 变成死按钮；真的没有下一页时把焦点收回卡叠（按钮会变灰，键盘读者不能停在
   * disabled 的分组里）。
   */
  const moveSelection = (offset: number) => {
    if (commandBusyRef.current || !queue?.items.length || selectedIndex < 0 || offset === 0) return;
    const intent = ++selectionIntentRef.current;
    const lastLoadedIndex = queue.items.length - 1;
    if (offset > 0 && selectedIndex >= lastLoadedIndex) {
      if (!queue.nextCursor) { focusDeck(); return; }
      if (loadingMore) return;
      void (async () => {
        const appended = await loadMore();
        const next = appended?.[0];
        if (intent !== selectionIntentRef.current) return;
        if (next) setSelectedReviewId(next.reviewId);
        else focusDeck();
      })();
      return;
    }
    const next = queue.items[Math.min(lastLoadedIndex, Math.max(0, selectedIndex + offset))];
    if (next) setSelectedReviewId(next.reviewId);
  };
  // 手势收束发生在 window 的监听里（见下），那里读不到这一帧的闭包，所以留一份最新引用。
  moveSelectionRef.current = moveSelection;

  /**
   * 牌堆：最上面那张跟着指针走，松手后要么滑回堆上，要么被抽走。
   *
   * 换牌立即改选中项，弹簧从当前呈现位置和速度追随新的 data-depth。
   * 指针接手时同样从当前位姿开始，松手后把速度交回弹簧。
   * 位移写元素而不是 state：拖拽每秒要改几十次，走 React 会把整张理由条也重渲染。
   */
  const applyDragPose = (x: number, y: number, rotate: number) => {
    const deck = deckRef.current;
    if (!deck) return;
    deckMotion.drag(x, y, rotate);
  };

  /** 把拖拽控制权交回弹簧，继续追随当前的牌堆位置。 */
  const releaseDragPose = (velocity = 0) => {
    deckMotion.release(velocity);
  };

  /**
   * 抽 `steps` 张（±1 来自拖拽、方向键与箭头按钮，>1 来自理由条的「后续顺序」）。
   * 往前抽到已载入的最后一张时，交给 moveSelection 去读下一页 —— 牌堆下面没有牌
   * 的时候不该假装还能抽。
   */
  const drawCard = (steps: number) => {
    if (steps === 0) return;
    releaseDragPose();
    moveSelectionRef.current(steps);
  };

  /**
   * 手势唯一的收束口：卡"跟不跟手"由它决定结束，位姿也由它归位。
   *
   * 判别与归位必须分开的两件事，之前合在 onPointerUp 里，于是只有"抬手落在卡叠
   * 内部"这一条路能收口。实际上抬手会落在卡叠外面的几种情形都收不到那个事件：
   * 指针在理由条/侧栏上松开（事件目标是别的元素，卡叠不在它的祖先链上）、窗口
   * 失去焦点、浏览器撤销这次指针（原生拖拽、系统手势）、指针捕获被收走。收不到
   * 事件不等于手势没结束 —— 读者已经松手了，卡却还挂在半路跟着手，这就是"粘手"。
   * 所以出口放在 window 上（capture + blur + lostpointercapture），来路有很多条。
   *
   * 只有真正的 release 才可能抽牌；cancel 一律滑回堆上，撤销不是"抽走"。
   */
  const endDeckGesture = (outcome: "release" | "cancel") => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDeckDragging(false);
    const shift = dragShiftRef.current;
    dragShiftRef.current = 0;
    // click 紧跟 pointerup：等这一轮事件走完再撤掉"刚拖过"的标记。
    window.setTimeout(() => { draggedRecentlyRef.current = false; }, 0);
    if (outcome === "cancel" || !drag.moved) { releaseDragPose(); return; }
    const velocity = performance.now() - drag.lastT > 120 ? 0 : drag.velocity;
    releaseDragPose(velocity);
    const decision = deckDragOutcome({
      dx: shift,
      reach: deckReachRef.current,
      velocity,
      ...deckBoundsRef.current,
    });
    if (decision === "next" || decision === "load-next") { moveSelectionRef.current(1); return; }
    if (decision === "previous") { moveSelectionRef.current(-1); return; }
    // 没抽出去：牌自己滑回堆上（位移归零，位姿交回 data-depth）。
  };
  endDeckGestureRef.current = endDeckGesture;

  /**
   * 挂一次、管一辈子：手势状态的来路不止卡叠自己的指针事件。事件在 capture
   * 阶段于 window 上先到，卡叠里的 onPointerUp 随后只会看到已经收口的状态。
   */
  useEffect(() => {
    const end = (event: Event) => {
      // blur 不冒泡，但 capture 阶段 window 照样收得到每个元素的失焦 —— 页面里
      // 某颗控件拿到焦点（target 是元素，nodeType 1）不算"读者放下了手"。
      if (event.type === "blur") {
        if ((event.target as Node | null)?.nodeType === 1) return;
        endDeckGestureRef.current("cancel");
        return;
      }
      const pointer = event as PointerEvent;
      if (pointer.pointerId !== dragRef.current?.pointerId) return;
      endDeckGestureRef.current(event.type === "pointerup" ? "release" : "cancel");
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("lostpointercapture", end, true);
    window.addEventListener("blur", end, true);
    return () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("lostpointercapture", end, true);
      window.removeEventListener("blur", end, true);
    };
  }, []);

  const onDeckPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // 指针一碰，上一刻"交还焦点"的环就该让位：读者已经改成用鼠标了。
    setDeckRing(false);
    if (event.button !== 0 || boundary || commandBusyRef.current) return;
    // 控件上的手势属于控件："开始复习 / 查看来源" 的点按语义必须完整保留。
    if ((event.target as HTMLElement).closest("button, a, input, label, summary")) return;
    // 一次只允许一只手势：上一只还没收口（抬手落在了别的窗口）就先按撤销收掉，
    // 否则新手势会带着旧位移继续走。
    if (dragRef.current) endDeckGesture("cancel");
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastT: performance.now(),
      velocity: 0,
      moved: false,
      base: deckMotion.grab(),
    };
    // 拿不到捕获也不影响：卡叠外面的抬手由 window 上的收口兜住。
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* 指针已经不是活动指针时捕获会抛，忽略即可 */
    }
  };

  const onDeckPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    const elapsed = Math.max(1, now - drag.lastT);
    drag.velocity = (event.clientX - drag.lastX) / elapsed;
    drag.lastX = event.clientX;
    drag.lastT = now;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // 小于判定阈值的手势算点击：按在牌上抖一下不该把牌抽走。
      if (Math.hypot(dx, dy) < DECK_DRAG_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) {
        endDeckGesture("cancel");
        try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
        return;
      }
      drag.moved = true;
      draggedRecentlyRef.current = true;
      setDeckDragging(true);
    }
    // 抽牌只按横向算；竖直方向跟着手指走一点（手感），并让牌随位移侧一侧。
    // 「拖不拖得动」问的是**松手会不会前进**，而不是"已经载入了下一张没有"：
    // 已载入的末尾但服务端还有下一页时，松手会顺势读进来再抽走，那一路就该
    // 1:1 跟手；否则读者在最后一页上会先感到一段莫名的阻尼。
    const shift = deckDragShift(dx, dx < 0 ? deckBoundsRef.current.canNext || deckBoundsRef.current.hasMore : deckBoundsRef.current.canPrevious);
    dragShiftRef.current = shift;
    applyDragPose(drag.base.x + shift, drag.base.y + dy * 0.3, drag.base.rotate + Math.max(-14, Math.min(14, shift * 0.04)));
  };

  const onDeckPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    // 收口已经发生在 window 的 capture 监听里（抬手落在卡叠外面时也只到那里），
    // 这里只在"事件确实落在卡叠上、且还没收口"时补一次。
    if (dragRef.current?.pointerId !== event.pointerId) return;
    endDeckGesture("release");
  };

  /**
   * 露在下面的牌本身就是"再抽几张就是它"，点它就该把它抽上来 —— 一张露着边却按不动
   * 的牌只会把读者引到箭头上去。拖拽结束浏览器补的那次 click 不算点选。
   */
  const onDeckClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!draggedRecentlyRef.current) return;
    draggedRecentlyRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // 牌的宽度决定"抽多远算抽出去"，所以从布局里量；窗口变化时重新量。
  useLayoutEffect(() => {
    const card = deckRef.current?.querySelector<HTMLElement>('.deck-card[data-depth="0"]');
    deckReachRef.current = card && card.offsetWidth > 0 ? card.offsetWidth : DECK_REACH_FALLBACK;
  }, [visibleItems, selectedIndex]);

  useEffect(() => {
    const measure = () => {
      const card = deckRef.current?.querySelector<HTMLElement>('.deck-card[data-depth="0"]');
      if (card && card.offsetWidth > 0) deckReachRef.current = card.offsetWidth;
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /**
   * 账号「作答方式」偏好（doc 34 L15）。读不到就当未设置（"any" → 服务端按情况
   * 编排）：这一个值只是开跑时的一个提示参数，不该因为偏好读失败而点不动「开始复习」。
   */
  const readAnswerMode = useCallback(async (): Promise<AnswerModePreferenceV1> => {
    const gateway = window.astella;
    if (!gateway) return "any";
    try {
      const response = await gateway.companion.answerMode.get({ meta: createRequestMeta(epochRef.current) });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      return unwrapGatewayResult(response).preference;
    } catch {
      return "any";
    }
  }, []);

  /**
   * 「先看笔记」（PRD §7.1；§16.24）。
   *
   * **先记账，再导航**——次序是有意的：先跳走、后记账的话，用户在笔记页还没
   * 读完就关掉窗口，那一笔就没记上，而下一次回忆会被算成独立提取。
   * 记账这一发是幂等的（同一把 `commandId`），重复点只记一笔。
   *
   * §16.24「揭示、提醒处理和能力证据**分开记录**」：这一发**只**写暴露账，
   * 不碰提醒（`review_schedules`）、不写学习观察——所以用户点它**不会**
   * 把这次提醒关掉，也不会改这一轮的能力证据。
   */
  const readNoteBeforeRecall = async (item: ReviewItem, kind: RecallWaitingKindV1) => {
    if (!window.astella || recallRevealing) return;
    const commandId = `recall-source-reveal-${item.reviewId}`;
    setRecallRevealing(true);
    setRecallRevealNotice(null);
    try {
      const response = await window.astella.review.recordRecallSourceReveal({
        meta: createRequestMeta(epochRef.current),
        objectiveId: item.objectiveId,
        waitingKind: kind,
        idempotencyKey: commandId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setRecallRevealNotice(recallRevealReceiptLineV1(kind));
      // 记账成功之后才开笔记：屏上那句回执与"材料就在这儿"必须同时到。
      const surface = objectives[item.objectiveId] ?? null;
      const note = surface?.sources.primaryNote;
      if (note) {
        setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.noteVersionId, mode: "preview" });
        invoke("open-notebook");
      } else {
        setActiveObjectiveId(item.objectiveId);
        invoke("open-objective");
      }
    } catch (error) {
      // 记不上就**说记不上**，而且**不跳**（跳过去等于假装已经记过）。
      setRecallRevealNotice(`没能记下"先看笔记"这一步：${gatewayErrorMessage(error)}你可以直接去看，但这一次的条件我们没能如实记下。`);
    } finally {
      setRecallRevealing(false);
    }
  };

  const startReview = async (item: ReviewItem) => {
    if (item.startability.kind !== "ready" || commandBusyRef.current || !window.astella) return;
    commandBusyRef.current = true;
    selectionIntentRef.current += 1;
    const commandId = startCommandIdsRef.current.get(item.reviewId) ?? createCommandId("start-review");
    startCommandIdsRef.current.set(item.reviewId, commandId);
    setStartingReviewId(item.reviewId);
    setActiveReviewTarget(null);
    focusedReturnTargetRef.current = null;
    setFailure(null);
    // 等待态从这一发**开始**（§7.1「进入回忆模式后、准备题目或等待生成时」）。
    // 起点是用户按下那颗按钮的那一刻，不是 run 建好之后——题目生成的那一段
    // 正是泄露最容易发生的地方。
    setRecallWaiting({ reviewId: item.reviewId, kind: "independent_recall" });
    setRecallRevealNotice(null);
    const answerMode = await readAnswerMode();
    try {
      const response = await window.astella.learningRun.start({
        meta: createRequestMeta(epochRef.current),
        commandId,
        request: {
          version: 2,
          originV2: {
            kind: "review",
            scheduleId: item.scheduleId,
            objectiveId: item.objectiveId,
            scheduleGeneration: item.scheduleGeneration,
          },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 180,
          // 硬写的 "adaptive" 就是 L15：设置页那个选择在复习这条路上从来没生效。
          // 映射只认 shared 的那一张表，界面不再自己判。
          responsePreference: answerModeToResponsePreference(answerMode),
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const snapshot = unwrapGatewayResult(response);
      startCommandIdsRef.current.delete(item.reviewId);
      setActiveRunId(snapshot.runId);
      invoke("validate");
    } catch (error) {
      const refreshRequired = error instanceof RendererGatewayError
        && ["conflict", "not_found", "feature_disabled", "validation"].includes(error.code);
      // 等待态在这一发上**结束**。此前全文件只有 setRecallWaiting(...) 的写入端，
      // 没有任何一处把它撤掉：于是起跑一失败，这张卡永远停在"正在准备这一道题…题面好了
      // 会叫你"，题面被藏着、没有取消、上一张的「先看笔记」回执也黏着——一张死了的卡。
      setRecallWaiting(null);
      setRecallRevealNotice(null);
      if (refreshRequired) {
        startCommandIdsRef.current.delete(item.reviewId);
        setFailure({ message: gatewayErrorMessage(error), source: "start", reviewId: item.reviewId });
        // loadQueue 结尾那句 setFailure(null) 会把刚设好的"为什么没开始"抹掉。
        // 刷新与保留失败是两件事，所以这里显式说"别抹"。
        void loadQueue({ targetIndex: seatRef.current, keepFailure: true }).catch((refreshError) => {
          setFailure({ message: gatewayErrorMessage(refreshError), source: "queue" });
        });
      } else {
        setFailure({ message: gatewayErrorMessage(error), source: "start", reviewId: item.reviewId });
      }
    } finally {
      commandBusyRef.current = false;
      setStartingReviewId(null);
    }
  };

  /**
   * 方案 16 §18.3 的展示层延后：卡在 deferredUntil 之前不再出现在到期队列，
   * 但 official 到期时间不变——这不是完成复习，只是「明天再提醒我」。
   */
  const deferFront = async (item: ReviewItem) => {
    if (commandBusyRef.current || !window.astella) return;
    commandBusyRef.current = true;
    selectionIntentRef.current += 1;
    setDeferringReviewId(item.reviewId);
    setDeferredNotice(null);
    setFailure(null);
    try {
      const response = await window.astella.review.defer({
        meta: createRequestMeta(epochRef.current),
        request: {
          scheduleId: item.scheduleId,
          scheduleGeneration: item.scheduleGeneration,
          deferredUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          reasonCode: "user_requested",
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setDeferredNotice("已把这一项推迟到明天再提醒；它的到期时间没有变。");
      // 保留阅读深度：被延后的那张消失后，读者应该停在同一个位置上。
      await loadQueue({ targetIndex: seatRef.current });
      focusDeck();
    } catch (error) {
      if (error instanceof RendererGatewayError && (error.code === "conflict" || error.code === "not_found")) {
        setDeferredNotice("这一项的状态刚变过，队列已经按最新情况刷新。");
        await loadQueue({ targetIndex: seatRef.current })
          .then(() => focusDeck())
          .catch((refreshError) => {
            setFailure({ message: gatewayErrorMessage(refreshError), source: "queue" });
          });
      } else {
        setFailure({ message: gatewayErrorMessage(error), source: "defer", reviewId: item.reviewId });
      }
    } finally {
      commandBusyRef.current = false;
      setDeferringReviewId(null);
    }
  };

  // 回执是一次确认，不是常驻状态：看完就该消失，否则它会在读者翻到别的卡之后
  // 还挂在那里说上一张卡的事。
  useEffect(() => {
    if (!deferredNotice) return undefined;
    const timer = window.setTimeout(() => setDeferredNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [deferredNotice]);

  const frontSurface = front ? objectives[front.objectiveId] ?? null : null;

  /**
   * 卡面正文对整行都是同一套说法：滑到左右两边的牌也会显示自己的问题，读者在拖
   * 之前就知道下一张是什么。读不到的标签不编标题，改为说明"读不到"。
   */
  const questionOf = (item: ReviewItem): string => {
    const surface = objectives[item.objectiveId];
    if (surface) return surface.content.conceptLabel ?? surface.content.publicSummary;
    return unreadableObjectiveIds.has(item.objectiveId)
      ? "这一项暂时读不到标题"
      : "正在读取这一项的问题…";
  };
  const originOf = (item: ReviewItem): string => {
    const surface = objectives[item.objectiveId];
    if (!surface) {
      return unreadableObjectiveIds.has(item.objectiveId)
        ? "已排到的到期复习 · 这一项暂时读不到标题"
        : "这一项是排到时间的到期复习";
    }
    if (surface.sources.primaryNote) return `来自笔记《${surface.sources.primaryNote.title}》`;
    if (surface.content.sourceLabel) return `来自来源「${surface.content.sourceLabel}」`;
    return item.cardId === null ? "来自这条学习目标" : "来自这张学习卡";
  };

  const openNoteEvidence = (surface: LearningObjectiveSurfaceV3 | null, noteId: string) => {
    const origin = surface?.sources.origins.find((candidate) =>
      candidate.kind === "note" && candidate.noteId === noteId);
    setActiveNoteRef({
      noteId,
      noteVersionId: origin?.kind === "note" ? origin.noteVersionId : null,
      mode: "preview",
    });
    invoke("open-notebook");
  };

  /** 同一学习目标在这批队列里有几项到期。 */
  /**
   * 这一次等待态（第 7.1）。**只在真的发起了「开始到期复习」之后**才成立：
   * 题目还在生成的那一段里，屏上能摆的就是这几样。
   *
   * `kind` 是**服务端那一档**决定的（`originV2.kind = "review"` ⇒ 独立回忆），
   * 界面不自己猜——猜错的后果是 `mayReadSource` 取反，于是独立回忆那一档
   * 提示"材料就在旁边"，那正是 §7.1 要防的那一句。
   */
  const recallWaitingForFront = Boolean(front && recallWaiting?.reviewId === front.reviewId);
  const recallCue = useMemo(() => (recallWaitingForFront && front
    ? recallWaitingCueV1({
      kind: recallWaiting?.kind ?? "independent_recall",
      surface: objectives[front.objectiveId] ?? null,
      unreadableReason: objectives[front.objectiveId] ? null : "这一张的题面暂时读不到，下面只有线索。",
    })
    : null), [front, objectives, recallWaiting, recallWaitingForFront]);

  const relatedCards = front && queue
    ? queue.items.filter((item) => item.objectiveId === front.objectiveId).length
    : 0;
  /** 已载入队列覆盖到多少个不同的学习目标。 */
  const affectedObjectives = queue ? new Set(queue.items.map((item) => item.objectiveId)).size : 0;
  const reason = front
    ? reviewReasonFacts(front, relatedCards, nowMs, Math.max(0, selectedIndex), affectedObjectives)
    : null;
  const reasonTag = reason ? reviewReasonTag(reason) : null;
  const repeatedSubjectLabel = queue && selectedIndex >= 0
    ? sameReviewSubjectAsEarlierLabel(queue.items, selectedIndex)
    : null;
  const sequence = front && queue
    ? reviewSequenceAfter(queue.items, selectedIndex, labelOf)
    : [];
  const isReturnTarget = Boolean(front && matchesReviewTarget(front, activeReviewTarget));
  const readyCount = queue?.items.filter((item) => item.startability.kind === "ready").length ?? 0;
  /** The card's own state chip; `null` while the card can simply be started. */
  const frontNoteImpact = frontSurface?.noteChangeImpact ?? null;
  const noteEvidenceNeedsCheck = Boolean(frontNoteImpact && frontNoteImpact.status !== "unaffected");
  const blockedLabel = noteEvidenceNeedsCheck
    ? "先核对原文"
    : front && front.startability.kind !== "ready"
      ? reviewStartabilityLabel(front)
      : null;
  /** 位置行对齐服务端总数：已载入 20 张不等于队列只有 20 张。 */
  const deckTotal = Math.max(queue?.total ?? 0, queue?.items.length ?? 0);
  /**
   * 进度条是"整条队列"的比例，不是"已载入窗口"的比例：共 300 张时第 5 张就该是
   * 一点点，已读进来的部分用浅色垫在下面，读者一眼能看出还剩多少没读到。
   */
  const seatRatio = deckTotal > 0 ? (selectedIndex + 1) / deckTotal : 0;
  const loadedRatio = deckTotal > 0 ? (queue?.items.length ?? 0) / deckTotal : 0;
  /**
   * The slip's "到期" fact. The queue only hands out schedules the server already
   * considers due, so the same label answers every card — one fact, one wording.
   */
  const dueLine = front ? reviewOverdueLabel(front.dueAt, nowMs) : "时间未提供";
  /**
   * What the slip says with no card to explain. A failed read must not read as
   * "今天没有到期项": the deck beside it already names which state happened.
   */
  const slipState = loading
    ? "正在读取排好的到期顺序。"
    : failure?.source === "queue"
      ? "暂时没读到队列。连接恢复后，再来看看需要温习的卡片。"
      : queue && queue.items.length > 0
        ? `已载入 ${queue.items.length} 项，服务端确认共 ${deckTotal} 项。`
        : "按自己的节奏来。回书桌看看，或写下一点新的想法。";
  /**
   * Stepping the deck rewrites the card in place, so the card that just arrived
   * is announced here; the repaint alone reaches only sighted pointer users.
   */
  const deckAnnouncement = front
    ? frontSurface
      ? `${reviewDeckPosition(selectedIndex, deckTotal)}，${questionOf(front)}`
      : reviewDeckPosition(selectedIndex, deckTotal)
    : boundary?.message ?? "";

  /**
   * 复习队列登记给伴星读的可读视图（doc 37）。
   *
   * 位置句、总数、可开始数、当前这张的状态字全部复用页面已经在算的那几个派生值
   * （`reviewDeckPosition` / `deckTotal` / `readyCount` / `blockedLabel`），
   * 空态与错误态走 `boundary`——她说"今天没有到期项"之前，得先真的读到这一句。
   */
  const readableView = useMemo<PageReadableV1 | null>(() => {
    if (!queue && !boundary) return null;
    const items = queue?.items ?? [];
    return {
      pageId: "review_queue",
      title: "到期复习",
      statusLine: items.length > 0 ? reviewDeckPosition(selectedIndex, deckTotal) : boundary?.message ?? "",
      metrics: [
        { label: "已载入", value: `${items.length} 项` },
        { label: "服务端确认", value: `${deckTotal} 项` },
        { label: "可直接开始", value: `${readyCount} 项` },
      ],
      items: items.slice(0, 8).map((item, index) => ({
        ordinal: index + 1,
        label: (labelOf(item) ?? "这一项还没有可读的标题").slice(0, 60),
        ...(index === selectedIndex ? { state: (blockedLabel ?? "可开始").slice(0, 24) } : {}),
      })),
      ...(boundary ? { notice: `${boundary.message}：${boundary.detail.slice(0, 60)}` } : {}),
    };
  }, [blockedLabel, boundary, deckTotal, labelOf, queue, readyCount, selectedIndex]);
  usePageReadableView(readableView);

  return (
    <HudPage page="queue">
      <div ref={deskRef} className="queue-desk review-queue card-experience">
        <header className="review-queue__welcome">
          <span className="review-queue__emblem" aria-hidden="true"><BookOpen size={26} strokeWidth={1.8} /></span>
          <div><span className="review-queue__eyebrow">书房里的温习时间</span><h2>和学过的知识，再见一面</h2></div>
          {queue && !boundary ? <span className="review-queue__count"><b>{deckTotal}</b> 项到期</span> : null}
          {deferredNotice ? <p className="review-queue__receipt" role="status"><Leaf size={17} aria-hidden="true" />{deferredNotice}</p> : null}
        </header>
        {/* 卡叠只挂 down/move/up 三条指针来路；pointercancel、抬手落在卡叠外面、
            窗口失焦都归 window 上的收束口（见 endDeckGesture）—— 出口只有一个。 */}
        <section
          ref={deckRef}
          className="card-deck"
          role="group"
          aria-label="复习队列"
          tabIndex={0}
          data-review-id={front?.reviewId}
          data-review-return-focus={isReturnTarget ? "true" : undefined}
          data-deck-dragging={deckDragging ? "true" : undefined}
          data-deck-ring={deckRing ? "true" : undefined}
          onFocus={(event) => {
            // Read the modifier eagerly: React clears `currentTarget` when the
            // handler returns, and the state updater runs after that. Reading it
            // lazily threw on the first focus and took the whole tree down.
            const ringVisible = event.currentTarget.matches(":focus-visible");
            setDeckRing((current) => current || ringVisible);
          }}
          onBlur={() => setDeckRing(false)}
          onKeyDown={(event) => {
            // 长按会以约 30 次/秒重复触发；每次都会换掉带 key 的正文并重放
            // 淡入，正文会在接近全透明处抖动。按住不放只算一次移动。
            if (event.repeat || event.target !== event.currentTarget) return;
            if (event.key === "ArrowLeft") { event.preventDefault(); drawCard(-1); }
            if (event.key === "ArrowRight") { event.preventDefault(); drawCard(1); }
          }}
          onClickCapture={onDeckClickCapture}
          onPointerDown={onDeckPointerDown}
          onPointerMove={onDeckPointerMove}
          onPointerUp={onDeckPointerUp}
        >
          {/* 换卡是整行滑动，看得见的那一下就是反馈；看不到牌面的读者靠这句。 */}
          <p className="sr-only" role="status">{deckAnnouncement}</p>

          {boundary ? (
            /* 状态纸也是卡槽里唯一的一张牌：同一套堆位规则，它才落在正中。 */
            <article className="deck-card front" data-depth="0">
              <SurfaceDataState
                {...boundary}
                onRetry={boundary.kind === "error" ? () => reload() : undefined}
                action={boundary.kind === "empty" ? (
                  <div className="actions">
                    {/* 空队列的下一步是回到今日学习：主行动走主按钮，与卡面上那颗
                        「开始到期复习」共用同一套主按钮语言。 */}
                    <button type="button" className="button primary" onClick={() => invoke("continue")}>
                      回到今日学习<ArrowRight size={15} aria-hidden="true" />
                    </button>
                    <button type="button" className="button" onClick={() => invoke("open-notebook")}>继续写笔记</button>
                  </div>
                ) : undefined}
              />
            </article>
          ) : visibleItems.map((item, offset) => {
              const seat = windowStart + offset;
              const isFront = item.reviewId === front?.reviewId;
              const surface = objectives[item.objectiveId] ?? null;
              const stateLabel = item.startability.kind === "ready" ? null : reviewStartabilityLabel(item);
              const noteImpact = isFront ? surface?.noteChangeImpact ?? null : null;
              const needsNoteCheck = Boolean(noteImpact && noteImpact.status !== "unaffected");
              const cardStateLabel = needsNoteCheck ? "先核对原文" : stateLabel;
              // 审计 F28：只有当前这张需要印缺口说明；后面的卡在它成为当前卡时再印。
              const evidenceGapLabel = isFront ? reviewFormalValidationBlockedLabel(item) : null;
              return (
                /* 一行里每张卡只挂一次，换卡只改整行的居中位移：React 不重建节点，
                   滑动过程里没有重新挂载，也没有第二份 id 抢标签。 */
                <article
                  key={item.reviewId}
                  className={`deck-card${isFront ? " front" : ""}`}
                  data-depth={seat - selectedIndex}
                  data-drawn={seat < selectedIndex ? "true" : undefined}
                  aria-hidden={isFront ? undefined : "true"}
                  aria-labelledby={isFront ? "review-deck-question" : undefined}
                  onClick={isFront ? undefined : () => drawCard(seat - selectedIndex)}
                >
                  <div className="deck-card__body">
                    <div className="review-card__bookmark" aria-hidden="true"><Leaf size={18} /></div>
                    <div className="meta">
                      <span>{reviewDeckPosition(seat, deckTotal)}</span>
                      <span>{item.cardId === null ? "笔记复习" : "学习卡复习"}</span>
                      <span className="review-card__round">{reviewDeckRound(item.scheduleGeneration)}</span>
                      {cardStateLabel ? <span className="tag deck-card__state">{cardStateLabel}</span> : null}
                    </div>
                    {/* 等待态（§7.1）：**只**给标题、提取线索与进度状态。
                        题面那一句（`questionOf`，它会回退到 `publicSummary`）在
                        等待期间不画——`publicSummary` 是从笔记正文生成的摘要，
                        摆出来就是半个答案。这一条由
                        `recall-waiting-presenter.test.ts` 钉住。 */}
                    {isFront && recallCue ? (
                      <div className="deck-card__waiting" data-recall-waiting={recallCue.kind} role="status">
                        <h2 id="review-deck-question">{recallCue.title ?? "这一道暂时没给标题"}</h2>
                        <p className="sub">{recallWaitingLineV1(recallCue.kind)}</p>
                        <p className="small deck-card__progress" aria-live="polite">{recallCue.progressLabel}</p>
                        {recallCue.clues.length > 0 ? (
                          <ul className="deck-card__clues" aria-label="提取线索">
                            {recallCue.clues.map((clue, index) => <li key={`${index}-${clue}`}>{clue}</li>)}
                          </ul>
                        ) : (
                          <p className="small deck-card__clues-empty">{RECALL_REVEAL_COPY_V1.noClue}</p>
                        )}
                        {/* 「先看笔记」在**两档里都在**（§7.1「用户仍可主动选择」）。
                            独立回忆那一档不给 `mayReadSource` 的自动提示，但出口
                            本身必须留着——藏起来就等于没有这个出口。 */}
                        <div className="actions">
                          <button
                            type="button"
                            className="button"
                            disabled={busy || recallRevealing}
                            onClick={() => void readNoteBeforeRecall(item, recallCue.kind)}
                          >
                            {recallRevealing ? "正在记下…" : RECALL_READ_NOTE_LABEL_V1}
                          </button>
                        </div>
                        {recallRevealNotice ? (
                          <p className="small deck-card__reveal-notice" role="status" data-recall-reveal-notice="true">
                            {recallRevealNotice}
                          </p>
                        ) : null}
                        {recallCue.mayReadSource ? (
                          <p className="small deck-card__may-read">材料就在旁边，可以边读边等。</p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <h2 id={isFront ? "review-deck-question" : undefined}>{questionOf(item)}</h2>
                        <p className="sub">{originOf(item)}</p>
                      </>
                    )}
                    {/* 审计 F28：这张到期卡的正式验证现在判不出结论（评分点缺冻结
                        证据）。它必须印在卡面上、紧挨着主按钮——理由条在旁边的纸上，
                        而用户是看着这颗按钮决定要不要投入时间的。 */}
                    {isFront && evidenceGapLabel ? (
                      <p className="small deck-card__evidence-gap" role="status">
                        {evidenceGapLabel}
                        <button
                          type="button"
                          className="text-action text-action--strong"
                          disabled={busy}
                          onClick={() => {
                            const note = surface?.sources.primaryNote;
                            if (item.cardId === null && note) {
                              openNoteEvidence(surface, note.noteId);
                            } else {
                              setActiveObjectiveId(item.objectiveId);
                              invoke("open-objective");
                            }
                          }}
                        >
                          去看这条目标还缺什么
                        </button>
                      </p>
                    ) : null}
                    {needsNoteCheck && noteImpact ? (
                      <p className="small deck-card__note-impact" role="status">
                        <Leaf size={14} aria-hidden="true" />
                        <span>
                          <strong>伴星提醒：</strong>
                          {noteImpact.status === "affected"
                            ? "这项复习引用的原文有新变化，先回去看一眼。"
                            : "暂时对不上这项复习的原文依据，先回笔记核对。"}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  {isFront ? (
                    <>
                      <div className="actions review-card__actions">
                        {needsNoteCheck ? (
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => noteImpact && openNoteEvidence(surface, noteImpact.noteId)}
                          >
                            先核对原文<ArrowRight size={15} aria-hidden="true" />
                          </button>
                        ) : evidenceGapLabel ? (
                          <button type="button" className="button primary" disabled={busy} onClick={() => { setActiveObjectiveId(item.objectiveId); invoke("open-objective"); }}>
                            去补齐依据<ArrowRight size={15} aria-hidden="true" />
                          </button>
                        ) : item.startability.kind === "ready" ? (
                          <button
                            type="button"
                            className="button primary"
                            disabled={busy}
                            onClick={() => void startReview(item)}
                          >
                            {startingReviewId === item.reviewId
                              ? "正在准备…"
                              /* 词读共享常量（不是本地字面量）：同一个动作在笔记页／目标页
                                 由服务端签发「开始到期复习」，这里少一个字就是两个来源。 */
                              : <>{DUE_REVIEW_START_LABEL}<ArrowRight size={15} aria-hidden="true" /></>}
                          </button>
                        ) : (
                          <button type="button" className="button" disabled={busy} onClick={reload}>
                            <RotateCcw size={14} aria-hidden="true" />刷新开始条件
                          </button>
                        )}
                        {/* 有主笔记就开笔记，否则落到学习卡页——同一个「查看来源」
                            的两条去路，不是两颗按钮。 */}
                        {!needsNoteCheck ? <button
                          type="button"
                          className="button review-card__source"
                          disabled={busy || !surface}
                          onClick={() => {
                            const note = surface?.sources.primaryNote;
                            if (note) {
                              setActiveNoteRef({ noteId: note.noteId, noteVersionId: note.noteVersionId });
                              invoke("open-notebook");
                              return;
                            }
                            setActiveObjectiveId(item.objectiveId);
                            invoke("open-objective");
                          }}
                        >
                          查看来源
                        </button> : null}
                        <button
                          type="button"
                          className="button review-card__defer"
                          disabled={busy}
                          onClick={() => void deferFront(item)}
                        >
                          <Clock3 size={15} aria-hidden="true" />{deferringReviewId === item.reviewId ? "正在延后…" : "明天再提醒"}
                        </button>
                      </div>
                    </>
                  ) : null}
                </article>
              );
            })}

          {front ? (
            <div className="deck-foot">
              <span className="deck-progress" aria-hidden="true">
                <span className="deck-progress__loaded" style={{ transform: `scaleX(${loadedRatio})` }} />
                <span className="deck-progress__bar" style={{ transform: `scaleX(${seatRatio})` }} />
              </span>
              <span className="deck-foot__hint">拖动卡片，或用 ← → 翻看</span>
              {/* 箭头按钮是与拖拽等价的一条路：键盘和不愿意拖的读者都靠它。 */}
              {queue && (queue.items.length > 1 || queue.nextCursor) ? (
                <div className="deck-nav" role="group" aria-label="在到期项之间移动">
                  <button
                    type="button"
                    className="deck-nav__step"
                    onClick={() => drawCard(-1)}
                    disabled={!hasPrevious || busy}
                    aria-label="上一张到期项"
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="deck-nav__step"
                    onClick={() => drawCard(1)}
                    disabled={!hasNext || busy || loadingMore}
                    aria-busy={loadingMore || undefined}
                    aria-label={queue.nextCursor && selectedIndex >= queue.items.length - 1
                      ? "读取下一张到期项"
                      : "下一张到期项"}
                  >
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </div>
              ) : null}

            </div>
          ) : null}
        </section>

        <aside className="queue-reason review-queue__pocket" aria-label="当前复习项与后续顺序">
          {front ? <>
            <div className="review-queue__pocket-heading"><Leaf size={18} aria-hidden="true" /><h3>接下来翻哪张</h3></div>
            {sequence.length > 0 ? <ol className="review-queue__sequence">
              {sequence.map(stop => <li key={stop.reviewId}><button type="button" disabled={busy} aria-label={`滑到「${stop.label}」`} onClick={() => drawCard(stop.offset)}>
                <span className="review-queue__ordinal" aria-hidden="true">{selectedIndex + stop.offset + 1}</span><span>{stop.label}</span><ArrowRight size={14} aria-hidden="true" />
              </button></li>)}
            </ol> : <p className="review-queue__tail">{queue?.nextCursor ? "后面还有小卡片，翻到这里时会接着读。" : "这就是最后一张啦。按自己的节奏来。"}</p>}
            <details className="review-queue__why" open>
              <summary>为什么轮到它<ChevronDown size={15} aria-hidden="true" /></summary>
              {reasonTag ? <span className={reasonTag.tone ? `tag ${reasonTag.tone}` : "tag"}>{reasonTag.label}</span> : null}
              {reason ? <p>{reviewReasonSentence(reason)}</p> : null}
              {repeatedSubjectLabel ? <p className="small">{repeatedSubjectLabel}</p> : null}
              {reason && !reason.ready ? <p className="small">到期：{dueLine}<br />同一学习目标：{reason.relatedCards} 项到期</p> : null}
            </details>
            <p className="small review-queue__loaded">已载入 {queue?.items.length ?? 0} / {deckTotal} 项<span>涉及 {affectedObjectives} 个学习目标</span></p>
            {queue?.nextCursor ? <button type="button" className="queue-reason__more" onClick={() => void loadMore()} disabled={loadingMore || busy}>{loadingMore ? "正在读取…" : "继续读取更多到期项"}<ArrowRight size={14} aria-hidden="true" /></button> : null}
          </> : <div className="review-queue__rest"><Leaf size={32} aria-hidden="true" /><h3>{boundary?.kind === "empty" ? "留一点时间给自己" : "小卡片正在路上"}</h3><p>{slipState}</p></div>}
          {failure && queue?.items.length ? <div className="queue-reason__failure" role="alert">
            <p>{failure.source === "pagination" ? "继续读取失败，已载入的到期项仍然保留。" : failure.source === "start" ? "还没收到「已经开始」的回音；再点一次不会重复开始。" : failure.source === "defer" ? "延后没送出去，这一项还在队列里。" : "队列刷新失败，当前到期项仍然保留。"}</p>
            <p className="small">{failure.message}</p>
            {failure.source === "pagination" ? <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>重试读取</button> : failure.source === "queue" ? <button type="button" onClick={reload}>重新读取</button> : (() => {
              const failedItem = queue.items.find(item => item.reviewId === failure.reviewId);
              return failedItem ? <button type="button" disabled={busy} onClick={() => failure.source === "start" ? void startReview(failedItem) : void deferFront(failedItem)}>{failure.source === "start" ? "重试开始" : "重试延后"}</button> : null;
            })()}
          </div> : null}
        </aside>
      </div>
    </HudPage>
  );
}
