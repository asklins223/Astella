import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Database, Download, MessageCircle, Pencil, Pin, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import type { CompanionActivityDeliveryV1, CompanionActivityTimelineV1, CompanionDailyFailureReasonV1, CompanionDailySummaryV1, CompanionExportKindV1, CompanionHistoryItemV1, CompanionMemoryItemV1, CompanionMemoryKindV1, CompanionMemoryRevisionV1, CompanionMemoryScopeV1, CompanionPersonaPendingRevisionV1, CompanionPersonaPendingV1, CompanionPersonaProfileV1, CompanionPersonaProfileVersionV1, CompanionPersonaPresetV1, CompanionPersonaV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import type { CompanionJourneyAction, CompanionJourneyBootstrap } from "@ailearn/shared/companion-journey-contracts";
import type { CompanionLearningContextV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { CompanionQuoteBlock, CompanionRecordImage, MonthCalendar } from "../../companion/CompanionChatRecord";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select.tsx";
import { DiscoveryKeepAction, type DiscoveryKeepProps } from "./companion-discovery-offer.tsx";
import { diaryDayLabel, shiftIsoDate, todayIsoDate } from "./companion-diary-day.ts";
import { formatDate, formatRelative } from "../notebook/surface-data.tsx";
import { RESUME_RUN_ACTION_LABEL } from "../run/objective-state-copy.ts";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";

export type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * §4.5.8：「关于你的」和「她的看法」在记忆管理中明确区分。
 *
 * 前五种是关于用户的事实，后一种是**她对一件事的解释**。它们放进同一个
 * 平铺列表，用户分不清哪条能当事实用——所以列表按 `judgment` 分成两段，
 * 而不是只在标签上多一个词。
 */
export const MEMORY_KIND_LABEL: Record<CompanionMemoryKindV1, string> = {
  preference: "偏好", goal: "目标", learning_context: "学习线索", interaction_note: "互动观察", episodic: "共同经历",
  judgment: "她的看法",
};
/** §4.5.2 判断记录是独立用途层，不是「关于用户的事实」。 */
export const isCompanionJudgment = (item: { readonly kind: CompanionMemoryKindV1 }): boolean => item.kind === "judgment";
export const MEMORY_SCOPE_LABEL: Record<CompanionMemoryScopeV1, string> = {
  global: "所有书房",
  workspace: "这个书房",
  task: "只在这项任务里",
};
export const MEMORY_STATE_LABEL: Record<string, string> = {
  candidate: "待确认", active: "已写入", pinned: "已固定", archived: "已归档", scheduled: "尚未生效", expired: "已过期", linked: "真实关联", orphaned: "关联失效",
};

/**
 * 「这一天她没能写下来」的三种成因（0250 的 failure_reason）。
 *
 * 旧文案只有一句"生成失败"，用户分不清是自己没开设置还是我们出了问题；
 * 那句「可稍后重试读取」也是假话——读取不会触发重新生成，只有第二天会。
 * `unknown` 是这次改动之前写下的失败行（当时没有成因这一列）。
 */
const DIARY_FAILURE_DETAIL: Record<CompanionDailyFailureReasonV1 | "unknown", string> = {
  consent_required: "日记要由她来写，而「允许发送到外部模型服务」没有开启。开启后从第二天开始写。",
  model_unavailable: "她试了几次没写出来，明天会再试。",
  diary_output_invalid: "她写回来的东西还是在报数，不像日记，没有收下来。",
  unknown: "不会用推测内容填充这一天。",
};
// 「导出记忆」和「导出操作记录」曾经共用同一句副标题，三个按钮看上去
// 像同一件事的三个副本；各自说清自己带走哪些表。
const EXPORT_COPY: Record<CompanionExportKindV1, { label: string; detail: string }> = {
  all: { label: "导出全部伴星数据", detail: "记忆、对话、人格与操作记录的完整副本" },
  memory: { label: "导出记忆", detail: "只含记忆条目与星图关系" },
  audit: { label: "导出操作记录", detail: "只含安全操作与邀请记录" },
};
const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常交流里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许伴星在合适时机提醒复习"],
  ["allowVoiceTags", "语气标签", "允许回复携带表演语气"],
] as const;

/**
 * 用户能**手动新建**的类型（§4.5.6 保留了手动增删改）。
 *
 * 判断记录不在其中：它必须有来源事件、作者是她、认识状态显式，
 * 这三件事手工填不出来——`POST /companion/memory` 也不接受它。
 * 筛选与星图用的 `MEMORY_KIND_OPTIONS` 仍然包含它，因为那里是在看已有条目。
 */
export const MEMORY_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<CompanionMemoryKindV1>> = (
  Object.entries(MEMORY_KIND_LABEL) as Array<[CompanionMemoryKindV1, string]>
).map(([value, label]) => ({ value, label }));
const MEMORY_CREATABLE_KIND_OPTIONS = MEMORY_KIND_OPTIONS.filter((option) => option.value !== "judgment");

const MEMORY_LIST_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];
/**
 * §4.5.8：「临时记录可按状态筛选，不隐藏成一个只有系统知道的永久数据库」。
 *
 * 归档与「已过期」本来就是屏上会显示的状态（`MEMORY_STATE_LABEL` 里有），
 * 却没有对应的筛选口——用户看得见标签却找不到筛选方式，就等于这两类记录
 * 只在"碰巧没有被筛选挡住"的时候才存在。
 */
type MemoryStateFilter = "all" | "pinned" | "candidate" | "archived" | "expired";
function matchesMemoryStateFilter(item: CompanionMemoryItemV1, filter: MemoryStateFilter): boolean {
  if (filter === "all") return true;
  return memoryState(item) === filter;
}

const MEMORY_PIN_OPTIONS: ReadonlyArray<CompanionSelectOption<MemoryStateFilter>> = [
  { value: "all", label: "全部状态" },
  { value: "candidate", label: "待确认" },
  { value: "pinned", label: "已固定" },
  { value: "archived", label: "已归档" },
  { value: "expired", label: "已过期" },
];

const JOURNEY_STEP_LABEL: Record<string, string> = {
  boundary_intro: "了解使用边界",
  preference_capture: "记录学习偏好",
  goal_capture: "确认学习卡",
  choose_start: "选择开始方式",
  first_source: "添加第一份材料",
  source_processing: "整理材料",
  first_note: "写下第一篇笔记",
  first_card: "生成第一张学习卡",
  first_evidence: "补充第一条证据",
  first_run: "完成第一次理解验证",
  first_schedule: "安排第一次复习",
  sample_orientation: "熟悉示例空间",
  closing: "完成旅程",
};
const JOURNEY_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  skipped: "已结束",
  completed: "已完成",
  recoverable_error: "需要重试",
};
const JOURNEY_BRANCH_LABEL: Record<string, string> = {
  own_material: "使用自己的材料",
  blank_note: "从空白笔记开始",
  sandbox_sample: "使用示例材料",
};

/**
 * 一条历史消息的正文。**导出去**是因为「留在发现簿」要收藏的必须是屏上正在显示的
 * 这一段话本身（40 §7），而在壳层重写一份抽取规则，迟早与屏上显示的那份分叉——
 * 那时候收藏下来的东西与用户看到的不是同一段话。
 */
export function messageText(item: CompanionHistoryItemV1): string {
  return item.blocks.map((block) => block.type === "text" ? block.text : block.type === "code" ? block.code : block.type === "citation" ? block.label : "").filter(Boolean).join("\n");
}
function memoryState(item: CompanionMemoryItemV1) {
  if (item.archived) return "archived";
  if (item.validUntil && Date.parse(item.validUntil) <= Date.now()) return "expired";
  if (item.candidate) return "candidate";
  if (item.validFrom && Date.parse(item.validFrom) > Date.now()) return "scheduled";
  return item.pinned ? "pinned" : "active";
}

