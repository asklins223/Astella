import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import type { CompanionMemoryItemV1,CompanionMemoryKindV1,CompanionMemoryRevisionV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { Archive,Pencil,Pin,Plus,Trash2 } from "lucide-react";
import { useEffect,useMemo,useRef,type KeyboardEvent } from "react";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatRelative } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { isCompanionJudgment,MEMORY_KIND_LABEL,MEMORY_KIND_OPTIONS,MEMORY_SCOPE_LABEL,MEMORY_STATE_LABEL,memoryState } from "./companion-center-model";
import { CenterFeedback,CenterSearch,SectionState } from "./companion-center-primitives";
import { CompanionSelect,type CompanionSelectOption } from "./companion-select";

const MEMORY_CREATABLE_KIND_OPTIONS = MEMORY_KIND_OPTIONS.filter((option) => option.value !== "judgment");

const MEMORY_LIST_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS,
];

export type MemoryStateFilter = "all" | "active" | "pinned" | "candidate" | "archived" | "expired";

function matchesMemoryStateFilter(item: CompanionMemoryItemV1, filter: MemoryStateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return !item.archived && !item.candidate && memoryState(item) !== "expired";
  return memoryState(item) === filter;
}

const MEMORY_PIN_OPTIONS: ReadonlyArray<CompanionSelectOption<MemoryStateFilter>> = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "正在使用" },
  { value: "candidate", label: "待确认" },
  { value: "pinned", label: "已固定" },
  { value: "archived", label: "已归档" },
  { value: "expired", label: "已过期" },
];

