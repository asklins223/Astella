// 样式表改由 `styles.ts` 统一按顺序注入（2026-09-29）——见该文件顶部的分层说明。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Copy, CornerDownRight, Quote, Sparkles, UserRound } from "lucide-react";
import type { CompanionContentBlockV1, CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { companionMessageText, desktopRouteFromAgentRoute } from "../../app/companion-chat-session";
import { gatewayErrorMessage } from "../../app/desktop-client";
import type { CompanionRunTrace } from "../../app/companion-agent-nodes";
import { CompanionProposalChoice } from "./CompanionProposalChoice";
import { CompanionRunTraceView } from "./CompanionRunTraceView";
import { ZoomableReadingImage } from "../surfaces/source/image-viewer.tsx";
import { useSourceImage } from "../surfaces/source/source-image.ts";
import { renderCompanionMarkdown } from "./companion-markdown";
import { openExternalLink } from "../../app/external-link";
import { copyText } from "../../app/clipboard";
import { companionMessageCopyText } from "./companion-message-copy";
import { journalProposalNeedsAttention } from "./companion-journal-model";
import { CompanionMessageAudioButton } from "./CompanionMessageAudioButton";

/**
 * 「聊天记录」子级页面（2026-09-19，微信式）。
 *
 * 从历史抽屉的入口进入，是一个**独立组件**而不是抽屉里的几行工具：搜索框、
 * 月历筛选、时间线都是这里自绘的组件，不用系统原生控件。页面职责只有浏览
 * （搜索 / 按日期 / 全部时间线），发消息仍在抽屉里。
 */

// ─── 与抽屉共享的小工具 ───────────────────────────────────────────────────

// 历史按行渲染，每行每次都新建 formatter 是白烧（0269 轮 M23）；formatter 无状态可复用。
const MESSAGE_CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return MESSAGE_CLOCK_FORMAT.format(date);
}

export function messageDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function messageDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const key = messageDayKey(value);
  const now = new Date();
  if (key === messageDayKey(now.toISOString())) return "今天";
  if (key === messageDayKey(new Date(now.getTime() - 86_400_000).toISOString())) return "昨天";
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function shouldShowRunTrace(trace: CompanionRunTrace): boolean {
  return trace.summary.stepCount > 1
    || trace.summary.toolCallCount > 0
    || trace.summary.status === "failed"
    || trace.summary.status === "waiting_for_confirmation"
    || trace.nodes.some(node => node.state === "outcome_unknown" || node.state === "unavailable" || node.state === "not_executed" || node.state === "failed");
}

export function stopSummary(trace: CompanionRunTrace | null): string {
  if (!trace) return "";
  const parts: string[] = [];
  // 「走了 N 步」是 run 的步数，不是模型的思考档——本轮开不开思考由服务端
  // 的 `assistant.status` 说，这里再叫"思考 N 步"就会两头对不上。
  if (trace.summary.stepCount > 0) parts.push(`走了 ${trace.summary.stepCount} 步`);
  if (trace.summary.toolCallCount > 0) parts.push(`调用 ${trace.summary.toolCallCount} 次工具`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function highlightText(text: string, keyword: string): ReactNode {
  if (!keyword) return text;
  const lower = text.toLowerCase();
  const needle = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(needle);
  let key = 0;
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(<mark key={key}>{text.slice(index, index + needle.length)}</mark>);
    key += 1;
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/**
 * 她带我去哪儿（方案 29 §4.8，抱怨 #5「连跳到某个笔记都做不到」的收尾）。
 *
 * 落点以前只活在 `agent.tool` 事件和一行游离在消息之外的 chip 里：事件有 TTL、
 * chip 不进正文顺序，于是回看时"她带我去看的那篇笔记"根本不存在。
 * V2→桌面路由仍走 `desktopRouteFromAgentRoute` 那一份诚实映射；映射不到时只留痕、
 * 不给按钮——点了没反应的按钮比没有按钮更糟。
 */
function NavBlockLine({
  block,
  chat,
  onNavigated,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "nav" }>;
  readonly chat: CompanionChatSession;
  readonly onNavigated?: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = desktopRouteFromAgentRoute(block.route);
  if (!target) {
    return <p className="companion-record__nav companion-record__nav--plain"><span>{block.label}</span></p>;
  }
  return (
    <div className="companion-record__nav">
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        setFailure(null);
        void chat.goToRoute(target)
          // 人已经送到了，那张递过来的纸签就该跟着退场；跳不成才留在原地报错。
          .then(() => onNavigated?.())
          .catch((error) => setFailure(gatewayErrorMessage(error)))
          .finally(() => setBusy(false));
      }}>
        <CornerDownRight size={12} />
        {block.label}
      </button>
      {failure ? <span className="companion-record__nav-error" role="status">{failure}</span> : null}
    </div>
  );
}

/**
 * 她摆到对话里的那张图（§4.8 的 image 块，`companion_show_image` 服务端拼的 url）。
 *
 * 字节必须走 main 的站内图片通道：渲染层的 origin 是 `astella-app://`，
 * `/api/uploads/…` 会落到应用包里（404），而外链又被 CSP 的 `img-src` 拦掉。
 * 载入中与取不回来都不给 `<img>`——破图图标比一句人话更像"她坏了"。
 * 取不回来时留一个重试：这类失败通常是瞬时的（API 正在重启），
 * 而这块内容一旦落成消息就会一直在，不该一次失败就永久空白。
 */
export function CompanionRecordImage({
  block,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "image" }>;
}) {
  const { state, retry } = useSourceImage(block.url);
  if (state.status === "ready" || state.status === "external") {
    return (
      <figure className="companion-record__image">
        <ZoomableReadingImage
          src={state.src}
          alt={block.alt ?? block.label}
          retryable={state.status === "ready"}
          onRetry={retry}
          ownedByCompanion
        />
        <figcaption>{block.label}</figcaption>
      </figure>
    );
  }
  if (state.status === "loading") {
    return <p className="companion-record__image-note">正在载入图片…</p>;
  }
  return (
    <p className="companion-record__image-note">
      图片取不回来（{block.label}）。
      <button type="button" onClick={retry}>重试</button>
    </p>
  );
}