function formatMemoryTime(value: string | null): string {
  if (!value) return "来源时间";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

/**
 * 气泡里的段落节奏（B4，评审 §6 从 B3 接的那一条）。
 *
 * 服务端把整条回复作为一个字符串送回来，里面带着模型自己写的 `\n\n\n`；气泡是
 * `white-space: pre-wrap`，于是每个换行都排成一行，一段话中间出现三行高的空档
 * （实测那条 h=225、单个 `<p>`、6 个换行）。这里只按「两个及以上连续换行」切段，
 * 段与段之间的节奏交回 CSS；**段内的单个换行是作者自己的换行，原样留着**，
 * 不吞内容。
 */
function paragraphLines(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

export function SectionState({ message, detail, onRetry }: { readonly message: string; readonly detail?: string; readonly onRetry?: () => void }) {
  return <div className="companion-section-state" role="status"><strong>{message}</strong>{detail ? <span>{detail}</span> : null}{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={14} />重新读取</button> : null}</div>;
}

type MemoryPanelProps = {
  section: Section<{ version: 2; items: CompanionMemoryItemV1[] }>; items: CompanionMemoryItemV1[]; focus: CompanionMemoryItemV1 | null;
  revisions: CompanionMemoryRevisionV1[] | null; revisionsError: string | null; onRetryRevisions: () => void;
  query: string; kind: "all" | CompanionMemoryKindV1; pinFilter: MemoryStateFilter; busy: string | null; error: string | null; notice: string | null;
  confirmDelete: boolean; confirmErase: boolean;
  createOpen: boolean; createContent: string; createKind: CompanionMemoryKindV1; correctionOpen: boolean; correctionContent: string;
  onQuery: (value: string) => void; onKind: (value: "all" | CompanionMemoryKindV1) => void; onPinFilter: (value: MemoryStateFilter) => void;
  onFocus: (id: string) => void; onAction: (action: "confirm" | "pin" | "unpin" | "archive" | "restore" | "dismiss" | "remove" | "erase") => void;
  onConfirmDelete: (value: boolean) => void; onConfirmErase: (value: boolean) => void; onCreateOpen: (value: boolean) => void; onCreateContent: (value: string) => void; onCreateKind: (value: CompanionMemoryKindV1) => void; onCreate: () => void; onSummarize: () => void; onCorrectionOpen: (value: boolean) => void; onCorrectionContent: (value: string) => void; onCorrect: () => void; onRetry: () => void;
};
const MEMORY_LIST_UNAVAILABLE = "记忆列表当前不可用";
const MEMORY_LIST_EMPTY = {
  message: "没有符合条件的记忆",
  detail: "清空筛选或手动添加一条记忆。",
} as const;
const MEMORY_AUTHOR_LABEL = { user: "用户修订", extractor: "从对话里提取", companion: "她自己的判断", maintenance: "后台整理" } as const;
const MEMORY_EPISTEMIC_LABEL = { supported: "有据", tentative: "待核对", disputed: "有争议", superseded: "已被替代" } as const;
const MEMORY_SOURCE_LABEL = { user_stated: "用户自述", model_inferred: "模型推断", confirmed: "用户确认", summary: "对话整理" } as const;
/**
 * 来源行：判断记录的话是**她自己说的**，不能折进「用户原话/伴星发言」两句里。
 * §4.5.4 说来源性质区分用户自述、可观察事件与模型推断——这三者都不是用户原话，
 * 所以判断要单独落一句「这是她的理解，不是你说的话」。
 */
const MEMORY_SPEAKER_LABEL: Record<"user" | "assistant" | "companion", string> = {
  user: "用户原话",
  assistant: "伴星发言",
  companion: "她自己的理解（不是你说的话）",
};

export function MemoryPanel(props: MemoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focus) return;
    const selected = panelRef.current?.querySelector<HTMLElement>('.companion-record-list > button[aria-pressed="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [props.focus?.memoryItemId]);
  useEffect(() => {
    const selector = props.correctionOpen ? ".companion-memory-detail .companion-inline-form" : props.createOpen ? ":scope > .companion-inline-form" : null;
    if (!selector) return;
    const form = panelRef.current?.querySelector(selector);
    if (!form) return;
    // 便签在滚动列表里展开：整块表单（含保存按钮）要滚进可视区，否则主按钮被面板底边裁掉。
    form.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [props.correctionOpen, props.createOpen]);
  /**
   * 这份清单**只能在这里算一次**：它既决定屏上露出哪几行，也决定登记给伴星读哪几行。
   * 壳层手里只有未筛的 `props.items`，让壳层去发布就得把下面这两行再抄一遍——
   * 那就是"同一个数两个来源"（39d W2-3 那两个统计分岔的成因）。
   */
  const visible = useMemo(() => props.items
    .filter((item) => (props.kind === "all" || item.kind === props.kind) && matchesMemoryStateFilter(item, props.pinFilter) && (!props.query.trim() || item.content.toLowerCase().includes(props.query.trim().toLowerCase())))
    .sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.updatedAt.localeCompare(a.updatedAt)),
  [props.items, props.kind, props.pinFilter, props.query]);
  const memoryReadableView = useMemo<PageReadableV1 | null>(() => {
    // 读不到时这一格整块被换成了那句说明：清单、筛选下拉都在屏幕上消失了，
    // 所以那份未筛的 `props.items` **一行都不许登记**（用例抓到过一次：
    // 只把 statusLine 换成"不可用"、条目照登，等于让她报出屏幕上根本没有的清单）。
    if (!props.section.ok) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: MEMORY_LIST_UNAVAILABLE,
        notice: `${MEMORY_LIST_UNAVAILABLE}：${props.section.message.slice(0, 60)}`,
      };
    }
    const rows = visible
      // 正文为空的行屏幕上也是一个空 `<strong>`，没有话可登记——跳过它，
      // 而不是编一句"（空）"给她念。
      .filter((item) => item.content.trim().length > 0)
      .slice(0, 12)
      .map((item, index) => ({
        ordinal: index + 1,
        label: item.content.slice(0, 120),
        state: `${MEMORY_KIND_LABEL[item.kind]}· ${MEMORY_STATE_LABEL[memoryState(item)]}`,
      }));
    const optionLabel = (options: ReadonlyArray<CompanionSelectOption<string>>, value: string) =>
      options.find((option) => option.value === value)?.label ?? value;
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: props.notice ?? props.error ?? (visible.length === 0 ? MEMORY_LIST_EMPTY.message : undefined),
      filters: [
        { label: "类型", value: optionLabel(MEMORY_LIST_KIND_OPTIONS, props.kind).slice(0, 40) },
        { label: "状态", value: optionLabel(MEMORY_PIN_OPTIONS, props.pinFilter).slice(0, 40) },
        ...(props.query.trim() ? [{ label: "关键词", value: props.query.trim().slice(0, 40) }] : []),
      ],
      ...(rows.length > 0 ? { items: rows } : {}),
      ...(visible.length === 0 ? { notice: `${MEMORY_LIST_EMPTY.message}：${MEMORY_LIST_EMPTY.detail}` } : {}),
    };
  }, [props.error, props.kind, props.notice, props.pinFilter, props.query, props.section, visible]);
  usePageReadableView(memoryReadableView);
  if (!props.section.ok) return <SectionState message={MEMORY_LIST_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} />;
  return <div ref={panelRef} className="companion-panel-stack"><div className="companion-panel-heading"><div className="companion-heading-actions"><button type="button" disabled={props.busy !== null} data-busy={props.busy === "summarize" || undefined} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button><button type="button" onClick={() => props.onCreateOpen(!props.createOpen)}>{props.createOpen ? "取消" : "手动添加"}</button></div></div>
    {props.createOpen ? <div className="companion-inline-form"><CompanionSelect paper ariaLabel="新记忆类型" value={props.createKind} options={MEMORY_CREATABLE_KIND_OPTIONS} onChange={props.onCreateKind} /><textarea value={props.createContent} maxLength={200} onChange={(event) => props.onCreateContent(event.target.value)} placeholder="写下希望伴星长期记住的事实" aria-label="新记忆内容" /><button type="button" className="button primary" disabled={!props.createContent.trim() || props.busy !== null} data-busy={props.busy === "create" || undefined} onClick={props.onCreate}>{props.busy === "create" ? "正在保存…" : "保存记忆"}</button></div> : null}
    <label className="companion-search"><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="筛选记忆列表" aria-label="筛选记忆列表" />{props.query ? <button type="button" className="companion-search__clear" onClick={() => props.onQuery("")} aria-label="清空记忆列表搜索"><X size={13} /></button> : null}</label>
    <div className="companion-filter-group" role="group" aria-label="记忆列表筛选"><span>列表</span><CompanionSelect paper ariaLabel="筛选记忆列表类型" value={props.kind} options={MEMORY_LIST_KIND_OPTIONS} onChange={props.onKind} /><CompanionSelect paper ariaLabel="筛选记忆列表状态" value={props.pinFilter} options={MEMORY_PIN_OPTIONS} onChange={props.onPinFilter} /></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
  {(() => {
    const detailCard = props.focus ? (
      <article className="companion-memory-detail">
        <div className="companion-memory-detail__meta">
          <span>{MEMORY_KIND_LABEL[props.focus.kind]}</span>
          <span>{MEMORY_STATE_LABEL[memoryState(props.focus)]}</span>
          <span>第 {props.focus.revision} 版</span>
          <span>{MEMORY_AUTHOR_LABEL[props.focus.authorType]}</span>
          <span>{MEMORY_EPISTEMIC_LABEL[props.focus.epistemicStatus]}</span>
          <span>重要度 {Math.round(props.focus.importance * 100)}%</span>
        </div>
        {props.correctionOpen ? (
          <div className="companion-inline-form">
            <textarea value={props.correctionContent} maxLength={200} onChange={(event) => props.onCorrectionContent(event.target.value)} aria-label="纠正后的记忆内容" />
            <div className="companion-action-row">
              <button type="button" className="button primary" disabled={!props.correctionContent.trim() || props.correctionContent.trim() === props.focus.content || props.busy !== null} data-busy={props.busy === "correct" || undefined} onClick={props.onCorrect}>{props.busy === "correct" ? "正在保存…" : "保存修订"}</button>
              <button type="button" onClick={() => props.onCorrectionOpen(false)}>取消</button>
            </div>
          </div>
        ) : <strong>{props.focus.content}</strong>}
        {props.focus.appliesWhen ? <small>适用条件：{props.focus.appliesWhen}</small> : null}
        <small>来源：{props.focus.sourceSpeaker ? MEMORY_SPEAKER_LABEL[props.focus.sourceSpeaker] : MEMORY_SOURCE_LABEL[props.focus.sourceType]}{props.focus.sourceBasis === "inferred_from_statement" ? "（根据原话整理）" : ""}</small>
        <small>适用范围：{MEMORY_SCOPE_LABEL[props.focus.scope]}</small>
        <small>有效期：{formatMemoryTime(props.focus.validFrom ?? props.focus.createdAt)} 至 {props.focus.validUntil ? formatMemoryTime(props.focus.validUntil) : "无截止时间"}</small>
        <small>更新于 {formatRelative(props.focus.updatedAt)}</small>
        {props.revisionsError ? <SectionState message="旧版本暂不可用" detail={props.revisionsError} onRetry={props.onRetryRevisions} /> : props.revisions === null ? <small>正在读取旧版本…</small> : props.revisions.length > 0 ? (
          <details>
            <summary>查看旧版本（{props.revisions.length}）</summary>
            {props.revisions.map((revision) => (
              <div key={revision.revision}>
                <div className="companion-memory-detail__meta">
                  <span>第 {revision.revision} 版</span>
                  <span>{MEMORY_AUTHOR_LABEL[revision.authorType]}</span>
                  <span>{MEMORY_EPISTEMIC_LABEL[revision.epistemicStatus]}</span>
                  <span>来源：{MEMORY_SOURCE_LABEL[revision.sourceType]}</span>
                </div>
                <p>{revision.content}</p>
                <small>被替代于 {formatRelative(revision.supersededAt)}</small>
              </div>
            ))}
          </details>
        ) : null}
        <div className="companion-action-row">
          {props.focus.candidate ? <button type="button" className="button primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>确认写入</button> : null}
          {!props.focus.candidate && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.pinned ? "unpin" : "pin")}><Pin size={13} />{props.focus.pinned ? "取消固定" : "固定"}</button> : null}
          {!props.correctionOpen && !props.focus.archived ? <button type="button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={13} />纠正</button> : null}
          {!props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction(props.focus!.archived ? "restore" : "archive")}><Archive size={13} />{props.focus.archived ? "恢复" : "归档"}</button> : null}
          {props.focus.candidate ? <button type="button" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button> : null}
          <MemoryDeleteAction active={props.confirmDelete} busy={props.busy !== null} onOpen={() => props.onConfirmDelete(true)} onCancel={() => props.onConfirmDelete(false)} onConfirm={() => props.onAction("remove")} />
          <MemoryEraseAction active={props.confirmErase} busy={props.busy !== null} onOpen={() => props.onConfirmErase(true)} onCancel={() => props.onConfirmErase(false)} onConfirm={() => props.onAction("erase")} />
        </div>
      </article>
    ) : null;
  const aboutYou = visible.filter((item) => !isCompanionJudgment(item));
  const herViews = visible.filter(isCompanionJudgment);
  const renderRow = (item: CompanionMemoryItemV1) => (
    <button key={item.memoryItemId} type="button" aria-pressed={props.focus?.memoryItemId === item.memoryItemId} className={[props.focus?.memoryItemId === item.memoryItemId ? "is-selected" : null, item.archived ? "is-archived" : null].filter(Boolean).join(" ") || undefined} onClick={() => props.onFocus(item.memoryItemId)}><strong>{item.content}</strong><span><i className={`is-${memoryState(item)}`} aria-hidden="true" /><em>{MEMORY_KIND_LABEL[item.kind]}</em>· {MEMORY_STATE_LABEL[memoryState(item)]} · {formatRelative(item.updatedAt)}</span></button>
  );
  return <div className="companion-memory-workspace">
    <div className="companion-record-list" aria-label="记忆列表">{visible.length === 0 ? <div className="companion-empty-with-action"><SectionState message={MEMORY_LIST_EMPTY.message} detail={MEMORY_LIST_EMPTY.detail} /><button type="button" onClick={() => { props.onQuery(""); props.onKind("all"); props.onPinFilter("all"); }}>清除筛选</button></div> : (
      <>
        {aboutYou.length > 0 ? <section aria-label="关于你的"><h4 className="companion-memory-group">关于你的</h4>{aboutYou.map(renderRow)}</section> : null}
        {herViews.length > 0 ? <section aria-label="她的看法"><h4 className="companion-memory-group">她的看法<small>她对一件事的理解，不是你说的话，也不是学习记录</small></h4>{herViews.map(renderRow)}</section> : null}
      </>
    )}</div>
    <aside className="companion-memory-focus" aria-label="所选记忆详情">{detailCard ?? <SectionState message="选择一条记忆" detail="查看它的内容与可用操作。" />}</aside>
  </div>;
  })()}
  </div>;
}

