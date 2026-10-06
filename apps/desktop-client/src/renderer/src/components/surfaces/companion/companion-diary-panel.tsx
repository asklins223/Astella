import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type { CompanionDailyFailureReasonV1,CompanionDailySummaryV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { CalendarDays,ChevronDown,ChevronLeft,ChevronRight } from "lucide-react";
import { useEffect,useMemo,useRef,useState } from "react";
import { useRoomStore } from "../../../app/room-store";
import { CompanionQuoteBlock,CompanionRecordImage,MonthCalendar } from "../../companion/CompanionChatRecord";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatDate } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { CenterFeedback,SectionState } from "./companion-center-primitives";
import { diaryDayLabel,shiftIsoDate,todayIsoDate } from "./companion-diary-day";
import { DiscoveryKeepAction, DiscoveryKeepFeedback, type DiscoveryKeepProps, type DiscoveryKeepRequest } from "./companion-discovery-offer";
import { diaryDiscoveryParagraphs } from "./companion-discovery-targets";

const DIARY_FAILURE_DETAIL: Record<CompanionDailyFailureReasonV1 | "unknown", string> = {
  consent_required: "日记要由她来写，而「允许发送到外部模型服务」没有开启。开启后从第二天开始写。",
  model_unavailable: "她试了几次没写出来，明天会再试。",
  diary_output_invalid: "她写回来的东西还是在报数，不像日记，没有收下来。",
  unknown: "不会用推测内容填充这一天。",
};

const DIARY_LOADING = "正在读取日记";

const DIARY_UNAVAILABLE = "日记当前不可用";

const DIARY_DAY_FAILED = "这一天她没能写下来";

const DIARY_DAY_EMPTY = "这一天还没有日记";