function formatMemoryTime(value: string | null): string {
  if (!value) return "来源时间";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
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

const MEMORY_NOT_STARTED = {
  message: "还没有留下记忆",
  detail: "聊聊近况，或手动添加一件希望她记住的事。",
} as const;

const MEMORY_AUTHOR_LABEL = { user: "用户修订", extractor: "从对话里提取", companion: "她自己的判断", maintenance: "后台整理" } as const;

const MEMORY_EPISTEMIC_LABEL = { supported: "有据", tentative: "待核对", disputed: "有争议", superseded: "已被替代" } as const;

const MEMORY_SOURCE_LABEL = { user_stated: "用户自述", model_inferred: "模型推断", confirmed: "用户确认", summary: "对话整理" } as const;

const MEMORY_SPEAKER_LABEL: Record<"user" | "assistant" | "companion", string> = {
  user: "用户原话",
  assistant: "伴星发言",
  companion: "她自己的理解（不是你说的话）",
};

export function MemoryPanel(props: MemoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focus) return;
    const selected = panelRef.current?.querySelector<HTMLElement>('.cc-memory-list button[aria-pressed="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [props.focus?.memoryItemId]);
  useEffect(() => {
    const selector = props.correctionOpen ? ".cc-memory-detail .cc-form" : props.createOpen ? ":scope > .cc-form" : null;
    if (!selector) return;
    const form = panelRef.current?.querySelector(selector);
    if (!form) return;
    // 便签在滚动列表里展开：整块表单（含保存按钮）要滚进可视区，否则主按钮被面板底边裁掉。
    form.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    form.scrollIntoView({ block: "nearest" });
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
  const aboutYou = visible.filter(item => !isCompanionJudgment(item));
  const herViews = visible.filter(isCompanionJudgment);
  const empty = props.items.length ? MEMORY_LIST_EMPTY : MEMORY_NOT_STARTED;
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
    const rows = [...visible.filter(item => !isCompanionJudgment(item)), ...visible.filter(isCompanionJudgment)]
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
      statusLine: props.notice ?? props.error ?? (visible.length === 0 ? empty.message : undefined),
      filters: [
        { label: "类型", value: optionLabel(MEMORY_LIST_KIND_OPTIONS, props.kind).slice(0, 40) },
        { label: "状态", value: optionLabel(MEMORY_PIN_OPTIONS, props.pinFilter).slice(0, 40) },
        ...(props.query.trim() ? [{ label: "关键词", value: props.query.trim().slice(0, 40) }] : []),
      ],
      ...(rows.length > 0 ? { items: rows } : {}),
      ...(visible.length === 0 ? { notice: `${empty.message}：${empty.detail}` } : {}),
    };
  }, [props.error, props.kind, props.notice, props.pinFilter, props.query, props.section, visible, empty]);
  usePageReadableView(memoryReadableView);
  useEffect(() => {
    if (visible.length && !visible.some(item => item.memoryItemId === props.focus?.memoryItemId)) props.onFocus(visible[0].memoryItemId);
  }, [visible, props.focus?.memoryItemId, props.onFocus]);
  if (!props.section.ok) return <SectionState message={MEMORY_LIST_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} />;
  const selected = visible.find(item => item.memoryItemId === props.focus?.memoryItemId) ?? null;
  const renderRow = (item: CompanionMemoryItemV1) => <button key={item.memoryItemId} type="button" aria-pressed={selected?.memoryItemId === item.memoryItemId} data-state={memoryState(item)} onClick={() => props.onFocus(item.memoryItemId)}>
    <span className="cc-memory-list__kind">{MEMORY_KIND_LABEL[item.kind]}<small>{MEMORY_STATE_LABEL[memoryState(item)]}</small></span>
    <strong>{item.content}</strong><time>{formatRelative(item.updatedAt)}</time>
  </button>;
  return <div ref={panelRef} className="cc-memory">
    <div className="cc-toolbar"><CenterSearch value={props.query} onChange={props.onQuery} placeholder="找一件她记住的事…" label="筛选记忆列表" /><button type="button" className="cc-button" onClick={() => props.onCreateOpen(!props.createOpen)}><Plus size={16} aria-hidden="true" />{props.createOpen ? "收起添加" : "手动添加"}</button></div>
    <div className="cc-filter-line" role="group" aria-label="记忆列表筛选"><CompanionSelect paper ariaLabel="筛选记忆列表类型" value={props.kind} options={MEMORY_LIST_KIND_OPTIONS} onChange={props.onKind} /><CompanionSelect paper ariaLabel="筛选记忆列表状态" value={props.pinFilter} options={MEMORY_PIN_OPTIONS} onChange={props.onPinFilter} /><span>{visible.length} 条</span><button type="button" className="cc-link" disabled={props.busy !== null} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button></div>
    {props.createOpen ? <form className="cc-form" onSubmit={event => { event.preventDefault(); props.onCreate(); }}><label>记忆类型<CompanionSelect paper ariaLabel="新记忆类型" value={props.createKind} options={MEMORY_CREATABLE_KIND_OPTIONS} onChange={props.onCreateKind} /></label><label>希望她记住的事<textarea value={props.createContent} maxLength={200} onChange={event => props.onCreateContent(event.currentTarget.value)} placeholder="写下希望伴星记住的偏好或事实" aria-label="新记忆内容" /></label><div className="cc-actions"><small>{props.createContent.length} / 200</small><button type="button" className="cc-link" onClick={() => props.onCreateOpen(false)}>取消</button><button type="submit" className="cc-button is-primary" disabled={!props.createContent.trim() || props.busy !== null}>{props.busy === "create" ? "正在保存…" : "保存记忆"}</button></div></form> : null}
    <CenterFeedback error={props.error} notice={props.notice} />
    <div className={visible.length ? "cc-memory-workspace" : "cc-memory-workspace is-empty"}>
      <div className="cc-memory-list" aria-label="记忆列表">{visible.length ? <>
        {aboutYou.length ? <section aria-label="关于你的"><h3>关于你的</h3>{aboutYou.map(renderRow)}</section> : null}
        {herViews.length ? <section aria-label="她的看法"><h3>她的看法<small>她对一件事的理解，可以纠正。</small></h3>{herViews.map(renderRow)}</section> : null}
      </> : <SectionState message={empty.message} detail={empty.detail} onRetry={props.query || props.kind !== "all" || props.pinFilter !== "all" ? () => { props.onQuery(""); props.onKind("all"); props.onPinFilter("all"); } : undefined} />}</div>
      {visible.length ? <aside className="cc-memory-focus" aria-label="所选记忆详情">{selected ? <article className="cc-memory-detail">
        <header><span className="cc-kicker">{MEMORY_KIND_LABEL[selected.kind]}</span><span className="cc-badge">{MEMORY_STATE_LABEL[memoryState(selected)]}</span></header>
        {props.correctionOpen ? <form className="cc-form" onSubmit={event => { event.preventDefault(); props.onCorrect(); }}><label>纠正这条记忆<textarea value={props.correctionContent} maxLength={200} onChange={event => props.onCorrectionContent(event.currentTarget.value)} aria-label="纠正后的记忆内容" /></label><div className="cc-actions"><button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(false)}>取消</button><button type="submit" className="cc-button is-primary" disabled={!props.correctionContent.trim() || props.correctionContent.trim() === selected.content || props.busy !== null}>{props.busy === "correct" ? "正在保存…" : "保存修订"}</button></div></form> : <p className="cc-memory-detail__body">{selected.content}</p>}
        <dl className="cc-facts"><div><dt>来源</dt><dd>{selected.sourceSpeaker ? MEMORY_SPEAKER_LABEL[selected.sourceSpeaker] : MEMORY_SOURCE_LABEL[selected.sourceType]}{selected.sourceBasis === "inferred_from_statement" ? "（根据原话整理）" : ""}</dd></div><div><dt>范围</dt><dd>{MEMORY_SCOPE_LABEL[selected.scope]}</dd></div><div><dt>作者</dt><dd>{MEMORY_AUTHOR_LABEL[selected.authorType]} · {MEMORY_EPISTEMIC_LABEL[selected.epistemicStatus]}</dd></div>{selected.appliesWhen ? <div><dt>适用条件</dt><dd>{selected.appliesWhen}</dd></div> : null}<div><dt>有效期</dt><dd>{formatMemoryTime(selected.validFrom ?? selected.createdAt)} 至 {selected.validUntil ? formatMemoryTime(selected.validUntil) : "无截止时间"}</dd></div><div><dt>更新</dt><dd>{formatRelative(selected.updatedAt)} · 第 {selected.revision} 版</dd></div></dl>
        <div className="cc-actions">
          {selected.candidate ? <button type="button" className="cc-button is-primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>确认写入</button> : null}
          {!selected.candidate && !selected.archived ? <button type="button" className="cc-button" disabled={props.busy !== null} onClick={() => props.onAction(selected.pinned ? "unpin" : "pin")}><Pin size={14} />{selected.pinned ? "取消固定" : "固定"}</button> : null}
          {!props.correctionOpen && !selected.archived ? <button type="button" className="cc-button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={14} />纠正</button> : null}
          {!selected.candidate ? <button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onAction(selected.archived ? "restore" : "archive")}><Archive size={14} />{selected.archived ? "恢复" : "归档"}</button> : <button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button>}
        </div>
        {props.revisionsError ? <SectionState message="旧版本暂不可用" detail={props.revisionsError} onRetry={props.onRetryRevisions} /> : props.revisions === null ? <small role="status">正在读取旧版本…</small> : props.revisions.length ? <details className="cc-details"><summary>查看旧版本（{props.revisions.length}）</summary>{props.revisions.map(revision => <div key={revision.revision}><small>第 {revision.revision} 版 · {MEMORY_AUTHOR_LABEL[revision.authorType]} · {MEMORY_EPISTEMIC_LABEL[revision.epistemicStatus]} · 来源：{MEMORY_SOURCE_LABEL[revision.sourceType]}</small><p>{revision.content}</p><small>被替代于 {formatRelative(revision.supersededAt)}</small></div>)}</details> : null}
        <details className="cc-details cc-memory-remove"><summary>移除这条记忆</summary><p>普通删除进入回收区；彻底清除无法恢复。</p><div className="cc-actions"><MemoryDeleteAction active={props.confirmDelete} busy={props.busy !== null} onOpen={() => props.onConfirmDelete(true)} onCancel={() => props.onConfirmDelete(false)} onConfirm={() => props.onAction("remove")} /><MemoryEraseAction active={props.confirmErase} busy={props.busy !== null} onOpen={() => props.onConfirmErase(true)} onCancel={() => props.onConfirmErase(false)} onConfirm={() => props.onAction("erase")} /></div></details>
      </article> : <SectionState message="选择一条记忆" detail="查看它的内容、来源与版本。" />}</aside> : null}
    </div>
  </div>;
}

function MemoryEraseAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (props.active) cancelRef.current?.focus(); }, [props.active]);
  const escape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape" || !props.active || props.busy) return;
    event.preventDefault(); event.stopPropagation(); props.onCancel(); cancelRef.current?.focus();
  };
  return <><button ref={cancelRef} type="button" className="cc-link is-danger" disabled={props.busy} aria-expanded={props.active} onKeyDown={escape} onClick={props.active ? props.onCancel : props.onOpen}>{props.active ? "取消彻底清除" : "彻底清除"}</button>{props.active ? <><p role="alert">这条记忆及其版本会永久清除，不进入回收区，无法恢复。</p><button type="button" className="cc-button is-danger" disabled={props.busy} onKeyDown={escape} onClick={props.onConfirm}>确认彻底清除</button></> : null}</>;
}
function MemoryDeleteAction(props: { active: boolean; busy: boolean; onOpen: () => void; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (props.active) confirmRef.current?.focus(); }, [props.active]);
  return <><button type="button" className="cc-link is-danger" disabled={props.busy} aria-expanded={props.active} onClick={props.active ? props.onCancel : props.onOpen}><Trash2 size={14} />{props.active ? "取消删除" : "删除"}</button>{props.active ? <button ref={confirmRef} type="button" className="cc-button is-danger" disabled={props.busy} onClick={props.onConfirm}>确认删除</button> : null}</>;
}