type DialogueKeepProps = DiscoveryKeepProps & { readonly anchorMessageId: string | null };
type DialoguePanelProps = { section: Section<{ version: 1; items: CompanionHistoryItemV1[]; nextCursor: string | null }>; items: CompanionHistoryItemV1[]; cursor: string | null; query: string; searching: boolean; loadingMore: boolean; error: string | null; onQuery: (value: string) => void; onSearch: () => void; onLoadMore: () => void; onContinue: () => void; onRetry: () => void; keep?: DialogueKeepProps | null };
const DIALOGUE_UNAVAILABLE = "连续对话当前不可用";
const DIALOGUE_EMPTY = {
  message: "还没有对话记录",
  detail: "开始交流后，消息会连续出现在这里。",
} as const;
const DIALOGUE_NO_BODY = "这条记录不含可展示正文。";
/** 那一次收藏机会与她读到的那一句，写一份给两处用。 */
const DIALOGUE_KEEP_LINE = "最新一句回答旁可以留下一条到发现簿，只问这一次。";
/** 行首那个说话人字：屏上 `<b>` 里就是这三个词，她念的也必须是同一份。 */
function dialogueRoleLabel(role: CompanionHistoryItemV1["role"]): string {
  return role === "user" ? "你" : role === "assistant" ? "伴星" : "系统";
}
/** `.companion-result-status` 那一格：搜索中 / 找到 N 条 / 什么都没有。 */
function dialogueResultLine(props: DialoguePanelProps): string {
  return props.searching ? "正在搜索对话" : props.query.trim() ? `找到 ${props.items.length} 条对话` : "";
}

/**
 * 「留在发现簿」那一格与伴星读到的说明，共用同一份文案（39d W2-7 那条纪律）。
 *
 * 它出现在屏上就会被问到，所以不能只在界面上多一个按钮：屏上有、她读到没有，
 * 用户问起来就是"她根本没看见"。
 */
function dialogueKeepLine(props: DialoguePanelProps): string | undefined {
  const keep = props.keep;
  if (!keep) return undefined;
  if (keep.failure) return `留在发现簿没有成功：${keep.failure.slice(0, 60)}`;
  if (keep.feedback) return keep.feedback.slice(0, 120);
  return keep.state === "offer" ? DIALOGUE_KEEP_LINE : undefined;
}