/**
 * 引用块（她读到的原文）。
 *
 * 折叠是**量出来**的，不是按字数猜的：抽屉实测 406px 宽，同一条规则下 165px 的短引用
 * 该整段摊开、1256px 的长原文（实机真的出现过，等于三个视口）才出「展开原文」。
 * 上限必须由 CSS **一直挂着**（`.companion-record__quote` 的 `max-height`）：
 * 元素自己不受限时 `scrollHeight === clientHeight`，溢出永远量不出来——
 * 实机第一版就是这么错的（四条引用全部 1256/1256，一个按钮都没有）。
 * 展开之后也不再复检：那时量到的就是全文高度，会把「收起」自己量没掉。
 */
export function CompanionQuoteBlock({
  block,
}: {
  readonly block: Extract<CompanionContentBlockV1, { type: "quote" }>;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return;
    // 附页关闭时没有几何；展开或行宽改变后，再判断原文是否需要继续展开。
    const measure = () => setOverflowing(text.scrollHeight - text.clientHeight > 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [block.text, expanded]);
  return (
    <figure className="companion-record__quote" data-expanded={expanded ? "true" : undefined}>
      <figcaption>{block.label}</figcaption>
      <p ref={textRef}>{block.text}</p>
      {overflowing ? (
        <button type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起原文" : "展开原文"}
        </button>
      ) : null}
    </figure>
  );
}

/** 消息里的可见结果也用于伴星身旁的即时结果卡。 */
export function CompanionMessageRichBlocks({
  blocks,
  chat,
  onNavNavigated,
}: {
  readonly blocks: readonly CompanionContentBlockV1[];
  readonly chat?: CompanionChatSession;
  readonly onNavNavigated?: () => void;
}) {
  return <>
    {blocks.filter((block) => block.type === "nav" || block.type === "quote"
      || block.type === "diagram" || block.type === "card" || block.type === "image" || block.type === "citation" || block.type === "code")
      .map((block, index) => (
        block.type === "nav"
          ? chat ? <NavBlockLine key={`nav-${index}`} block={block} chat={chat} onNavigated={onNavNavigated} /> : <p className="companion-record__nav companion-record__nav--plain" key={`nav-${index}`}><span>{block.label}</span></p>
          : block.type === "quote"
            ? <CompanionQuoteBlock key={`quote-${index}`} block={block} />
            : block.type === "diagram"
              ? (
                  <figure className="companion-record__diagram" key={`diagram-${index}`}>
                    <figcaption>{block.title}</figcaption>
                    <ol>
                      {block.steps.map((step, n) => (
                        <li key={n}>
                          <span className="companion-record__step-no">{n + 1}</span>
                          <span>{step.label}</span>
                          {step.detail ? <small>{step.detail}</small> : null}
                        </li>
                      ))}
                    </ol>
                  </figure>
                )
              : block.type === "card"
                ? (
                    <figure className="companion-record__card" key={`card-${index}`}>
                      <figcaption>{block.knowledgeForm ? `卡片 · ${block.knowledgeForm}` : "卡片"}</figcaption>
                      <p>{block.front}</p>
                      {block.summary ? <small>{block.summary}</small> : null}
                    </figure>
                  )
                : block.type === "image"
                  ? <CompanionRecordImage key={`image-${index}`} block={block} />
                  : block.type === "citation"
                    ? <p className="companion-record__citation" key={`citation-${index}`}>
                        {block.target.kind === "external_https"
                          ? <button type="button" className="text-action" onClick={() => { if (block.target.kind === "external_https") void openExternalLink(block.target.href); }}>{block.label}</button>
                          : <span>{block.label}</span>}
                      </p>
                    : block.type === "code"
                      ? <pre className="companion-record__code" key={`code-${index}`}><code>{block.code}</code></pre>
                      : null
      ))}
  </>;
}

/** 单条消息（时间线 / 某日视图共用）。 */
export function CompanionChatRecordArticle({
  message,
  chat,
}: {
  readonly message: CompanionMessageV1;
  readonly chat: CompanionChatSession;
}) {
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const selection = message.role === "user" ? message.selection : undefined;
  const richBlocks = message.blocks.filter((block) => block.type === "nav" || block.type === "quote"
      || block.type === "diagram" || block.type === "card" || block.type === "image" || block.type === "citation" || block.type === "code");
  const trace = message.role === "assistant"
    ? chat.runTraces.find((item) => item.summary.assistantMessageId === message.id) ?? null
    : null;
  const references = richBlocks.filter(block => block.type === "quote" || block.type === "citation");
  const results = richBlocks.filter(block => block.type !== "quote" && block.type !== "citation");
  const proposalIds = message.role === "assistant" ? [...new Set([
    ...message.blocks.flatMap(block => block.type === "action_ref" ? [block.proposalId] : []),
    ...trace?.nodes.flatMap(node => node.proposalId ? [node.proposalId] : []) ?? [],
  ])] : [];
  const pending = proposalIds.filter(id => journalProposalNeedsAttention(chat.proposalStates[id]));
  const settled = proposalIds.filter(id => !journalProposalNeedsAttention(chat.proposalStates[id]));
  const choices = (ids: readonly string[]) => ids.map(id => <CompanionProposalChoice key={id} proposalId={id}
    state={chat.proposalStates[id]} context="history"
    onDecide={decision => { void chat.decideProposal(id, decision); }} onRetry={() => chat.retryProposal(id)} />);
  return (
    <article className={richBlocks.length > 0 ? "companion-record__turn companion-record__rich-turn" : "companion-record__turn"} data-message-id={message.id} data-role={message.role} data-kind={message.kind} data-cancelled={message.kind === "cancelled" || undefined}>
      <header><span className="companion-record__author"><i className="companion-record__avatar" aria-hidden="true">{message.role === "user" ? <UserRound size={15} /> : <Sparkles size={15} />}</i><strong>{message.role === "user" ? "你" : chat.companionName}{message.kind === "voice_transcript" ? " · 语音" : ""}</strong></span><span className="companion-record__meta">{message.role === "assistant" ? <CompanionMessageAudioButton runId={message.runId} /> : null}<time>{messageTime(message.createdAt)}</time></span></header>
      {selection ? <details className="companion-record__selection"><summary><Quote size={14} aria-hidden="true" /><span>引用的原文</span><q>{selection.text.slice(0, 96)}</q></summary><CompanionQuoteBlock block={{ type: "quote", label: "当时选中的原文", text: selection.text }} /></details> : null}
      {/* 正文从 §4.8 起保留 markdown，由这里排版（抽屉与记录页共用本组件）。 */}
      <div className="companion-record__body">{renderCompanionMarkdown(companionMessageText({ ...message, blocks: message.blocks.filter(block => block.type === "text") }))}</div>
      {results.length ? <div className="companion-record__results"><CompanionMessageRichBlocks blocks={results} chat={chat} /></div> : null}
      {message.kind === "cancelled" ? <p className="companion-record__stopped">你在这里停下了{stopSummary(trace)}</p> : null}
      {message.kind === "error" ? <p className="companion-record__stopped">这一轮没能说完{stopSummary(trace)}</p> : null}
      {pending.length ? <div className="companion-record__decisions">{choices(pending)}</div> : null}
      {references.length || settled.length || (trace && shouldShowRunTrace(trace)) ? <div className="companion-record__attachments">
        {references.length ? <details className="companion-record__references"><summary><Quote size={14} aria-hidden="true" />引用与出处 <small>{references.length}</small></summary><CompanionMessageRichBlocks blocks={references} chat={chat} /></details> : null}
        {settled.length ? <details className="companion-record__decision-history"><summary>确认记录 <small>{settled.length}</small></summary>{choices(settled)}</details> : null}
        {trace && shouldShowRunTrace(trace) ? (
        <CompanionRunTraceView
          trace={trace}
          defaultOpen={false}
          quiet
        />
      ) : null}</div> : null}
      <div className="companion-record__actions"><button type="button" className="text-action" onClick={() => {
        void copyText(companionMessageCopyText(message)).then((copied) => setCopyNote(copied ? "已复制" : "复制失败，请重试"));
      }}><Copy size={16} />{copyNote ?? "复制文字"}</button></div>
    </article>
  );
}

// ─── 自绘月历（不用原生 date 控件） ───────────────────────────────────────

/**
 * 自绘月历。两个宿主：聊天记录（`pool` = 消息，只有聊过的日子可选，格子上标条数）
 * 与伴星中心的日记筛选（`marks` = 她写过哪几天，来自 /companion/daily/month）。
 * 日记侧不靠消息数收可选范围——没写过的那一天点开就是「这一天还没有日记」，
 * 那是一个诚实的答案，不是错误。
 */
export function MonthCalendar({
  pool = null,
  marks = null,
  maxDay = null,
  panelId = "companion-record-calendar",
  selected,
  onPick,
  onMonthChange,
  footer = null,
}: {
  readonly pool?: readonly CompanionMessageV1[] | null;
  readonly marks?: ReadonlyMap<string, "generated" | "failed"> | null;
  readonly maxDay?: string | null;
  readonly panelId?: string;
  readonly selected: string | null;
  onPick: (dayKey: string) => void;
  /** 宿主靠它去取当前这一月的标记；不传就是不需要。 */
  onMonthChange?: (monthKey: string) => void;
  /** 面板底部的一行宿主说明（比如「这个月的标记没读出来」）。 */
  readonly footer?: ReactNode;
}) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const message of pool ?? []) {
      const key = messageDayKey(message.createdAt);
      if (key) map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [pool]);
  const initial = selected ? new Date(`${selected}T12:00:00`) : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());

  const shift = (delta: number) => {
    const next = new Date(year, month + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  // 宿主多半传的是行内箭头函数；挂在 ref 上才不会把「回调身份变了」当成「换月了」，
  // 否则每次父组件重渲染都会多打一次月度请求。
  const notifyMonth = useRef(onMonthChange);
  notifyMonth.current = onMonthChange;
  useEffect(() => {
    notifyMonth.current?.(monthKey);
  }, [monthKey]);
  const first = new Date(year, month, 1);
  const firstWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = messageDayKey(new Date().toISOString());
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div id={panelId} className="companion-record__calendar" role="group" aria-label="选择日期">
      <div className="companion-record__calendar-head">
        <button type="button" onClick={() => shift(-1)} aria-label="上个月"><ChevronLeft size={14} /></button>
        <strong>{year}年{month + 1}月</strong>
        <button type="button" onClick={() => shift(1)} aria-label="下个月"><ChevronRight size={14} /></button>
      </div>
      <div className="companion-record__calendar-grid">
        {["日", "一", "二", "三", "四", "五", "六"].map((label) => <span key={label} className="companion-record__calendar-wd">{label}</span>)}
        {cells.map((day, index) => {
          if (day == null) return <span key={`empty-${index}`} />;
          const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const count = counts.get(key) ?? 0;
          // 没有计数数据时不能反过来把每一天都判成空——日记侧只按「这一天还没发生」收。
          const disabled = (maxDay != null && key > maxDay) || (pool ? count === 0 : false);
          const mark = marks?.get(key) ?? null;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              data-selected={selected === key || undefined}
              data-today={key === todayKey || undefined}
              aria-label={mark ? `${day} 日${mark === "generated" ? "，她写过" : "，她没写成"}` : undefined}
              onClick={() => onPick(key)}
            >
              {day}
              {count > 0 ? <i>{count > 9 ? "9+" : count}</i> : null}
              {mark ? <span className="companion-record__calendar-mark" data-status={mark} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
