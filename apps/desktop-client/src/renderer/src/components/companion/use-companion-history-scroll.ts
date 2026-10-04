import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { messageDayKey, messageDayLabel } from "./CompanionChatRecord";



/**
 * 距底多少像素以内算「已经在最新」。
 *
 * 此前判据是 `< 160`，而一个展开的「执行过程」气泡正好约 120px：最新正文被输入框
 * 压掉一整个气泡时，distance 仍落在 160 以内 → 既不算离开底部（不重贴底），
 * 「最新」按钮也不出现（`CompanionHistoryDrawer` 靠 `!atLatest` 渲染它）。
 * 遮挡因此完全不可见、也不可自救。收紧到几个像素，只用来吸收亚像素舍入。
 */
const AT_BOTTOM_SLACK_PX = 4;
export function useCompanionHistoryScroll({ chat, open, mounted, recordOpen }: { chat: CompanionChatSession; open: boolean; mounted: boolean; recordOpen: boolean }) {

  const listRef = useRef<HTMLDivElement>(null);

  /** 内容层（滚动容器的唯一子节点）：贴底跟随要观察它的高度，见 pinToLatest 注释。 */
  const contentRef = useRef<HTMLDivElement>(null);

  const [atLatest, setAtLatest] = useState(true);

  const prevScrollHeightRef = useRef<number | null>(null);

  /**
   * 用户是否希望列表跟着最新内容走。上滚阅读时置 false，发送/打开抽屉/点「最新」时
   * 置回 true —— 否则新消息流式增长会把人从正在读的那条上硬拽回底部。
   */
  const stickToBottomRef = useRef(true);

  /** 触摸起始/上一点的 Y，用来判断手指是在「往下拖看历史」还是「往上拖看新消息」。 */
  const touchAnchorRef = useRef<number | null>(null);

  const messagesRef = useRef(chat.messages);

  messagesRef.current = chat.messages;


  // 向前翻页时的滚动锚定：prepend 会让浏览器把视口内容整体推下去，这里按高度差拉回来。
  useEffect(() => {
    const list = listRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (!list || prevHeight == null) return;
    prevScrollHeightRef.current = null;
    list.scrollTop = list.scrollHeight - prevHeight + list.scrollTop;
  }, [chat.messages.length]);


  useEffect(() => {
    if (chat.historyOlderError) prevScrollHeightRef.current = null;
  }, [chat.historyOlderError]);


  /** 无条件贴到底部。ResizeObserver 与「打开抽屉」两处共用同一个写入口。 */
  const pinToLatest = useCallback(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, []);


  const scrollToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setAtLatest(true);
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, []);


  const handleListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || recordOpen || pendingJumpRef.current) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= AT_BOTTOM_SLACK_PX;
    setAtLatest(atBottom);
    // 这里**只负责恢复**贴底意图，绝不关闭它。关闭只由用户输入判定（见 releaseStick）：
    // 用 scroll 事件反推会被程序化滚动误伤——打开抽屉时先贴底，内容随后还在长高
    // （图片解码、runTraces 落地），那一下 scroll 的 distance>0 就把意图关掉，
    // 之后的贴底跟随整个失效（实测最后一条被切掉 51px / 101px）。
    if (atBottom) stickToBottomRef.current = true;
    if (list.scrollTop <= 56 && chat.historyHasMore && !chat.historyLoadingOlder && !chat.historyOlderError) {
      prevScrollHeightRef.current = list.scrollHeight;
      void chat.loadOlderMessages();
    }
  }, [chat, recordOpen]);


  /** 用户主动往上翻 = 正在读历史，停止自动贴底，直到再次触底或点「最新」。 */
  const releaseStick = useCallback(() => {
    stickToBottomRef.current = false;
  }, []);


  /**
   * 滚轮只在**向上**时松手。向下的滚轮到底之前 distance 一直 >0，若一并松手，
   * 用户往下滚的过程中每次内容长高都不再跟随，反而更糟。
   */
  const handleListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) releaseStick();
  }, [releaseStick]);


  const handleListTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const previousY = touchAnchorRef.current;
    const currentY = event.touches[0]?.clientY ?? null;
    if (currentY != null) {
      // 手指往下移 = 内容往上走 = 回看历史。
      if (previousY != null && currentY > previousY) releaseStick();
      touchAnchorRef.current = currentY;
    }
  }, [releaseStick]);


  const handleListTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchAnchorRef.current = event.touches[0]?.clientY ?? null;
  }, []);


  // ── 微信式「选中即回根页面跳转」（2026-09-19 三次返工的正确模型） ──────
  // 聊天记录页只负责「找」：搜索框、日历、结果列表。用户选中搜索命中或日期后，
  // **关闭聊天记录页、回到历史会话根页面**，由根页面滚动定位到那条消息 /
  // 那一天的第一条消息。时间线永远只存在于根页面，不出现第二个消息窗口。
  const pendingJumpRef = useRef<{ messageId?: string; dateKey?: string } | null>(null);

  const chatRef = useRef(chat);

  chatRef.current = chat;

  const [jumpNotice, setJumpNotice] = useState<string | null>(null);


  /** 等一帧：补页 setState 后必须等 React commit + 布局完成，refs/查询才反映新列表。 */
  const nextFrame = useCallback(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  }), []);


  /**
   * 定位并闪烁。日期跳转优先滚到那天的**日期分界线**（data-day-key 锚点），
   * 分界线在那天第一条消息的正上方——直接滚消息居中会把分界线裁出视口。
   * 双 rAF：第一帧等 commit，第二帧等 prepend 后的布局稳定。
   */
  const flashMessage = useCallback((messageId: string, dayKey?: string) => new Promise<boolean>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) { resolve(false); return; }
        const element = (dayKey ? list.querySelector(`[data-day-key="${dayKey}"]`) : null)
          ?? list.querySelector(`[data-message-id="${messageId}"]`);
        if (!element) { resolve(false); return; }
        // 搜索/日期定位意味着用户正在读旧消息。先撤销贴底意图，并在真正完成
        // scrollIntoView 之后才清掉 pendingJumpRef，避免 ResizeObserver 抢回底部。
        stickToBottomRef.current = false;
        const messageBox = element.getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        // 只移动消息列表，避免 scrollIntoView 同时滚动外层纸面或页面。
        list.scrollTop += messageBox.top - listBox.top - Math.max(0, (list.clientHeight - messageBox.height) / 2);
        setAtLatest(list.scrollHeight - list.scrollTop - list.clientHeight <= AT_BOTTOM_SLACK_PX);
        element.setAttribute("data-flash", "true");
        window.setTimeout(() => element.removeAttribute("data-flash"), 1600);
        resolve(true);
      });
    });
  }), []);


  // 聊天记录页关闭后，在根页面执行待处理的跳转（消息可能要向前补页才找得到）。
  // pendingJumpRef **直到跳转完成才清空**：补页过程中每次 messages.length 变化
  // 都会触发「自动定位到最新」effect，它靠这个 ref 判断要不要让路——提前清空
  // 就会被一路滚回底部，跳转被覆盖（实测：点搜索命中后永远落在最新一条）。
  // 抽屉中途关闭时跳转挂起，等下次打开继续。
  useEffect(() => {
    if (!open || !mounted || recordOpen) return;
    const pending = pendingJumpRef.current;
    if (!pending) return;
    let cancelled = false;
    void (async () => {
      if (pending.messageId) {
        let guard = 0;
        const present = () => messagesRef.current.some((message) => message.id === pending.messageId);
        while (!present() && chatRef.current.historyHasMore && guard < 30) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
          await nextFrame();
          if (cancelled) return;
        }
        if (cancelled) return;
        if (!present()) {
          pendingJumpRef.current = null;
          setJumpNotice("没有定位到那条消息（可能超出可加载范围）");
          return;
        }
        const located = await flashMessage(pending.messageId);
        if (cancelled) return;
        pendingJumpRef.current = null;
        if (!located) setJumpNotice("没有定位到那条消息，请重试搜索");
        return;
      }
      if (pending.dateKey) {
        let guard = 0;
        const oldestDay = () => (messagesRef.current[0] ? messageDayKey(messagesRef.current[0].createdAt) : "9999-99-99");
        while (guard < 40 && chatRef.current.historyHasMore && oldestDay() > pending.dateKey) {
          guard += 1;
          await chatRef.current.loadOlderMessages();
          await nextFrame();
          if (cancelled) return;
        }
        if (cancelled) return;
        const first = messagesRef.current.find((message) => messageDayKey(message.createdAt) === pending.dateKey);
        if (!first) {
          pendingJumpRef.current = null;
          setJumpNotice(`${messageDayLabel(`${pending.dateKey}T12:00:00`)}没有聊天记录`);
          return;
        }
        const located = await flashMessage(first.id, pending.dateKey);
        if (cancelled) return;
        pendingJumpRef.current = null;
        if (!located) setJumpNotice("没有定位到那天的消息，请重试按日期查找");
      }
    })();
    return () => { cancelled = true; };
  }, [open, mounted, recordOpen, flashMessage, nextFrame]);


  // ── 贴底跟随（方案 §3.8）───────────────────────────────────────────────
  // 此前是「一次性 rAF pin」：依赖 messages.length 变化后打一发 scrollTop=scrollHeight。
  // 但让列表长高的三件事都发生在那一发**之后**：
  //   ① 「执行过程」气泡由 1600ms 轮询填进 runTraces（不在旧依赖里），在最后一段的
  //      下方挂载，scrollHeight 当场长高一整个气泡；
  //   ② 流式草稿按 60ms tick 逐字增长（也不在旧依赖里）；
  //   ③ composer / navChips / 错误行是 `.companion-history` 的**兄弟行**
  //      （grid: auto minmax(0,1fr) auto auto auto），它们出现时 1fr 行的 clientHeight
  //      变小而 scrollHeight 不变 —— 底部边缘照样切掉一截。
  // scrollTop 不动而可视区变矮或内容变高，最新正文就只露一半。
  //
  // 改为观察两个几何量：内容层撑高（①②）与滚动容器自身变矮（③）。只观察容器看不到
  // 前者，所以 DOM 上把内容单独包了一层 .companion-history__content。
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content || !open || !mounted) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // 有待处理跳转时让路：补页与居中定位不能被贴底覆盖（见 pendingJumpRef 注释）。
      if (recordOpen || frame || !stickToBottomRef.current || pendingJumpRef.current) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        // 搜索跳转或用户上滚可能发生在排队后的这一帧，执行时再次核对意图。
        if (recordOpen || !stickToBottomRef.current || pendingJumpRef.current) return;
        pinToLatest();
      });
    });
    observer.observe(list);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, mounted, recordOpen, pinToLatest]);


  // Conversation opens at the latest message; record/task pages open at their heading.
  useEffect(() => {
    if (!open || !mounted) return;
    if (pendingJumpRef.current) return;
    if (recordOpen) { stickToBottomRef.current = false; if (listRef.current) listRef.current.scrollTop = 0; return; }
    stickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(pinToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [open, mounted, recordOpen, pinToLatest]);
return { listRef, contentRef, atLatest, prevScrollHeightRef, stickToBottomRef, scrollToLatest, handleListScroll, releaseStick, handleListWheel, handleListTouchMove, handleListTouchStart, pendingJumpRef, jumpNotice, setJumpNotice };
}