export function DialoguePanel(props: DialoguePanelProps) {
  // 屏上那一格与她读到的那一句同源：单独算一次，别在下面再拼一遍。
  const keepLine = dialogueKeepLine(props);
  const dialogueReadableView = useMemo<PageReadableV1 | null>(() => {
    // 这一格只有一行清单和几句状态字，**没有本地二次筛选**：`props.items` 就是
    // 服务端按关键词回给这一屏的那一批，屏上露出的也就是它（与记忆那一格不同）。
    if (!props.section.ok) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: DIALOGUE_UNAVAILABLE,
        notice: `${DIALOGUE_UNAVAILABLE}：${props.section.message.slice(0, 60)}`,
      };
    }
    const resultLine = dialogueResultLine(props);
    const rows = props.items.slice(0, 12).map((item, index) => ({
      ordinal: index + 1,
      label: (paragraphLines(messageText(item) || DIALOGUE_NO_BODY)[0] ?? DIALOGUE_NO_BODY).slice(0, 120),
      state: dialogueRoleLabel(item.role),
    }));
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: resultLine || props.error || (props.items.length === 0 ? DIALOGUE_EMPTY.message : undefined),
      ...(props.query.trim() ? { filters: [{ label: "关键词", value: props.query.trim().slice(0, 40) }] } : {}),
      ...(rows.length > 0 ? { items: rows } : {}),
      ...(props.items.length === 0 ? { notice: `${DIALOGUE_EMPTY.message}：${DIALOGUE_EMPTY.detail}` } : {}),
      ...(keepLine && props.items.length > 0 ? { notice: keepLine } : {}),
    };
  }, [keepLine, props.error, props.items, props.query, props.searching, props.section]);
  usePageReadableView(dialogueReadableView);
  if (!props.section.ok) return <SectionState message={DIALOGUE_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} />;
  return <div className="companion-panel-stack"><div className="companion-panel-heading"><h3>连续对话</h3><p>按全局时间排列；内部数据分段不会显示在这里。</p><button type="button" className="button primary" onClick={props.onContinue}><MessageCircle size={14} />继续交流</button></div><form className="companion-search" onSubmit={(event) => { event.preventDefault(); props.onSearch(); }}><Search size={14} aria-hidden="true" /><input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索全部对话正文" aria-label="搜索全部对话正文" /><button type="submit" disabled={props.searching}>{props.searching ? "搜索中" : "搜索"}</button></form><p className="companion-result-status" aria-live="polite">{dialogueResultLine(props)}</p>{props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}{props.cursor ? <button type="button" className="companion-load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? "正在读取更早记录…" : "加载更早记录"}</button> : null}<div className="companion-thread">{props.items.length === 0 ? <SectionState message={DIALOGUE_EMPTY.message} detail={DIALOGUE_EMPTY.detail} /> : props.items.map((item) => <article key={item.messageId} tabIndex={-1} className={`is-${item.role}`} id={`companion-message-${item.messageId}`}><span><b>{dialogueRoleLabel(item.role)}</b><time>{formatRelative(item.createdAt)}</time></span>{paragraphLines(messageText(item) || DIALOGUE_NO_BODY).map((paragraph, index) => <p key={index}>{paragraph}</p>)}{item.kind === "cancelled" ? <small>这是一条被你停止的未完成回复。</small> : null}{/*
          那一次「留在发现簿」只挂在 `anchorMessageId` 这一条下面（通常是最新一句）。
          放在 article 内部而不是列表底部，是为了让它读起来是**这一句**的动作，
          而不是整页的一个常驻按钮。
        */}{props.keep?.anchorMessageId === item.messageId ? <DiscoveryKeepAction {...props.keep} /> : null}</article>)}</div></div>;
}

type ActivityPanelProps = {
  section: Section<CompanionJourneyBootstrap>;
  learningContextSection: Section<CompanionLearningContextV1>;
  deliverySection: Section<CompanionActivityTimelineV1>;
  deliveries: CompanionActivityDeliveryV1[];
  busy: boolean;
  error: string | null;
  onStart: (kind: "start_journey" | "replay") => void;
  onAction: (action: CompanionJourneyAction) => void;
  onResumeLearning: (runId: string) => void;
  onOpenObjective: (objectiveId: string) => void;
  onPresent: (item: CompanionActivityDeliveryV1) => void;
  onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
  onRetry: () => void;
};

/** 还能被处理的投递：其余（已处理 / 已忽略 / 已失效）都收进历史组。 */
const DELIVERY_PENDING_STATES: ReadonlyArray<CompanionActivityDeliveryV1["state"]> = ["queued", "delivered", "displayed"];
function isPendingDelivery(item: CompanionActivityDeliveryV1): boolean {
  return !item.expired && DELIVERY_PENDING_STATES.includes(item.state);
}

/**
 * 动态那一格的屏上文本，各写一次：`SectionState`／卡片标题与登记给伴星的可读视图
 * 引用同一份（视图字段写错不会红，抄成两处迟早分叉）。
 */
const ACTIVITY_SECTIONS = { learning: "继续学习", journey: "伴星旅程", feed: "最近动态" } as const;
const ACTIVITY_LINES = {
  learningUnavailable: "学习上下文当前不可用",
  learningNothing: { message: "当前没有可继续的学习", detail: "这里只列出系统从真实学习状态里挑出的候选。" },
  journeyUnavailable: "旅程当前不可用",
  journeyInvite: { title: "开始第一段学习旅程", summary: "从你自己的资料开始，伴星会跟随真实进度。" },
  journeySkipped: { title: "旅程邀请已跳过", summary: "需要时可以重新开始，不会补造任何里程碑。" },
  journeyNone: { message: "目前没有进行中的旅程", detail: "新的状态更新会在这里出现。" },
  feedUnavailable: "主动投递当前不可用",
  feedEmpty: { message: "目前没有新的动态", detail: "新的邀请、主动投递和状态更新会出现在这里。" },
  feedNoPending: { message: "没有待处理的动态", detail: "处理完的会收进下面的历史记录。" },
} as const;

/** 旅程那张卡的标题与副行：屏上怎么写，她就读到什么（两处共用，不各拼一遍）。 */
function journeyCardTitle(journey: { currentStep: string | null }): string {
  return journey.currentStep ? `当前步骤：${JOURNEY_STEP_LABEL[journey.currentStep] ?? "继续学习旅程"}` : "旅程状态";
}
function journeyCardSummary(journey: { status: string; branch: string }): string {
  return journey.status === "recoverable_error"
    ? "这一步暂时没有完成，可以直接重试。"
    : `${JOURNEY_STATUS_LABEL[journey.status] ?? "状态已更新"} · ${JOURNEY_BRANCH_LABEL[journey.branch] ?? "当前学习路径"}`;
}
/** 收起来那一段的标题：她自己不点开就看不到里面的行，但"有多少条"是写在这行上的。 */
function resolvedGroupLabel(count: number): string {
  return `历史动态 · ${count} 条`;
}