export function DiaryPanel(props: {
  section: Section<CompanionDailySummaryV1> | null;
  loading: boolean;
  failure: string | null;
  date: string | null;
  onDate: (value: string | null) => void;
  onMemory: (id: string) => void;
  /**
   * 「聊聊这篇」（40 §6 / A08）。
   *
   * 它**只**打开对话并附上这篇的引用，不替用户发消息——所以这里传出去的是
   * 日期与版本，不是一句已经写好的提问。
   */
  onDiscussDiary: (reference: { readonly date: string; readonly version: number }) => void;
  /**
   * §10：隐藏 / 取消隐藏 / 删除。三件事**语义不同**，所以是三个回调而不是
   * 一个带 action 的——调用点读起来不该需要再想一遍哪个按钮会删掉东西。
   */
  onHideDiary: () => void;
  onUnhideDiary: () => void;
  onDeleteDiary: () => void;
  confirmDeleteDiary: boolean;
  onConfirmDeleteDiary: (value: boolean) => void;
  /** 三个写动作共用一条 busy 闩：并发点两次会撞唯一索引。 */
  busy: boolean;
  /** §11.1「展示实际范围与结果」：服务端报回来的范围/失败原因原样落在这里。 */
  notice?: string | null;
  onRetry: () => void;
  marks: ReadonlyMap<string, "generated" | "failed"> | null;
  marksFailure: string | null;
  onMarksMonth: (month: string) => void;
  discoveryFor?: (request: DiscoveryKeepRequest) => DiscoveryKeepProps;
  sourceTarget?: { sourceId: string; revision?: number } | null;
  onSourceConsumed?: () => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLButtonElement>(null);
  // 折叠面板的收起条件：点外面、Escape。选中一天后由 onPick 自己关。
  useEffect(() => {
    if (!calendarOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setCalendarOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 必须声明这次按键被吃掉了：App 的全局 Escape（window 上，冒泡比 document 晚）
      // 看到 defaultPrevented 才会放手，否则关日历的同时把人弹出伴星中心。
      event.preventDefault();
      event.stopPropagation();
      setCalendarOpen(false);
      dateRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [calendarOpen]);
  const diaryReadableView = useMemo<PageReadableV1 | null>(() => {
    const shell = (statusLine: string, notice?: string): PageReadableV1 => ({
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine,
      ...(notice ? { notice } : {}),
    });
    if (props.loading && !props.section) return shell(DIARY_LOADING);
    if (!props.section) return shell(DIARY_UNAVAILABLE, props.failure ? `${DIARY_UNAVAILABLE}：${props.failure.slice(0, 60)}` : undefined);
    if (!props.section.ok) return shell(DIARY_UNAVAILABLE, `${DIARY_UNAVAILABLE}：${props.section.message.slice(0, 60)}`);
    const daily = props.section.value;
    const day = props.date ?? daily.date ?? todayIsoDate();
    if (daily.status !== "generated") {
      // 这一屏上面那颗日期胶囊仍然写着（`companion-date-nav` 在这句状态之前渲染），
      // 所以日期进 `filters`；`statusLine` **只用屏上那句原话**，不拼成"原话 · 日期"
      // ——拼出来的那一句屏幕上根本没有（同一条规矩在这一批里第三次应验）。
      const line = daily.status === "failed" ? DIARY_DAY_FAILED : DIARY_DAY_EMPTY;
      const detail = daily.status === "failed" ? DIARY_FAILURE_DETAIL[daily.failureReason ?? "unknown"] : undefined;
      return {
        ...shell(line, detail ? `${line}：${detail}` : undefined),
        filters: [{ label: "日期", value: diaryDayLabel(day).slice(0, 40) }],
      };
    }
    // 只登记她自己写的那几段正文（`<p class="companion-diary-prose">`）；
    // 引文块与图片块由别的组件渲染，这里没有可逐字对上的屏幕文本，就不编。
    const prose = diaryDiscoveryParagraphs(daily);
    const reasonItem = daily.selectionReason
      ? [{ ordinal: 1, label: `她选了这段：${daily.selectionReason}` }]
      : [];
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供",
      filters: [{ label: "日期", value: diaryDayLabel(day).slice(0, 40) }],
      ...(prose.length > 0 || reasonItem.length > 0
        ? {
            items: [
              ...reasonItem,
              ...prose.map((block, index) => ({
                ordinal: reasonItem.length + index + 1,
                label: block.text.slice(0, 120),
              })),
            ].slice(0, 12),
          }
        : {}),
    };
  }, [props.date, props.failure, props.loading, props.section]);
  usePageReadableView(diaryReadableView);
  const daily = props.section?.ok ? props.section.value : null;
  const sourceTarget = props.sourceTarget;
  const paragraphs = daily ? diaryDiscoveryParagraphs(daily) : [];
  const sourceRef = useRef<HTMLDivElement>(null);
  const motionOff = useRoomStore(state => state.reducedMotion || state.motionMode === "off");
  useEffect(() => {
    if (!sourceTarget || !daily || props.loading || sourceTarget.revision && sourceTarget.revision !== daily.revision) return;
    const target = [...(sourceRef.current?.querySelectorAll<HTMLElement>("[data-source-id]") ?? [])].find(element => element.dataset.sourceId === sourceTarget.sourceId);
    target?.scrollIntoView({ block: "center", behavior: motionOff ? "auto" : "smooth" });
    target?.focus({ preventScroll: true });
    props.onSourceConsumed?.();
  }, [sourceTarget, daily, props.loading, motionOff, props.onSourceConsumed]);
  const anchor = props.date ?? daily?.date ?? todayIsoDate(); const today = todayIsoDate();
  return <div className="cc-diary">
    <div className="cc-diary-nav" ref={navRef}>
      <button type="button" className="cc-icon-button" disabled={props.busy} aria-label="前一天" onClick={() => props.onDate(shiftIsoDate(anchor, -1))}><ChevronLeft size={17} /></button>
      <div className="cc-diary-nav__pick">
        <button ref={dateRef} type="button" className="cc-diary-nav__date" disabled={props.busy} aria-expanded={calendarOpen} aria-controls="companion-diary-calendar" aria-label={`选择日记日期，当前 ${diaryDayLabel(anchor)}`} onClick={() => setCalendarOpen(value => !value)}>
          <CalendarDays size={16} aria-hidden="true" /><span>{diaryDayLabel(anchor)}</span><ChevronDown size={14} aria-hidden="true" />
        </button>
        {calendarOpen ? <MonthCalendar key={anchor} panelId="companion-diary-calendar" selected={anchor} maxDay={today} marks={props.marks} onMonthChange={props.onMarksMonth} onPick={day => { props.onDate(day); setCalendarOpen(false); dateRef.current?.focus(); }} footer={props.marksFailure ? <p>这个月的日记标记暂时读不到。</p> : null} /> : null}
      </div>
      <button type="button" className="cc-icon-button" disabled={anchor >= today || props.busy} aria-label="后一天" onClick={() => props.onDate(shiftIsoDate(anchor, 1))}><ChevronRight size={17} /></button>
      {props.date !== null ? <button type="button" className="cc-link" disabled={props.busy} onClick={() => props.onDate(null)}>最新一篇</button> : null}
    </div>
    <CenterFeedback notice={props.notice ?? null} />
    {!daily ? <SectionState message={props.loading ? DIARY_LOADING : DIARY_UNAVAILABLE} detail={props.section && !props.section.ok ? props.section.message : props.failure ?? undefined} onRetry={props.loading ? undefined : props.onRetry} /> : daily.status === "generated" ? <>
      {daily.hidden ? <div className="cc-diary-hidden" role="status">这一篇已隐藏，内容仍然保留。<button type="button" className="cc-link" disabled={props.busy} onClick={props.onUnhideDiary}>取消隐藏</button></div> : null}
      <article className="cc-diary-sheet">
        <header><span className="cc-kicker">每日手记</span><h3>{diaryDayLabel(anchor)}</h3><small>{daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供"}</small></header>
        {sourceTarget?.revision && sourceTarget.revision !== daily.revision ? <p className="cc-diary-source-notice" role="status">收藏来自第 {sourceTarget.revision} 版，这里是当前第 {daily.revision} 版。原摘录仍保留在发现簿。</p> : null}
        <div className="cc-diary-prose" ref={sourceRef}>{daily.blocks.map((block, index) => block.type === "text"
          ? paragraphs.filter(paragraph => paragraph.blockIndex === index).map(paragraph => {
            const discovery = props.discoveryFor?.(paragraph.request);
            return <div className="cc-diary-paragraph" key={paragraph.sourceId} data-source-id={paragraph.sourceId} tabIndex={-1}><p>{paragraph.text}</p>{discovery ? <><DiscoveryKeepAction {...discovery} /><DiscoveryKeepFeedback {...discovery} /></> : null}</div>;
          })
          : block.type === "quote" ? <CompanionQuoteBlock block={block} key={`quote-${index}`} />
          : block.type === "image" ? <CompanionRecordImage block={block} key={`image-${index}`} /> : null)}</div>
        {daily.selectionReason ? <aside className="cc-diary-reason">她选了这段：{daily.selectionReason}</aside> : null}
        <footer className="cc-actions">
          {daily.date ? <button type="button" className="button primary" onClick={() => props.onDiscussDiary({ date: daily.date!, version: daily.revision })} aria-label={`聊聊 ${daily.date} 这篇日记`}>聊聊这篇</button> : null}
          {daily.memory ? <button type="button" className="cc-link" onClick={() => props.onMemory(daily.memory!.memoryItemId)}>查看关联记忆</button> : null}
        </footer>
      </article>
      <details className="cc-diary-management"><summary>管理这一篇</summary><div className="cc-actions">
        <button type="button" disabled={props.busy} onClick={daily.hidden ? props.onUnhideDiary : props.onHideDiary}>{daily.hidden ? "取消隐藏" : "藏起来"}</button>
        {!props.confirmDeleteDiary ? <button type="button" className="danger-quiet" disabled={props.busy} onClick={() => props.onConfirmDeleteDiary(true)}>删掉这一篇</button> : null}
      </div>{props.confirmDeleteDiary ? <div className="cc-confirm" role="group" aria-label="删除日记确认"><p>这一篇及由它产生的摘录、记忆会被永久删除。那天的对话仍然保留。</p><div className="cc-actions"><button type="button" className="danger" disabled={props.busy} onClick={props.onDeleteDiary}>确认删掉这一篇</button><button type="button" disabled={props.busy} onClick={() => props.onConfirmDeleteDiary(false)}>不删了</button></div></div> : null}</details>
    </> : <SectionState message={daily.status === "failed" ? DIARY_DAY_FAILED : DIARY_DAY_EMPTY} detail={daily.status === "failed" ? DIARY_FAILURE_DETAIL[daily.failureReason ?? "unknown"] : "有值得写下的片段时，她会留在这里。可以用日期查看其他日记。"} />}
  </div>;
}
