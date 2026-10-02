import { useCompanionHistoryScroll } from "./use-companion-history-scroll";
import { useCompanionPaperPlacement } from "./use-companion-paper-placement";
// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, BookOpenText, CalendarDays, ChevronLeft, FileText, Loader2, MessageCircle, Search, Sparkles, X } from "lucide-react";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import { gatewayErrorMessage } from "../../app/desktop-client";
import { companionMessageText, navChipsStillOutsideMessages, useCompanionChat, type CompanionNavChip } from "../../app/companion-chat-session";
import { stopCompanionSpeech } from "../../app/companion-voice-playback";
import { type CompanionVoiceInput } from "./use-companion-voice-input";
import { CompanionChatRecordArticle, MonthCalendar, highlightText, messageDayKey, messageDayLabel, messageTime, shouldShowRunTrace } from "./CompanionChatRecord";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { visibleTurnFailure } from "./companion-hud-state";
import { CompanionProposalChoice, companionProposalExpired } from "./CompanionProposalChoice";
import { CompanionHistoryComposer } from "./CompanionHistoryComposer";


export function CompanionHistoryDrawer({
  open,
  motionMode,
  voice,
  voiceEnabled,
  input,
  onInputChange,
  onSend,
  onVoiceToggle,
  anchorRef,
  side,
  onBack,
  onClose,
}: {
  readonly open: boolean;
  readonly motionMode: "full" | "lite" | "off";
  /**
   * **同一支麦克风实例**（方案 §2）。抽屉与头顶按钮共用同一个 `phase`/`note`/电平订阅，
   * 否则两处各自录音、互相不知道对方在录。
   */
  readonly voice: CompanionVoiceInput;
  readonly voiceEnabled: boolean;
  readonly input: string;
  readonly onInputChange: (value: string | ((current: string) => string)) => void;
  readonly onSend: () => Promise<boolean | undefined>;
  readonly onVoiceToggle: () => void;
  readonly anchorRef: RefObject<HTMLDivElement | null>;
  readonly side: "left" | "right";
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const chat = useCompanionChat();
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  const [navNote, setNavNote] = useState<string | null>(null);
  const setInput = onInputChange;
  const drawerRef = useRef<HTMLElement>(null);
  const bookSide = useCompanionPaperPlacement(anchorRef, drawerRef, mounted, side);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const stopping = chat.cancelling;
  const turnFailure = visibleTurnFailure(chat);
  /** 单条消息渲染（时间线用）：来自聊天记录库的共享组件。 */
  const renderArticle = useCallback((message: CompanionMessageV1) => (
    <CompanionChatRecordArticle message={message} chat={chat} />
  ), [chat]);
  // 抽屉里"正在说…"的平滑打字机（2026-09-19 流式卡顿）：气泡有显现驱动器，
  // 抽屉此前是裸渲染 draft.text——服务端的 delta 是 24 字/90ms 的节流块，
  // 裸渲染就是一跳一跳的大块。这里按与气泡同一条阅读钟推进，落后太多时
  // 加速追赶，视觉上是连续打字而不是整块砸出来。
  const smoothedDraftText = useSmoothedDraftText(chat.draft);

  // ── 历史浏览（2026-09-19 微信式，二次返工） ───────────────────────────
  // 「聊天记录」不再是第二个窗口：recordOpen 时**同一个抽屉**切换到记录视图
  // （搜索 / 月历筛选 / 时间线），返回箭头回到对话视图——微信的聊天记录就是
  // 与聊天共窗的页内切换。入口只是头部右侧的一个图标按钮。
  const [recordOpen, setRecordOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const pendingProposals = Object.entries(chat.proposalStates).filter(([, state]) => state.phase !== "ready"
    || Boolean(state.deciding) || (state.proposal.status === "pending" && !companionProposalExpired(state.proposal.expiresAt)));
  const [searchInput, setSearchInput] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const { listRef, contentRef, atLatest, prevScrollHeightRef, stickToBottomRef, scrollToLatest, handleListScroll, releaseStick, handleListWheel, handleListTouchMove, handleListTouchStart, pendingJumpRef, jumpNotice, setJumpNotice } = useCompanionHistoryScroll({ chat, open, mounted, recordOpen });

  const [allResult, setAllResult] = useState<{ revision: number; items: readonly CompanionMessageV1[] } | null>(null);
  const [allRequest, setAllRequest] = useState<{ revision: number; status: "loading" | "error"; error?: string } | null>(null);
  const allMessages = allResult?.revision === chat.historyRevision ? allResult.items : null;
  const allLoading = allRequest?.revision === chat.historyRevision && allRequest.status === "loading";
  const allError = allRequest?.revision === chat.historyRevision && allRequest.status === "error" ? allRequest.error : null;

  const ensureAllMessages = useCallback(async () => {
    if (allMessages || allLoading) return;
    const revision = chat.historyRevision;
    setAllRequest({ revision, status: "loading" });
    try {
      const all = await chat.fetchAllMessages();
      // null = 会话/分页基线还没就绪：不缓存空结果，落「可重试」态而不是无限转圈。
      if (all) {
        setAllResult({ revision, items: all });
        setAllRequest((current) => current?.revision === revision ? null : current);
      } else setAllRequest((current) => current?.revision === revision ? { revision, status: "error", error: "完整记录暂时读取失败，请重试。" } : current);
    } catch (error) {
      setAllRequest((current) => current?.revision === revision ? { revision, status: "error", error: gatewayErrorMessage(error) } : current);
    }
  }, [chat, allMessages, allLoading]);

  // 最近消息或工作空间变了，正在查找时立即重取；旧请求的结果带旧 revision，不能冒充新记录。
  const ensureAllMessagesRef = useRef(ensureAllMessages);
  ensureAllMessagesRef.current = ensureAllMessages;
  useEffect(() => {
    if (recordOpen && (searchInput.trim() || calendarOpen || dateFilter)) void ensureAllMessagesRef.current();
  }, [chat.historyRevision, recordOpen, searchInput, calendarOpen, dateFilter]);

  /** 搜索命中：记录页里点一下 → 回根页面定位到那条。 */
  const jumpToMessage = useCallback((id: string) => {
    setJumpNotice(null);
    pendingJumpRef.current = { messageId: id };
    setRecordOpen(false);
    setFilter("all");
  }, []);

  /** 日期筛选：选一天 → 回根页面定位到那天第一条。 */
  const pickDate = useCallback((dayKey: string) => {
    setJumpNotice(null);
    pendingJumpRef.current = { dateKey: dayKey };
    setRecordOpen(false);
    setCalendarOpen(false);
  }, []);

  // 记录视图全量池的三态：加载中 / 失败可重试 / 未就绪。杜绝「null 永远转圈」。
  const poolStateBlock = allLoading && allMessages == null
    ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在载入全部记录…</p>
    : allError
      ? (
        <p className="companion-history__system">
          {allError}
          <button type="button" className="companion-record__retry" onClick={() => void ensureAllMessages()}>重试</button>
        </p>
      )
      : allMessages == null
        ? <p className="companion-history__system">对话记录还没有就绪。</p>
        : null;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const timer = window.setTimeout(() => { setMounted(false); setExiting(false); }, 220);
    return () => window.clearTimeout(timer);
  }, [mounted, open]);

  /**
   * 整窗关闭要把子页一起退掉。关掉的抽屉只是 `return null`，state 全部留着，于是第二次
   * 点「对话记录」直接开在查找页上（实测：重开时搜索框已在屏上、时间线一条都没渲染）。
   * 挂在 `mounted` 落下之后而不是 `open` 转假那一刻——退场那 220ms 画面还在，中途换视图会被看见。
   */
  useEffect(() => {
    if (open || mounted) return;
    setRecordOpen(false);
    setFilter("all");
    setSearchInput("");
    setDateFilter(null);
    setCalendarOpen(false);
  }, [open, mounted]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    const frame = window.requestAnimationFrame(() => {
      (recordOpen ? searchInputRef.current : backButtonRef.current)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, open, recordOpen]);

  useEffect(() => {
    if (!open || !mounted) return undefined;
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    const previouslyInert = app.inert;
    app.inert = true;
    return () => { app.inert = previouslyInert; };
  }, [mounted, open]);

  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    // 自己发言 = 明确想看她的回答：恢复贴底意图。真正的滚动交给 ResizeObserver ——
    // 这一刻消息还没进 DOM，抢跑只会 pin 到一个旧高度上。
    stickToBottomRef.current = true;
    await onSend();
  }, [onSend, input, setInput]);

  /** 停止由调用方先静音（与交互台同一条路径）。 */
  const stopTurn = useCallback(() => {
    stopCompanionSpeech();
    void chat.cancel();
  }, [chat]);

  const openRoute = useCallback(async (chip: CompanionNavChip) => {
    if (!chip.route) return;
    setNavNote(null);
    try {
      await chat.goToRoute(chip.route);
      // 跳转成功的 chip 就地消失（2026-09-19 用户反馈）：提示的使命完成了。
      chat.dismissNavChip(chip.id);
    } catch (error) {
      setNavNote(`跳转失败：${gatewayErrorMessage(error)}`);
    }
  }, [chat]);

  if (!mounted) return null;
  return createPortal(
    <>
      <button
        type="button"
        className="companion-history__scrim"
        data-stage={exiting ? "exiting" : "visible"}
        data-motion={motionMode}
        tabIndex={-1}
        aria-label="关闭对话记录"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="companion-history hud-surface"
        data-companion-owned="true"
        data-side={bookSide}
        data-stage={exiting ? "exiting" : "visible"}
        data-motion={motionMode}
        data-view={recordOpen ? "record" : "chat"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-history-title"
        aria-hidden={exiting || undefined}
        onPointerDownCapture={(event) => {
          if (calendarOpen && event.target instanceof HTMLElement && !event.target.closest(".companion-record__date-wrap")) {
            setCalendarOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (calendarOpen) {
              setCalendarOpen(false);
            } else if (recordOpen) {
              setRecordOpen(false);
              setSearchInput("");
              setDateFilter(null);
            } else {
              onBack();
            }
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
          ) ?? []).filter((element) => element.offsetParent !== null);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
      <header className="companion-history__header">
        <div className="companion-history__heading">
          <h2 id="companion-history-title">我们的对话手记</h2>
          <p><i aria-hidden="true" />{chat.companionName}在旁边 <span>·</span> 这间书房的对话</p>
        </div>
        <div className="companion-history__header-actions">
          {!recordOpen ? <button ref={backButtonRef} type="button" onClick={onBack} aria-label="返回气泡轻聊" title="气泡轻聊"><MessageCircle size={19} /></button> : null}
          {!recordOpen ? (
            <button type="button" onClick={() => setRecordOpen(true)} aria-label="聊天记录" title="查找消息">
              <Search size={20} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="关闭对话记录"><X size={20} /></button>
        </div>
      </header>
      {/* 记录视图专属工具行：搜索 + 自绘月历筛选 */}
      {recordOpen ? (
        <div className="companion-history__toolbar">
          <div className="companion-record__search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchInputRef}
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.currentTarget.value);
                void ensureAllMessages();
              }}
              placeholder="搜索聊天记录"
              aria-label="搜索聊天记录"
            />
            {searchInput ? <button type="button" onClick={() => setSearchInput("")} aria-label="清空搜索词"><X size={12} /></button> : null}
          </div>
          <div className="companion-record__date-wrap">
            <button
              type="button"
              className="companion-record__date-btn"
              data-active={dateFilter != null || calendarOpen || undefined}
              aria-haspopup="true"
              aria-expanded={calendarOpen}
              aria-controls="companion-record-calendar"
              onClick={() => { setCalendarOpen((value) => !value); void ensureAllMessages(); }}
            >
              <CalendarDays size={14} aria-hidden="true" />
              {dateFilter ? messageDayLabel(`${dateFilter}T12:00:00`) : "按日期"}
            </button>
            {calendarOpen ? (
              allMessages ? (
                <MonthCalendar
                  pool={allMessages}
                  selected={dateFilter}
                  onPick={(dayKey) => pickDate(dayKey)}
                />
              ) : <div className="companion-record__calendar-status">{poolStateBlock}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <nav className="companion-history__tabs" aria-label="消息筛选">
        {recordOpen ? <button ref={backButtonRef} type="button" className="text-action" onClick={() => { setRecordOpen(false); setSearchInput(""); setDateFilter(null); }} aria-label="返回对话"><ChevronLeft size={16} />返回对话</button> : <>
          <button type="button" className="text-action" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部对话</button>
          <button type="button" className="text-action" aria-pressed={filter === "pending"} onClick={() => setFilter("pending")}>待确认 <span className="companion-history__count">{pendingProposals.length}</span></button>
        </>}
        <span>{recordOpen ? "找一句说过的话" : messageDayLabel(new Date().toISOString())}</span>
      </nav>
      <div
        ref={listRef}
        className="companion-history__list"
        onScroll={handleListScroll}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
      >
        {/* 内容层：贴底跟随观察它的高度（见上方 pinToLatest 注释）。样式上它接管了
            原 .companion-history__list 的 flex/gap/padding，容器只留 overflow。 */}
        <div ref={contentRef} className="companion-history__content">
          {/* ── 对话视图：日期分组时间线 ── */}
          {!recordOpen && filter === "pending" ? <>
            {pendingProposals.length === 0 ? <div className="companion-record__landing"><Sparkles size={32} /><strong>没有等你确认的事情</strong><p>需要你决定的动作会留在这里。</p></div> : pendingProposals.map(([id, state]) => <div className="companion-history__pending" key={id}>
              <CompanionProposalChoice proposalId={id} state={state} context="history" onDecide={decision => { void chat.decideProposal(id, decision); }} onRetry={() => chat.retryProposal(id)} />
            </div>)}
          </> : !recordOpen ? (
            <>
              {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取对话…</p> : null}
              {chat.historyLoadingOlder ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />加载更早的消息…</p> : null}
              {chat.historyOlderError ? <p className="companion-history__system" role="status">{chat.historyOlderError}<button type="button" className="companion-record__retry" onClick={() => { prevScrollHeightRef.current = listRef.current?.scrollHeight ?? null; void chat.loadOlderMessages(); }}>重试加载</button></p> : null}
              {!chat.historyHasMore && chat.messages.length > 0 ? <p className="companion-history__system">没有更早的消息了</p> : null}
              {chat.messages.map((message, index) => {
                const previous = index > 0 ? chat.messages[index - 1] : null;
                const showDay = !previous || messageDayKey(previous.createdAt) !== messageDayKey(message.createdAt);
                return (
                  <Fragment key={message.id}>
                    {showDay ? <div className="companion-history__day" data-day-key={messageDayKey(message.createdAt)}>{messageDayLabel(message.createdAt)}</div> : null}
                    {renderArticle(message)}
                  </Fragment>
                );
              })}
              {/*
                进行中的一轮（2026-09-19 ③）：历史此前只渲染 `listMessages` 的快照，而
                `companion_messages` 只在 `assistant.final` 的终态事务里才写——于是"她正在说的
                这段话"在历史里根本不存在，用户必须等整轮结束才能看到。`draft` 早就在气泡里
                实时显示了，这里把它按同一条消息的样子折进历史（同一份文本，不另起数据源）。
                过程留痕按 runId 找：进行中那轮的 `assistantMessageId` 还是 null，不能用它匹配。
              */}
              {(() => {
                const draft = chat.draft;
                if (!draft || draft.text.trim().length === 0) return null;
                const trace = chat.runTraces.find((item) => item.summary.runId === draft.runId) ?? null;
                return (
                  <article data-role="assistant" data-live="true">
                    <header><span>{chat.companionName}</span><time>正在说…</time></header>
                    <p>{smoothedDraftText}</p>
                    {trace && shouldShowRunTrace(trace)
                      ? (
                          <CompanionRunTraceView
                            trace={trace}
                            proposalStates={chat.proposalStates}
                            onDecideProposal={(proposalId, decision) => { void chat.decideProposal(proposalId, decision); }}
                            onRetryProposal={(proposalId) => { void chat.retryProposal(proposalId); }}
                          />
                        )
                      : null}
                  </article>
                );
              })()}
              {chat.phase === "sending" && !chat.draft ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />{chat.companionName} 正在结合当前页面想一想…</p> : null}
            </>
          ) : (
            /* ── 聊天记录视图：只负责「找」。选中搜索命中或日期后回到上面的对话时间线定位 ── */
            <>
              {chat.phase === "loading" ? <p className="companion-history__system"><Loader2 className="companion-hud__spin" size={14} />正在读取对话…</p> : null}
              {(() => {
                const keyword = searchInput.trim();
                if (!keyword) {
                  return (
                    <div className="companion-record__landing">
                      <strong>想找回哪一句</strong>
                      <p><b>输入关键词</b><span>在所有对话里搜这句话</span></p>
                      <p><b>点「按日期」</b><span>挑一天，从那天第一条开始看</span></p>
                      <small>点一条，回到它在对话里的原位</small>
                    </div>
                  );
                }
                const needle = keyword.toLowerCase();
                const hits = (allMessages ?? []).filter((message) => companionMessageText(message).toLowerCase().includes(needle));
                return (
                  <>
                    {!calendarOpen ? poolStateBlock : null}
                    {allMessages != null && hits.length === 0 ? <p className="companion-history__system">没有找到包含「{keyword}」的消息</p> : null}
                    {hits.map((message) => (
                      <button key={message.id} type="button" className="companion-record__hit" onClick={() => jumpToMessage(message.id)}>
                        <header><span>{message.role === "user" ? "你" : chat.companionName}</span><time>{messageDayLabel(message.createdAt)} {messageTime(message.createdAt)}</time></header>
                        <p>{highlightText(companionMessageText(message), keyword)}</p>
                      </button>
                    ))}
                    {allMessages != null && hits.length > 0 ? <p className="companion-history__system">共 {hits.length} 条 · 点一条回到它的上下文</p> : null}
                  </>
                );
              })()}
            </>
          )}
        </div>
      </div>
      {/* 跳转至最新消息（微信式）：离开底部后出现，一键回底部。 */}
      {!atLatest && !recordOpen && filter === "all" ? (
        <button type="button" className="button companion-history__jump" onClick={scrollToLatest} aria-label="跳转至最新消息">
          <ArrowDownToLine size={17} aria-hidden="true" />回到最新
        </button>
      ) : null}
      {/* 常驻输入行（方案 §2）：与交互台同一套纸面表单，复用同一条会话，不新开滚动容器。记录视图是纯浏览页，不显示输入行。 */}
      {!recordOpen ? (
      <div className="companion-history__compose-area">
        {chat.feedDiaryAnchor ? <div className="companion-history__quote" data-companion-feed="diary"><BookOpenText size={16} /><span>日记 {chat.feedDiaryAnchor.date}（第 {chat.feedDiaryAnchor.version} 版）——你接着说就行，我不替你发</span><button type="button" onClick={chat.dismissFeedSelection} aria-label="移除引用"><X size={16} /></button></div> : null}
        {chat.feedSelection ? <div className="companion-history__quote"><FileText size={16} /><span>{chat.feedSelection}</span><button type="button" onClick={chat.dismissFeedSelection} aria-label="移除引用"><X size={16} /></button></div> : null}
        <CompanionHistoryComposer input={input} onInputChange={setInput} onSend={sendText} voice={voice} voiceEnabled={voiceEnabled} companionName={chat.companionName} sending={chat.phase === "sending"} stopping={stopping} onStop={stopTurn} onVoiceToggle={onVoiceToggle} onPageActions={() => chat.setMode("actions")} />
      </div>
      ) : null}
      {(() => {
        // 同一条落点如果已经作为 nav 块进了消息，chip 行就不再重复它（§4.8）。
        // chip 行因此只剩"正在跑的这一轮"和"确认后直接给出的落点"两种即时提示。
        const visible = navChipsStillOutsideMessages(chat.navChips, chat.messages);
        return visible.length > 0 && !recordOpen ? <div className="companion-history__nav">{visible.map((chip) => <div key={chip.id}><span>{chip.summary}</span>{chip.route ? <button type="button" onClick={() => void openRoute(chip)}>前往</button> : <small>桌面端暂不支持这个跳转</small>}<button type="button" onClick={() => chat.dismissNavChip(chip.id)} aria-label="知道了"><X size={12} /></button></div>)}</div> : null;
      })()}
      {!recordOpen && jumpNotice ? <p className="companion-history__error" role="status">{jumpNotice}</p> : null}
      {!recordOpen && (navNote || turnFailure) ? <p className="companion-history__error" role="status">{navNote ?? turnFailure}</p> : null}
      </aside>
    </>,
    document.body,
  );
}


/**
 * 抽屉"正在说…"的平滑打字机（2026-09-19 流式卡顿）。
 *
 * 服务端交付是节流块（24 字 / 90ms，实测一轮只有 2–5 块），裸渲染 `draft.text`
 * 就是文字一跳一跳地砸出来。这里把显现收进一条时间线：
 * - 正常一拍（60ms，与气泡阅读钟同一节奏）推进一个字；
 * - 落后超过 `DRAFT_SMOOTH_MAX_LAG_CHARS`（≈3 秒阅读量）就按比例加速追赶，
 *   保证不滞后生成太远——文字到达快的轮次会自动提速，不会越攒越多；
 * - 换轮（runId 变化）从零起算；文本回退（服务端 appendFrom 回写）时切片
 *   天然收短，不额外处理。
 */
const DRAFT_SMOOTH_TICK_MS = 60;

const DRAFT_SMOOTH_MAX_LAG_CHARS = 48;


function useSmoothedDraftText(draft: { runId: string; text: string } | null): string {
  const [shownLength, setShownLength] = useState(0);
  const stateRef = useRef({ runId: "", target: 0, shown: 0 });

  useEffect(() => {
    const state = stateRef.current;
    if (!draft) {
      if (state.target !== 0 || state.shown !== 0) {
        state.target = 0;
        state.shown = 0;
        setShownLength(0);
      }
      return;
    }
    if (state.runId !== draft.runId) {
      state.runId = draft.runId;
      state.target = 0;
      state.shown = 0;
      setShownLength(0);
    }
    state.target = draft.text.length;
  }, [draft]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = stateRef.current;
      if (state.shown >= state.target) return;
      const lag = state.target - state.shown;
      const step = lag > DRAFT_SMOOTH_MAX_LAG_CHARS ? Math.ceil(lag / 12) : 1;
      state.shown = Math.min(state.target, state.shown + step);
      setShownLength(state.shown);
    }, DRAFT_SMOOTH_TICK_MS);
    return () => window.clearInterval(timer);
    // 依赖是**闸门**，不是读数（钟面只碰 `stateRef`，那里永远现值）。以前这里是 `[]`：
    // 本组件在抽屉里无条件挂载，于是这条 60ms 的钟从应用启动一直跑到退出——没有草稿、
    // 没有回包、抽屉从没打开过的时候也在按 16Hz 唤醒主线程。按 `runId` 挂/摘之后，
    // 没有进行中的一轮就没有钟；换轮从零起算的语义不变。
  }, [draft?.runId]);

  const text = draft?.text ?? "";
  return text.slice(0, shownLength);
}