export function ActivityPanel(props: ActivityPanelProps) {
  const journeyState = props.section.ok ? props.section.value : null;
  const learningContext = props.learningContextSection.ok ? props.learningContextSection.value : null;
  const resumeCandidate = learningContext?.learningRunResumeCandidate ?? null;
  const startCandidate = learningContext?.learningRunStartCandidate ?? null;
  const pending = props.deliveries.filter(isPendingDelivery);
  const resolved = props.deliveries.filter((item) => !isPendingDelivery(item));

  /**
   * 这一格登记给伴星读的是**三段各自那一刻露出的那一行**（39d W2-7）。
   *
   * `state` 一律是"这一行来自哪一段"（同一个字段同一个含义）；投递自己的
   * "待处理"那一层不进这个字段。**只有展开才看得到的历史动态不登记成条目**，
   * 但收着的那一行标题上写着条数，所以把它原样放进 `notice`——她要知道
   * "还有 N 条在这段折叠里"，又不能报出屏幕上看不见的内容。
   */
  const activityReadableView = useMemo<PageReadableV1 | null>(() => {
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (rows.length < 12) rows.push({ label, state });
    };
    if (!props.learningContextSection.ok) push(ACTIVITY_LINES.learningUnavailable, ACTIVITY_SECTIONS.learning);
    else if (resumeCandidate) push(resumeCandidate.title, ACTIVITY_SECTIONS.learning);
    else if (startCandidate) push(startCandidate.title, ACTIVITY_SECTIONS.learning);
    else push(ACTIVITY_LINES.learningNothing.message, ACTIVITY_SECTIONS.learning);

    if (!journeyState) push(ACTIVITY_LINES.journeyUnavailable, ACTIVITY_SECTIONS.journey);
    else if (journeyState.journey) push(journeyCardTitle(journeyState.journey), ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") push(ACTIVITY_LINES.journeyInvite.title, ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "skipped") push(ACTIVITY_LINES.journeySkipped.title, ACTIVITY_SECTIONS.journey);
    else if (journeyState.invitation.status === "accepted") push(ACTIVITY_LINES.journeyNone.message, ACTIVITY_SECTIONS.journey);

    if (!props.deliverySection.ok) push(ACTIVITY_LINES.feedUnavailable, ACTIVITY_SECTIONS.feed);
    else if (props.deliveries.length === 0) push(ACTIVITY_LINES.feedEmpty.message, ACTIVITY_SECTIONS.feed);
    else if (pending.length === 0) push(ACTIVITY_LINES.feedNoPending.message, ACTIVITY_SECTIONS.feed);
    else pending.forEach((item) => push(item.label, ACTIVITY_SECTIONS.feed));

    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      ...(props.error ? { statusLine: props.error.slice(0, 160) } : {}),
      items: rows.map((row, index) => ({
        ordinal: index + 1,
        label: row.label.slice(0, 120),
        state: row.state.slice(0, 40),
      })),
      ...(resolved.length > 0 ? { notice: resolvedGroupLabel(resolved.length) } : {}),
    };
  }, [journeyState, learningContext, pending, props.deliverySection, props.error, props.learningContextSection, resolved.length, resumeCandidate, startCandidate]);
  usePageReadableView(activityReadableView);

  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>动态</h3><p>邀请、旅程与主动状态只列出系统允许你做的动作。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}

    <section className="companion-activity-feed" aria-label="学习衔接">
      <h4>继续学习</h4>
      {!props.learningContextSection.ok
        ? <SectionState message={ACTIVITY_LINES.learningUnavailable} detail={props.learningContextSection.message} onRetry={props.onRetry} />
        : resumeCandidate
          ? <article className="companion-activity-card"><div><strong>{resumeCandidate.title}</strong><p>{resumeCandidate.targetSummary}</p><small>{resumeCandidate.impactSummary}</small></div><button type="button" className="button primary" onClick={() => props.onResumeLearning(resumeCandidate.runId)}>{RESUME_RUN_ACTION_LABEL}</button></article>
          : startCandidate
            ? <article className="companion-activity-card"><div><strong>{startCandidate.title}</strong><p>{startCandidate.targetSummary}</p><small>{startCandidate.impactSummary}</small></div><button type="button" onClick={() => props.onOpenObjective(startCandidate.objectiveId)}>查看目标</button></article>
            : <SectionState message={ACTIVITY_LINES.learningNothing.message} detail={ACTIVITY_LINES.learningNothing.detail} />}
    </section>

    <section className="companion-activity-feed" aria-label="伴星旅程">
      <h4>伴星旅程</h4>
      {!journeyState ? <SectionState message={ACTIVITY_LINES.journeyUnavailable} detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} /> : <>
        {(journeyState.invitation.status === "offered" || journeyState.invitation.status === "deferred") && !journeyState.journey ? <article className="companion-activity-card"><Sparkles size={18} /><div><strong>开始第一段学习旅程</strong><p>从你自己的资料开始，伴星会跟随真实进度。</p></div><button type="button" className="button primary" disabled={props.busy} onClick={() => props.onStart("start_journey")}>开始旅程</button></article> : null}
        {journeyState.invitation.status === "skipped" && !journeyState.journey ? <article className="companion-activity-card"><div><strong>旅程邀请已跳过</strong><p>需要时可以重新开始，不会补造任何里程碑。</p></div><button type="button" disabled={props.busy} onClick={() => props.onStart("replay")}>重新邀请</button></article> : null}
        {journeyState.journey ? <article className="companion-activity-card is-journey"><div><strong>{journeyCardTitle(journeyState.journey)}</strong><p>{journeyCardSummary(journeyState.journey)}</p></div><div className="companion-action-row">{journeyState.journey.status === "active" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "pause" })}>暂停</button> : null}{journeyState.journey.status === "paused" ? <button type="button" className="button primary" disabled={props.busy} onClick={() => props.onAction({ kind: "resume", resumeToken: journeyState.journey!.resumeTokenRef })}>继续</button> : null}{journeyState.journey.status === "recoverable_error" && journeyState.journey.error?.retryable ? <button type="button" className="button primary" disabled={props.busy} onClick={() => props.onAction({ kind: "retry" })}>重试</button> : null}{journeyState.journey.status === "active" || journeyState.journey.status === "paused" ? <button type="button" disabled={props.busy} onClick={() => props.onAction({ kind: "skip" })}>结束旅程</button> : null}</div></article> : null}
        {/* 旅程是空间级的：另一个空间的旅程不在这里露出（2026-09-22 裁决）。 */}
        {!journeyState.journey && journeyState.invitation.status === "accepted" ? <SectionState message={ACTIVITY_LINES.journeyNone.message} detail={ACTIVITY_LINES.journeyNone.detail} /> : null}
      </>}
    </section>

    <section className="companion-activity-feed companion-activity-feed--inbox" aria-label="主动投递与状态更新">
      <h4>最近动态</h4>
      {!props.deliverySection.ok
        ? <SectionState message={ACTIVITY_LINES.feedUnavailable} detail={props.deliverySection.message} onRetry={props.onRetry} />
        : props.deliveries.length === 0
          ? <SectionState message={ACTIVITY_LINES.feedEmpty.message} detail={ACTIVITY_LINES.feedEmpty.detail} />
          : <>
            {pending.length > 0
              ? pending.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)
              : <SectionState message={ACTIVITY_LINES.feedNoPending.message} detail={ACTIVITY_LINES.feedNoPending.detail} />}
            {resolved.length > 0 ? <details className="companion-delivery-group">
              <summary>{resolvedGroupLabel(resolved.length)}</summary>
              <div>{resolved.map((item) => <ActivityDeliveryCard key={item.deliveryId} item={item} busy={props.busy} onPresent={props.onPresent} onDelivery={props.onDelivery} />)}</div>
            </details> : null}
          </>}
    </section>
  </div>;
}

function ActivityDeliveryCard({ item, busy, onPresent, onDelivery }: {
  readonly item: CompanionActivityDeliveryV1;
  readonly busy: boolean;
  readonly onPresent: (item: CompanionActivityDeliveryV1) => void;
  readonly onDelivery: (item: CompanionActivityDeliveryV1, transition: "acted" | "dismissed") => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || item.expired || !["queued", "delivered"].includes(item.state) || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)) {
        onPresent(item);
        observer.disconnect();
      }
    }, { root: element.closest(".companion-tab-panel, .companion-stage"), threshold: 0.6 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [item, onPresent]);

  return <article ref={ref} className={`companion-delivery-card is-${item.state}${item.expired ? " is-expired" : ""}`}><div><strong>{item.label}</strong><small>{formatRelative(item.createdAt)} · {item.expired ? "已失效" : item.state === "acted" ? "已处理" : item.state === "dismissed" ? "已忽略" : "待处理"}</small></div>{!item.expired && DELIVERY_PENDING_STATES.includes(item.state) ? <div className="companion-action-row"><button type="button" className="button primary" disabled={busy} onClick={() => onDelivery(item, "acted")}>{item.target.kind === "none" ? "知道了" : "查看"}</button><button type="button" disabled={busy} onClick={() => onDelivery(item, "dismissed")}>忽略</button></div> : null}</article>;
}

/**
 * 日记那一格屏上就那几句状态字，各写一次：`SectionState` 与登记给伴星的可读视图
 * 共用同一份（视图字段写错不会红，抄成两处迟早分叉）。
 */
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
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
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
    const prose = daily.blocks.filter((block) => block.type === "text" && block.text.trim().length > 0);
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
                label: (block as { text: string }).text.slice(0, 120),
              })),
            ].slice(0, 12),
          }
        : {}),
    };
  }, [props.date, props.failure, props.loading, props.section]);
  usePageReadableView(diaryReadableView);
  if (props.loading && !props.section) return <SectionState message={DIARY_LOADING} />;
  if (!props.section) return <SectionState message={DIARY_UNAVAILABLE} detail={props.failure ?? undefined} onRetry={props.onRetry} />;
  if (!props.section.ok) return <SectionState message={DIARY_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} />;
  const daily = props.section.value; const anchor = props.date ?? daily.date ?? todayIsoDate(); const today = todayIsoDate();
  return <div className="companion-panel-stack">
    <div className="companion-panel-heading"><div><h3>日记</h3><p>伴星会将每天的旅程写成日记展示在这里。</p></div></div>
    {/* 日期筛选与聊天记录共用那张月历（2026-09-22 用户指定）：平时收成一颗日期胶囊，
        点开才是月历；前一天 / 后一天留在页面上，翻页不必经过日历。
        原来这里是五个 `09-17` 这样的裸字符串横排，既读不出「这是哪天」，也只能回看五天。 */}
    <div className="companion-date-nav" ref={navRef}>
      <button type="button" onClick={() => props.onDate(shiftIsoDate(anchor, -1))}><ChevronLeft size={15} />前一天</button>
      <div className="companion-date-pick">
        <button type="button" className="companion-date-pick__trigger" data-active={calendarOpen || undefined} aria-expanded={calendarOpen} aria-controls="companion-diary-calendar" aria-label={`选择日记日期，当前 ${diaryDayLabel(anchor)}`} onClick={() => setCalendarOpen((value) => !value)}>
          <CalendarDays size={14} aria-hidden="true" /><span>{diaryDayLabel(anchor)}</span><ChevronDown size={13} aria-hidden="true" />
        </button>
        {calendarOpen ? <MonthCalendar key={anchor} panelId="companion-diary-calendar" selected={anchor} maxDay={today} marks={props.marks} onMonthChange={props.onMarksMonth} onPick={(day) => { props.onDate(day); setCalendarOpen(false); }} footer={props.marksFailure ? <p className="companion-diary-marks-failed">这个月她写过哪几天，这次没读出来；下面的点先别当准。</p> : null} /> : null}
      </div>
      <button type="button" disabled={anchor >= today} onClick={() => props.onDate(shiftIsoDate(anchor, 1))}>后一天<ChevronRight size={15} /></button>
    </div>
    {daily.status === "generated"
      ? <article className="companion-diary-entry">
          {/* 按她给的顺序排：图跟在说到它的那段后面，不是全堆在末尾。
              渲染器直接复用对话记录那两处（含长引用的量高折叠与图片取回重试），
              不在这页再抄一份"图片显示不出来时说什么"。 */}
          {daily.blocks.map((block, index) => block.type === "text"
            ? <p className="companion-diary-prose" key={`text-${index}`}>{block.text}</p>
            : block.type === "quote"
              ? <CompanionQuoteBlock block={block} key={`quote-${index}`} />
              : block.type === "image"
                ? <CompanionRecordImage block={block} key={`image-${index}`} />
                : null)}
          {daily.selectionReason ? <small>她选了这段：{daily.selectionReason}</small> : null}
          <small>{daily.generatedAt ? `生成于 ${formatDate(daily.generatedAt)}` : "生成时间未提供"}</small>
          {daily.memory ? <button type="button" onClick={() => props.onMemory(daily.memory!.memoryItemId)}>查看关联记忆</button> : null}
          {/* 聊聊这篇：日记页的次级动作。它带出日期与版本，让伴星按**当前权限**
              现读那一篇，而不是让用户把全文复制粘贴（§6）。 */}
          {daily.date ? <button
            type="button"
            onClick={() => props.onDiscussDiary({ date: daily.date!, version: daily.revision })}
            aria-label={`聊聊 ${daily.date} 这篇日记`}
          >聊聊这篇</button> : null}
          {/* 隐藏 vs 删除：合同把这两件事的后果写得完全不同。
              隐藏——从列表与推荐里移除，但**不删内容**、能恢复；
              删除——连派生预览与摘录一起清掉，不能恢复。
              所以措辞也要不同：这里说「藏起来」，下面说「删掉」。 */}
          {daily.hidden
            ? <button type="button" disabled={props.busy !== null} onClick={props.onUnhideDiary}>取消隐藏</button>
            : <button type="button" disabled={props.busy !== null} onClick={props.onHideDiary}>藏起来</button>}
          {props.confirmDeleteDiary
            ? <span className="companion-action-row">
                <button
                  type="button"
                  className="button danger"
                  disabled={props.busy !== null}
                  onClick={() => props.onDeleteDiary()}
                >确认删掉这一篇</button>
                <button type="button" disabled={props.busy !== null} onClick={() => props.onConfirmDeleteDiary(false)}>不删了</button>
              </span>
            : <button type="button" disabled={props.busy !== null} onClick={() => props.onConfirmDeleteDiary(true)}>
                删掉这一篇
              </button>}
        </article>
      : <SectionState message={daily.status === "failed" ? DIARY_DAY_FAILED : DIARY_DAY_EMPTY} detail={daily.status === "failed" ? DIARY_FAILURE_DETAIL[daily.failureReason ?? "unknown"] : undefined} />}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
  </div>;
}

export function DiarySettingsPanel(props: {
  readonly enabled: boolean | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChange: (enabled: boolean) => void;
  readonly onRetry: () => void;
}) {
  const readableView = useMemo<PageReadableV1>(() => ({
    pageId: "companion",
    title: HUD_PAGES.companion.title,
    statusLine: props.enabled === null
      ? "日记设置暂时不可用"
      : props.enabled ? "自动日记已开启" : "自动日记已暂停",
    ...(props.error ? { notice: props.error.slice(0, 120) } : {}),
  }), [props.enabled, props.error]);
  usePageReadableView(readableView);

  return <div className="companion-panel-stack">
    <div className="companion-panel-heading">
      <div><h3>自动日记</h3><p>单独控制日记生成，不影响学习、提醒或伴星对话。</p></div>
    </div>
    {props.enabled === null
      ? <SectionState message="日记设置暂时不可用" detail={props.error ?? "无法读取当前设置。"} onRetry={props.onRetry} />
      : <div className="companion-boundaries">
          <button
            type="button"
            role="switch"
            aria-label="自动生成日记"
            aria-checked={props.enabled}
            disabled={props.busy}
            onClick={() => props.onChange(!props.enabled)}
          >
            <span><strong>自动准备每日手记</strong><small>暂停期间不收集日记素材；重新开启后只从开启时起积累。</small></span>
            <span className="companion-switch" data-on={props.enabled || undefined} aria-hidden="true"><i /></span>
          </button>
        </div>}
    {props.error && props.enabled !== null ? <p role="alert">{props.error}</p> : null}
  </div>;
}

/**
 * 「待生效」那一版的正文与那一行的措辞（40 §4.8.4 / A50）。
 *
 * `pending.pending.profile` 可能是 `null`：那不是"这一版没有内容"，而是
 * 「这一版的内容是回到当前发布的默认表达」。把它读成"没有内容"的话，界面就会
 * 对着一张空卡说"已排好队"，而用户看到的是她其实还是原来那个样子。
 */
type PersonaPendingProps = {
  /**
   * 读回的那一版与它的指针。**缺省 = 还没读到**，面板因此先不出声。
   *
   * 「读到且没有排队」不是 `null`，而是 `{ pending: null }` —— 把它做成缺省，
   * "还没读过" 与 "读过了，没有排队" 就成了同一个值，而后者是面板可以断言的事实，
   * 前者不是。
   */
  readonly pending?: CompanionPersonaPendingV1;
  readonly pendingError?: string | null;
  readonly onActivatePending?: () => void;
  readonly onRetryPending?: () => void;
};

type PersonaPanelProps = { section: Section<CompanionPersonaV1>; persona: CompanionPersonaV1 | null; versions: CompanionPersonaProfileVersionV1[] | null; versionsError: string | null; busy: string | null; error: string | null; notice: string | null; onPreset: (preset: CompanionPersonaPresetV1) => void; onActiveness: (value: CompanionPersonaProfileV1["activeness"]) => void; onBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void; onReset: () => void; onRestore: (revision: number) => void; onReloadVersions: () => void; onRename: (name: string) => void; onRetry: () => void } & PersonaPendingProps;
/**
 * 改名那一行。草稿住在本地，且**只在真的改过时覆盖**当前值：`null` 表示"跟着档案"，
 * 于是服务端回什么就显示什么，不会出现输入框和档案各存一份名字。
 * 单独成组件是因为 `PersonaPanel` 在 hooks 之前就有早退。
 */
function CompanionNameRow(props: { readonly current: string; readonly busy: boolean; readonly onRename: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.current;
  const trimmed = shown.trim();
  const dirty = trimmed.length > 0 && trimmed !== props.current;
  const commit = () => { props.onRename(trimmed); setDraft(null); };
  // 容器与按钮行都用伴星中心现成的两块（`.companion-inline-form` /
  // `.companion-action-row`，记忆纠正那一套用的就是它们），不为一行输入新开一档样式。
  return <div className="companion-inline-form">
    <input
      type="text"
      value={shown}
      maxLength={60}
      aria-label="她叫什么"
      disabled={props.busy}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && dirty) { event.preventDefault(); commit(); } }}
    />
    <div className="companion-action-row">
      <button type="button" className="button primary" disabled={props.busy || !dirty} onClick={commit}>改名</button>
      {dirty ? <button type="button" onClick={() => setDraft(null)}>取消</button> : null}
    </div>
  </div>;
}

const PERSONA_UNAVAILABLE = "人格档案当前不可用";
const PERSONA_SECTIONS = { appearance: "人格外观", boundaries: "边界", pending: "待生效版本" } as const;
/** 活跃度那三个词的屏上写法：分段按钮与她读到的那一格共用一份。 */
function activenessLabel(value: CompanionPersonaProfileV1["activeness"] | undefined): string | null {
  if (value === "quiet") return "安静";
  if (value === "moderate") return "适度";
  if (value === "active") return "活跃";
  return null;
}

/** 版本是谁排的：屏上版本卡与「待生效」那一行共用一份，不各写一遍。 */
const PERSONA_VERSION_AUTHOR_LABEL: Record<CompanionPersonaPendingRevisionV1["author"], string> = {
  user: "你排的",
  assistant_tool: "她调整的",
  restore: "恢复旧版时排的",
  migration: "历史导入",
};
const PERSONA_NO_PENDING = "现在没有排队的人格版本。";
const PERSONA_PENDING_LOADING = "正在读取待生效版本…";

export function PersonaPanel(props: PersonaPanelProps) {
  const [showOlderVersions, setShowOlderVersions] = useState(false);
  const olderVersionsId = useId();
  useEffect(() => setShowOlderVersions(false), [props.versions]);
  const personaReadableView = useMemo<PageReadableV1 | null>(() => {
    const profile = props.persona?.profile ?? null;
    if (!props.section.ok || !props.persona) {
      return {
        pageId: "companion",
        title: HUD_PAGES.companion.title,
        statusLine: PERSONA_UNAVAILABLE,
        ...(!props.section.ok ? { notice: `${PERSONA_UNAVAILABLE}：${props.section.message.slice(0, 60)}` } : {}),
      };
    }
    const rows: Array<{ label: string; state: string }> = [];
    const push = (label: string, state: string) => {
      if (label.trim() && rows.length < 12) rows.push({ label, state });
    };
    props.persona.presets.forEach((preset) => push(preset.name, PERSONA_SECTIONS.appearance));
    BOUNDARY_ITEMS.forEach(([, label]) => push(label, PERSONA_SECTIONS.boundaries));
    const presetName = props.persona.presets.find((preset) => preset.presetId === profile?.presetId)?.name;
    // 「当前 / 待生效 + 生效条件」是合同点名要在**回执**里给出的一格（A50）。
    // 它进 filters 而不是 notice：它是屏上那一段的稳定事实，不是刚发生的一次结果。
    const pendingRevision = props.pending?.pending?.revision ?? null;
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: props.notice ?? props.error ?? undefined,
      filters: [
        { label: "当前版本", value: `第 ${props.persona.profileRevision} 版`.slice(0, 40) },
        ...(presetName ? [{ label: "当前预设", value: presetName.slice(0, 40) }] : []),
        ...(activenessLabel(profile?.activeness) ? [{ label: "活跃度", value: activenessLabel(profile?.activeness)!.slice(0, 40) }] : []),
        ...(pendingRevision ? [
          { label: "待生效版本", value: `第 ${pendingRevision} 版`.slice(0, 40) },
          { label: "生效条件", value: props.pending!.pending!.effectiveWhen.slice(0, 40) },
        ] : []),
      ],
      items: rows.map((row, index) => ({ ordinal: index + 1, label: row.label.slice(0, 120), state: row.state.slice(0, 40) })),
    };
  }, [props.error, props.notice, props.pending, props.persona, props.section]);
  usePageReadableView(personaReadableView);
  if (!props.section.ok || !props.persona) return <SectionState message={PERSONA_UNAVAILABLE} detail={!props.section.ok ? props.section.message : undefined} onRetry={props.onRetry} />;
  const profile = props.persona.profile;
  const currentRevision = props.persona.profileRevision;
  const pendingRevision = props.pending?.pending?.revision ?? null;
  const versionCard = (version: CompanionPersonaProfileVersionV1) => <article key={version.id} className="companion-inline-form" data-pending={version.revision === pendingRevision || undefined}>
    <strong>第 {version.revision} 版{version.profile ? ` · ${version.profile.name}` : " · 系统默认"}</strong>
    {/*
      排队中的那一版在历史里也要看得出来：它已经落库、可查、也还能恢复，
      只是**还没被使用**。少了这个标记，用户会以为这一版已经生效了。
    */}
    {version.revision === pendingRevision ? <span className="tag">待生效</span> : null}
    <small>{formatDate(version.createdAt)} · {version.action === "reset" ? "恢复默认" : version.action === "restore" ? "恢复旧版" : version.action === "migration" ? "迁入账号档案" : version.author === "assistant_tool" ? "伴星调整" : "手动修改"}</small>
    {version.profile ? <p>{version.profile.speakingStyle}</p> : null}
    <button type="button" className="button" disabled={props.busy !== null || version.revision === currentRevision} onClick={() => props.onRestore(version.revision)}>{version.revision === currentRevision ? "当前版本" : `恢复第 ${version.revision} 版`}</button>
  </article>;
  return <div className="companion-panel-stack companion-persona-groups">
    <div className="companion-panel-heading"><div><h3>人格</h3><p>人格在账号的各个空间共享；改动会用于下一次尚未开始的调用。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>她叫什么</h4><p>署名、对话记录与轨道上的说明都跟着换。</p>
      {profile ? <CompanionNameRow current={profile.name} busy={props.busy !== null} onRename={props.onRename} /> : null}
    </section>
    <section>
      <h4>{PERSONA_SECTIONS.appearance}</h4><p>选择系统提供的完整人格预设。</p>
      <div className="companion-choice-grid">{props.persona.presets.map((preset) => <button key={preset.presetId} type="button" aria-pressed={profile?.presetId === preset.presetId} className={profile?.presetId === preset.presetId ? "is-selected" : undefined} disabled={props.busy !== null} onClick={() => props.onPreset(preset)}><strong>{preset.name}</strong><span>{preset.speakingStyle}</span></button>)}</div>
      <button type="button" disabled={!profile || props.busy !== null} onClick={props.onReset}>恢复系统默认人格</button>
    </section>
    <section>
      <h4>活跃度</h4><p>她一次说多少、日记写多细。<strong>多久主动开口一次不在这里</strong>——那由账户页的「主动介入」决定。</p>
      <div className="companion-segmented">{(["quiet", "moderate", "active"] as const).map((value) => <button key={value} type="button" aria-pressed={profile?.activeness === value} className={profile?.activeness === value ? "is-selected" : undefined} disabled={!profile || props.busy !== null} onClick={() => props.onActiveness(value)}>{activenessLabel(value)}</button>)}</div>
    </section>
    <section>
      <h4>{PERSONA_SECTIONS.boundaries}</h4><p>每项都是独立授权，关闭后伴星不会把它当成默认同意。</p>
      <div className="companion-boundaries">{BOUNDARY_ITEMS.map(([key, label, detail]) => <button key={key} type="button" role="switch" aria-checked={profile?.boundaries[key] === true} disabled={!profile || props.busy !== null} onClick={() => props.onBoundary(key)}><span><strong>{label}</strong><small>{detail}</small></span><span className="companion-switch" data-on={profile?.boundaries[key] === true || undefined} aria-hidden="true"><i /></span></button>)}</div>
    </section>
    {/* 这一格是「她改了但还没开始用」的落点。放在人格版本**之前**是有意的：
        用户改完上面那几项就会顺着读下来，最先撞上的就该是"还有一版在排队"。 */}
    <section>
      <h4>{PERSONA_SECTIONS.pending}</h4>
      <p>她调整自己的表达时会先排在这里，<strong>当前正在用的那一版不会因此改变</strong>；你也可以现在就让它生效。</p>
      {/*
        两态要分清：**还没读到**（缺省）不是**读到且没有排队**（`pending: null`）。
        合并成一个的话，面板会在第一次请求返回之前说「现在没有排队的人格版本」——
        那是一句它并不知道的事实，而这一格恰恰是用户判断"她是不是已经改了"的依据。
      */}
      {props.pendingError ? <>
        <p className="companion-error" role="alert">待生效版本暂时读不到：{props.pendingError}</p>
        {props.onRetryPending ? <button type="button" onClick={props.onRetryPending}>重试读取</button> : null}
      </> : !props.pending ? null : props.pending.pending === null ? <p>{PERSONA_NO_PENDING}</p> : (() => {
        const staged = props.pending!.pending!;
        return <article className="companion-inline-form" data-pending>
          <strong>第 {staged.revision} 版{staged.profile ? ` · ${staged.profile.name}` : " · 回到系统默认表达"}</strong>
          {/* 生效条件由服务端算好（模型自改下一会话、用户直接纠正下一轮未开始的调用）。
              界面不复述成另一句：用户判断"现在改还来不来得及"靠的就是这一格。 */}
          <small>{PERSONA_VERSION_AUTHOR_LABEL[staged.author]} · 排于 {formatDate(staged.stagedAt)} · {staged.effectiveWhen}</small>
          {staged.profile ? <p>{staged.profile.speakingStyle}</p> : null}
          <button type="button" className="button primary" disabled={props.busy !== null} data-busy={props.busy === "activate-pending" || undefined} onClick={props.onActivatePending}>{props.busy === "activate-pending" ? "正在生效…" : "现在生效"}</button>
        </article>;
      })()}
    </section>
    <section>
      <h4>人格版本</h4><p>每次修改、恢复默认或恢复旧版都会留下新版本。恢复不会改动各空间分别累积的熟悉度。</p>
      {props.versionsError ? <p className="companion-error" role="alert">版本记录暂时无法读取：{props.versionsError}</p> : null}
      {props.versions === null && !props.versionsError ? <p role="status">正在读取版本记录…</p> : null}
      {props.versions?.length === 0 ? <p>还没有人格版本记录。</p> : null}
      {props.versions?.slice(0, 20).map(versionCard)}
      {props.versions && props.versions.length > 20 ? <>
        <button type="button" className="text-action" aria-expanded={showOlderVersions} aria-controls={olderVersionsId} onClick={() => setShowOlderVersions((value) => !value)}>
          {showOlderVersions ? "收起较早版本" : `查看更早版本（${props.versions.length - 20}）`}
        </button>
        <div id={olderVersionsId} hidden={!showOlderVersions}>{props.versions.slice(20).map(versionCard)}</div>
      </> : null}
      {props.versionsError ? <button type="button" onClick={props.onReloadVersions}>重试读取版本</button> : null}
    </section>
  </div>;
}

type DataPanelProps = { busy: string | null; error: string | null; notice: string | null; dangerConfirm: "memory" | "history" | "audit" | null; conflictItems: CompanionMemoryItemV1[] | null; onDangerConfirm: (value: "memory" | "history" | "audit" | null) => void; onConflicts: () => void; onResolveConflict: (keepId: string, removeId: string) => void; onRebuild: () => void; onExport: (kind: CompanionExportKindV1) => void; onDanger: (kind: "memory" | "history" | "audit") => void; diagnostics: { mapVersion: number | null; memoryCount: number; historyCount: number } };
const DATA_SECTIONS = { check: "检查与整理", export: "导出副本", danger: "清除数据" } as const;
const DATA_CHECK_ROWS = { conflicts: "检查记忆冲突", conflictsIdle: "按需检查待处理的冲突", rebuild: "整理记忆检索索引" } as const;
const CONFLICT_PICK_LINE = "选择要保留的记忆";
/** 三颗危险按钮：标题与说明各一份，屏上与她读到的都是这一处。 */
const DANGER_ACTIONS = [
  { kind: "memory", title: "清空全部记忆", detail: "删除长期记忆、候选和星图关系；连续对话与人格保留。" },
  { kind: "history", title: "清空连续对话记录", detail: "删除对话和动态收件记录；记忆、人格、旅程与操作记录保留。" },
  { kind: "audit", title: "删除操作与邀请记录", detail: "删除当前工作区内你的安全操作与邀请记录；不会重新触发邀请。" },
] as const;

export function DataPanel(props: DataPanelProps) {
  /**
   * 这一格登记的是**屏上此刻列出的那些操作**（39d W2-7）。开发诊断那段不在内：
   * 它只在 DEV 构建渲染，不是给用户读的事实；危险操作只登记标题——展开确认后才
   * 看得到的说明不进载荷（同"折叠里的行不算露出"那条）。
   */
  const dataReadableView = useMemo<PageReadableV1 | null>(() => {
    const rows: Array<{ label: string; state: string }> = [
      { label: DATA_CHECK_ROWS.conflicts, state: DATA_SECTIONS.check },
      { label: DATA_CHECK_ROWS.rebuild, state: DATA_SECTIONS.check },
      ...(["all", "memory", "audit"] as const).map((kind) => ({ label: EXPORT_COPY[kind].label, state: DATA_SECTIONS.export })),
      ...DANGER_ACTIONS.map((action) => ({ label: action.title, state: DATA_SECTIONS.danger })),
      // 查出冲突之后，那一段是真的铺开在屏上（不是 `<details>` 里）：分组提示与
      // 每一条候选正文都登记，否则她只知道"有冲突"却不知道要她在留哪一条。
      ...(props.conflictItems && props.conflictItems.length > 1
        ? [{ label: CONFLICT_PICK_LINE, state: DATA_SECTIONS.check },
            ...props.conflictItems.map((item) => ({ label: item.content, state: DATA_SECTIONS.check }))]
        : []),
    ].slice(0, 12);
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: props.notice ?? props.error ?? undefined,
      metrics: [{
        label: "记忆冲突",
        value: (props.conflictItems === null
          ? DATA_CHECK_ROWS.conflictsIdle
          : `发现 ${props.conflictItems.length} 条冲突记录`).slice(0, 40),
      }],
      items: rows.map((row, index) => ({ ordinal: index + 1, label: row.label.slice(0, 120), state: row.state.slice(0, 40) })),
    };
  }, [props.conflictItems, props.error, props.notice]);
  usePageReadableView(dataReadableView);
  const conflictGroups = props.conflictItems ? Object.values(props.conflictItems.reduce<Record<string, CompanionMemoryItemV1[]>>((groups, item) => {
    if (item.conflictGroup) (groups[item.conflictGroup] ??= []).push(item);
    return groups;
  }, {})) : null;
  return <div className="companion-panel-stack companion-data-groups">
    <div className="companion-panel-heading"><div><h3>数据与隐私</h3><p>检查、导出和清除分别分组；每个危险操作都会再次确认。</p></div></div>
    {props.error ? <p className="companion-error" role="alert">{props.error}</p> : null}
    {props.notice ? <p className="companion-notice" role="status">{props.notice}</p> : null}
    <section>
      <h4>{DATA_SECTIONS.check}</h4><p>这些操作只整理真实记录，不会生成新的学习内容。</p>
      <div className="companion-data-actions">
        <button type="button" disabled={props.busy !== null} onClick={props.onConflicts}><AlertTriangle size={14} /><span><strong>{DATA_CHECK_ROWS.conflicts}</strong><small>{props.conflictItems === null ? DATA_CHECK_ROWS.conflictsIdle : `发现 ${props.conflictItems.length} 条冲突记录`}</small></span></button>
        {conflictGroups?.map((group) => group.length > 1 ? <div key={group[0].conflictGroup ?? group[0].memoryItemId} className="companion-conflict-group"><strong>{CONFLICT_PICK_LINE}</strong>{group.map((item) => <button key={item.memoryItemId} type="button" disabled={props.busy !== null} onClick={() => props.onResolveConflict(item.memoryItemId, group.find((candidate) => candidate.memoryItemId !== item.memoryItemId)!.memoryItemId)}><span>{item.content}</span><small>保留此条</small></button>)}</div> : null)}
        <button type="button" disabled={props.busy !== null} onClick={props.onRebuild}><Database size={14} /><span><strong>{DATA_CHECK_ROWS.rebuild}</strong><small>只更新查找能力，不改动记忆正文</small></span></button>
      </div>
    </section>
    <section>
      <h4>{DATA_SECTIONS.export}</h4><p>通过系统保存窗口把当前数据保存到本机。</p>
      <div className="companion-data-actions">
        {(["all", "memory", "audit"] as const).map((kind) => <button key={kind} type="button" disabled={props.busy !== null} onClick={() => props.onExport(kind)}><Download size={14} /><span><strong>{EXPORT_COPY[kind].label}</strong><small>{EXPORT_COPY[kind].detail}</small></span></button>)}
      </div>
    </section>
    <section className="companion-danger-zone">
      <h4>{DATA_SECTIONS.danger}</h4><p>清除后无法在应用内恢复；每项只影响说明中列出的内容。</p>
      <div className="companion-data-actions">
        {DANGER_ACTIONS.map((action) => <DangerAction key={action.kind} active={props.dangerConfirm === action.kind} busy={props.busy === action.kind} title={action.title} detail={action.detail} onOpen={() => props.onDangerConfirm(action.kind)} onCancel={() => props.onDangerConfirm(null)} onConfirm={() => props.onDanger(action.kind)} />)}
      </div>
    </section>
    {import.meta.env.DEV ? <section><h4>开发诊断</h4><p>仅开发构建可见；不提供制造提案或手工注入事件。</p><dl className="companion-diagnostics"><div><dt>记忆图谱</dt><dd>{props.diagnostics.mapVersion ? `V${props.diagnostics.mapVersion}` : "不可用"}</dd></div><div><dt>记忆节点</dt><dd>{props.diagnostics.memoryCount}</dd></div><div><dt>已读历史</dt><dd>{props.diagnostics.historyCount}</dd></div></dl></section> : null}
  </div>;
}

function DangerAction(props: { active: boolean; busy: boolean; title: string; detail: string; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const actionsId = useId();
  const openRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const wasActive = useRef(false);
  useEffect(() => {
    if (props.active && !wasActive.current) confirmRef.current?.focus();
    if (!props.active && wasActive.current) openRef.current?.focus();
    wasActive.current = props.active;
  }, [props.active]);
  return <div className="companion-danger-action"><Trash2 size={14} /><span><strong>{props.title}</strong><small>{props.detail}</small></span><div id={actionsId}><button ref={openRef} type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} aria-controls={actionsId} onClick={props.active ? props.onCancel : props.onOpen}>{props.active ? "取消" : "清除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>{props.busy ? "正在清除…" : "确认清除"}</button> : null}</div></div>;
}

/**
 * 彻底清除：**不可逆**，所以与"删除"分成两个独立入口，不共用一次确认。
 *
 * 为什么不能并到 `MemoryDeleteAction` 里当第三个按钮：那个按钮点完是
 * "确认删除"——用户已经为"删掉"付过一次确认了。再挂一个同样措辞的按钮，
 * 就会让人以为它和删除是同一件事的不同结果，而实际上**一个进回收区、
 * 一个什么都不剩**。所以这里的措辞必须自己说清不可逆。
 */
function MemoryEraseAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (props.active) confirmRef.current?.focus(); }, [props.active]);
  return <><button type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} onClick={props.active ? props.onCancel : props.onOpen}>
    <Trash2 size={13} />{props.active ? "取消彻底清除" : "彻底清除"}
  </button>{props.active ? <span className="small" role="alert">删掉就找不回来了，也没有回收区。确定？</span>
    : null}{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>确认彻底清除</button> : null}</>;
}

function MemoryDeleteAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (props.active) confirmRef.current?.focus();
  }, [props.active]);
  return <><button type="button" className="danger-quiet" disabled={props.busy} aria-expanded={props.active} onClick={props.active ? props.onCancel : props.onOpen}><Trash2 size={13} />{props.active ? "取消删除" : "删除"}</button>{props.active ? <button ref={confirmRef} type="button" className="danger" disabled={props.busy} data-busy={props.busy || undefined} onClick={props.onConfirm}>确认删除</button> : null}</>;
}
