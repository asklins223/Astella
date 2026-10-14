import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type { CompanionMemoryBudgetStatusV1,CompanionMemoryBudgetTierV1,CompanionMemoryItemV1,CompanionMemoryKindV1,CompanionMemoryRevisionV1 } from "@astella/shared/companion-memory-desktop-contracts";
import { Archive,Pencil,Pin,Plus,Trash2 } from "lucide-react";
import { useEffect,useMemo,useRef,type KeyboardEvent } from "react";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { formatRelative } from "../notebook/surface-data";
import type { Section } from "./companion-center-model";
import { MEMORY_KIND_LABEL,MEMORY_KIND_OPTIONS,MEMORY_SCOPE_LABEL,MEMORY_STATE_LABEL,memoryState } from "./companion-center-model";
import { CenterFeedback,CenterSearch,SectionState } from "./companion-center-primitives";
import { CompanionSelect,type CompanionSelectOption } from "./companion-select";
import { MemoryRuleFields,type MemoryRuleDraftFields } from "./companion-memory-rule-fields";

const MEMORY_CREATABLE_KIND_OPTIONS = MEMORY_KIND_OPTIONS.filter((option) => option.value !== "judgment");

/** 她的看法（`judgment`）住在「她的记事」那一档，这里只列关于用户的事实与规则。 */
const MEMORY_LIST_KIND_OPTIONS: ReadonlyArray<CompanionSelectOption<"all" | CompanionMemoryKindV1>> = [
  { value: "all", label: "全部类型" },
  ...MEMORY_KIND_OPTIONS.filter((option) => option.value !== "judgment"),
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

const COOPERATION_STATE_OPTIONS = MEMORY_PIN_OPTIONS
  .filter(option => option.value !== "active")
  .map(option => option.value === "archived" ? { ...option, label: "暂时不用" } : option);

function savedRuleState(item: CompanionMemoryItemV1): string {
  const state = memoryState(item);
  if (state === "archived") return "暂时不用";
  if (state === "active" || state === "pinned") return item.userConfirmed ? "已确认" : "尚未确认";
  return MEMORY_STATE_LABEL[state];
}

function formatMemoryTime(value: string | null): string {
  if (!value) return "来源时间";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

type MemoryPanelProps = {
  section: Section<{ version: 2; items: CompanionMemoryItemV1[] }>; items: CompanionMemoryItemV1[]; focus: CompanionMemoryItemV1 | null;
  revisions: CompanionMemoryRevisionV1[] | null; revisionsError: string | null; onRetryRevisions: () => void;
  budget: CompanionMemoryBudgetStatusV1 | null; onBudgetTier: (tier: CompanionMemoryBudgetTierV1) => void; onDispute: () => void;
  onOpenSource: (messageId: string) => void; onOpenMemory: (memoryId: string) => void;
  query: string; kind: "all" | CompanionMemoryKindV1; pinFilter: MemoryStateFilter; busy: string | null; error: string | null; notice: string | null;
  confirmDelete: boolean; confirmErase: boolean;
  createOpen: boolean; createContent: string; createKind: CompanionMemoryKindV1; correctionOpen: boolean; correctionContent: string;
  ruleEditor?: { create: MemoryRuleDraftFields; correction: MemoryRuleDraftFields };
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

const MEMORY_AUTHOR_LABEL = { user: "用户修订", extractor: "提取整理", companion: "她自己的判断", maintenance: "后台整理" } as const;

const MEMORY_EPISTEMIC_LABEL = { supported: "有据", tentative: "待核对", disputed: "有争议", superseded: "已被替代" } as const;

const MEMORY_SOURCE_LABEL = { user_stated: "用户自述", model_inferred: "模型推断", confirmed: "用户确认", summary: "摘要整理" } as const;

const MEMORY_SPEAKER_LABEL: Record<"user" | "assistant" | "companion", string> = {
  user: "用户原话",
  assistant: "伴星发言",
  companion: "她自己的理解（不是你说的话）",
};

export function MemoryPanel(props: MemoryPanelProps) {
  /** 「合作方式」不再是一档：它就是类型筛到「偏好」的那一份，用规则的口吻重讲一遍。 */
  const cooperation = props.kind === "preference";
  const stateOptions = cooperation ? COOPERATION_STATE_OPTIONS : MEMORY_PIN_OPTIONS;
  const stateLabel = (item: CompanionMemoryItemV1) => cooperation ? savedRuleState(item) : MEMORY_STATE_LABEL[memoryState(item)];
  /** 只看偏好时，列表行与详情用同一个词，别让一条记忆在两处各叫一个名字。 */
  const kindLabel = (item: CompanionMemoryItemV1) => cooperation ? "合作方式" : MEMORY_KIND_LABEL[item.kind];
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focus) return;
    const selected = panelRef.current?.querySelector<HTMLElement>('.cc-memory-list button[aria-pressed="true"]');
    selected?.scrollIntoView({ block: "nearest" });
    const detail = panelRef.current?.querySelector<HTMLElement>(".cc-memory-focus");
    if (detail) detail.scrollTop = 0;
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
    .filter((item) => item.kind !== "judgment" && (props.kind === "all" || item.kind === props.kind) && matchesMemoryStateFilter(item, props.pinFilter) && (!props.query.trim() || item.content.toLowerCase().includes(props.query.trim().toLowerCase())))
    .sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.updatedAt.localeCompare(a.updatedAt)),
  [props.items, props.kind, props.pinFilter, props.query]);
  const empty = cooperation && !props.query.trim() && props.pinFilter === "all" ? {
    message: "这里还没有合作方式",
    detail: "写下你希望她怎样讲解、回应或陪你学习，也可以确认从对话里整理出的偏好。",
  } : props.items.length ? MEMORY_LIST_EMPTY : MEMORY_NOT_STARTED;
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
    const rows = (props.createOpen ? [] : visible)
      // 正文为空的行屏幕上也是一个空 `<strong>`，没有话可登记——跳过它，
      // 而不是编一句"（空）"给她念。
      .filter((item) => item.content.trim().length > 0)
      .slice(0, 12)
      .map((item, index) => ({
        ordinal: index + 1,
        label: item.content.slice(0, 120),
        state: `${kindLabel(item)}· ${stateLabel(item)}`,
      }));
    const optionLabel = (options: ReadonlyArray<CompanionSelectOption<string>>, value: string) =>
      options.find((option) => option.value === value)?.label ?? value;
    return {
      pageId: "companion",
      title: HUD_PAGES.companion.title,
      statusLine: props.notice ?? props.error ?? (props.createOpen ? "正在添加记忆" : visible.length === 0 ? empty.message : undefined),
      filters: props.createOpen ? [{ label: "视图", value: cooperation ? "添加合作方式" : "添加记忆" }] : [
        { label: "类型", value: optionLabel(MEMORY_LIST_KIND_OPTIONS, props.kind).slice(0, 40) },
        { label: "状态", value: optionLabel(stateOptions, props.pinFilter).slice(0, 40) },
        ...(props.query.trim() ? [{ label: "关键词", value: props.query.trim().slice(0, 40) }] : []),
      ],
      ...(rows.length > 0 ? { items: rows } : {}),
      ...(!props.createOpen && visible.length === 0 ? { notice: `${empty.message}：${empty.detail}` } : {}),
    };
  }, [props.error, props.kind, props.notice, props.pinFilter, props.query, props.section, cooperation, props.createOpen, visible, empty]);
  usePageReadableView(memoryReadableView);
  useEffect(() => {
    if (visible.length && !visible.some(item => item.memoryItemId === props.focus?.memoryItemId)) props.onFocus(visible[0].memoryItemId);
  }, [visible, props.focus?.memoryItemId, props.onFocus]);
  if (!props.section.ok) return <SectionState message={MEMORY_LIST_UNAVAILABLE} detail={props.section.message} onRetry={props.onRetry} />;
  const selected = visible.find(item => item.memoryItemId === props.focus?.memoryItemId) ?? null;
  const renderRow = (item: CompanionMemoryItemV1) => <button key={item.memoryItemId} type="button" aria-pressed={selected?.memoryItemId === item.memoryItemId} data-state={memoryState(item)} onClick={() => props.onFocus(item.memoryItemId)}>
    <span className="cc-memory-list__kind">{kindLabel(item)}<small>{stateLabel(item)}</small></span>
    <strong>{item.content}</strong><time>{formatRelative(item.updatedAt)} · {MEMORY_SCOPE_LABEL[item.scope]}</time>
  </button>;
  return <div ref={panelRef} className="cc-memory">
    {props.budget ? <details className="cc-memory-budget">
      <summary aria-label="展开记忆用量与检索统计">记忆用量与检索统计</summary>
      <div className="cc-memory-budget__details" aria-label="记忆分层预算">
        <strong>记忆在伴星上下文中的位置</strong>
        <span>常驻 {props.budget.resident.used.items} 条 · 约 {props.budget.resident.used.tokenEstimate}/{props.budget.resident.limits.tokenEstimate} tokens</span>
        <span>按需 {props.budget.active.items} 条 · 归档 {props.budget.archived.used.items}/{props.budget.archived.limits.items} 条</span>
        <span>近 30 天检索 {props.budget.usage.searchRequests} 次 · 命中 {props.budget.usage.returnedMemories} 条 · 空结果 {props.budget.usage.emptySearches} 次</span>
        <span>目录带入 {props.budget.usage.directoryExposures} 条 · 按需展开 {props.budget.usage.explicitReads} 条</span>
        <small>常驻内容会随对话带入；按需内容由伴星根据问题检索；归档内容不会自动召回。</small>
      </div>
    </details> : null}
    {cooperation && !props.createOpen ? <div className="cc-rule-intro"><h3>我们怎样合作</h3><p>她会在相处中调整合作习惯；你可以随时纠正，每次合作仍以你当下的要求为准。</p></div> : null}
    <div className="cc-toolbar">{props.createOpen ? <h3 className="cc-memory-create-title">{cooperation ? "添加合作方式" : "添加记忆"}</h3> : <CenterSearch value={props.query} onChange={props.onQuery} placeholder={cooperation ? "找一种合作习惯…" : "找一件她记住的事…"} label="筛选记忆列表" />}<button type="button" className="cc-button" onClick={() => props.onCreateOpen(!props.createOpen)}><Plus size={16} aria-hidden="true" />{props.createOpen ? "收起添加" : cooperation ? "添加合作方式" : "手动添加"}</button></div>
    {!props.createOpen ? <div className="cc-filter-line" role="group" aria-label="记忆列表筛选"><CompanionSelect paper ariaLabel="筛选记忆列表类型" value={props.kind} options={MEMORY_LIST_KIND_OPTIONS} onChange={props.onKind} /><CompanionSelect paper ariaLabel="筛选记忆列表状态" value={props.pinFilter} options={stateOptions} onChange={props.onPinFilter} /><span>{visible.length} 条</span><button type="button" className="cc-link" disabled={props.busy !== null} onClick={props.onSummarize}>{props.busy === "summarize" ? "整理中…" : "整理近期对话"}</button></div> : null}
    {props.createOpen ? <form className="cc-form cc-memory-create" data-cooperation={cooperation || undefined} onSubmit={event => { event.preventDefault(); props.onCreate(); }}>{!cooperation ? <label>记忆类型<CompanionSelect paper disabled={props.busy !== null} ariaLabel="新记忆类型" value={props.createKind} options={MEMORY_CREATABLE_KIND_OPTIONS} onChange={props.onCreateKind} /></label> : null}<label className="cc-memory-content">{cooperation ? "希望我们怎样合作" : "希望她记住的事"}<textarea disabled={props.busy !== null} value={props.createContent} maxLength={200} onChange={event => props.onCreateContent(event.currentTarget.value)} placeholder="写下希望伴星记住的偏好或事实" aria-label="新记忆内容" /></label>{props.ruleEditor ? <MemoryRuleFields fields={props.ruleEditor.create} /> : null}<div className="cc-actions"><small>{props.createContent.length} / 200</small><button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onCreateOpen(false)}>取消</button><button type="submit" className="cc-button is-primary" disabled={!props.createContent.trim() || props.busy !== null}>{props.busy === "create" ? "正在保存…" : cooperation ? "保存合作方式" : "保存记忆"}</button></div></form> : null}
    <CenterFeedback error={props.error} notice={props.notice} />
    {!props.createOpen ? <div className={visible.length ? "cc-memory-workspace" : "cc-memory-workspace is-empty"}>
      <div className="cc-memory-list" aria-label="记忆列表">{visible.length ? <>
        <section aria-label={cooperation ? "合作方式清单" : "关于你的"}><h3>{cooperation ? "已留下的合作方式" : "关于你的"}</h3>{visible.map(renderRow)}</section>
      </> : <SectionState message={empty.message} detail={empty.detail} onRetry={props.query || props.kind !== "all" || props.pinFilter !== "all" ? () => { props.onQuery(""); props.onKind("all"); props.onPinFilter("all"); } : undefined} />}</div>
      {visible.length ? <aside className="cc-memory-focus" aria-label="所选记忆详情">{selected ? <article className="cc-memory-detail">
        <header><span className="cc-kicker">{kindLabel(selected)}</span><span className="cc-badge">{stateLabel(selected)}</span></header>
        {props.correctionOpen ? <form className="cc-form" onSubmit={event => { event.preventDefault(); props.onCorrect(); }}><label>{cooperation ? "修订合作方式" : "纠正这条记忆"}<textarea disabled={props.busy !== null} value={props.correctionContent} maxLength={200} onChange={event => props.onCorrectionContent(event.currentTarget.value)} aria-label="纠正后的记忆内容" /></label>{props.ruleEditor ? <MemoryRuleFields fields={props.ruleEditor.correction} editing /> : null}<p className="cc-rule-form-note">这次修订仍适用于{MEMORY_SCOPE_LABEL[selected.scope]}。</p><div className="cc-actions"><button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(false)}>取消</button><button type="submit" className="cc-button is-primary" disabled={!props.correctionContent.trim() || (props.correctionContent.trim() === selected.content && (!props.ruleEditor || (props.ruleEditor.correction.appliesWhen.trim() || null) === selected.appliesWhen)) || props.busy !== null}>{props.busy === "correct" ? "正在保存…" : "保存修订"}</button></div></form> : <p className="cc-memory-detail__body">{selected.content}</p>}
        <MemoryFacts item={selected} mode={cooperation ? "rule" : "all"} onOpenSource={props.onOpenSource} onOpenMemory={props.onOpenMemory} />
        <div className="cc-actions">
          {selected.candidate ? <button type="button" className="cc-button is-primary" disabled={props.busy !== null} onClick={() => props.onAction("confirm")}>{cooperation ? "确认采用" : "确认写入"}</button> : null}
          {!selected.candidate && !selected.archived ? <button type="button" className="cc-button" disabled={props.busy !== null} onClick={() => props.onAction(selected.pinned ? "unpin" : "pin")}><Pin size={14} />{selected.pinned ? "取消固定" : "固定"}</button> : null}
          {!props.correctionOpen && !selected.archived ? <button type="button" className="cc-button" disabled={props.busy !== null} onClick={() => props.onCorrectionOpen(true)}><Pencil size={14} />{cooperation ? "修订" : "纠正"}</button> : null}
          {!selected.candidate && selected.epistemicStatus !== "disputed" && selected.epistemicStatus !== "superseded" ? <button type="button" className="cc-link" disabled={props.busy !== null} onClick={props.onDispute}>标记有争议</button> : null}
          {!selected.candidate ? <button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onAction(selected.archived ? "restore" : "archive")}><Archive size={14} />{cooperation ? selected.archived ? "恢复这条规则" : "暂时不用" : selected.archived ? "恢复" : "归档"}</button> : <button type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onAction("dismiss")}>暂不采用</button>}
        </div>
        {!selected.candidate ? <div className="cc-memory-tier" aria-label="记忆检索层级">
          <span>检索层级：{memoryTierLabel(selected.budgetTier)}</span>
          {(["resident", "active", "archived"] as const).filter(tier => tier !== selected.budgetTier).map(tier => <button key={tier} type="button" className="cc-link" disabled={props.busy !== null} onClick={() => props.onBudgetTier(tier)}>{tier === "resident" ? "移到常驻" : tier === "active" ? "改为按需" : "归档"}</button>)}
        </div> : null}
        {cooperation ? <details className="cc-details"><summary>来源与有效期</summary><MemoryFacts item={selected} mode="provenance" onOpenSource={props.onOpenSource} onOpenMemory={props.onOpenMemory} /></details> : null}
        {props.revisionsError ? <SectionState message="旧版本暂不可用" detail={props.revisionsError} onRetry={props.onRetryRevisions} /> : props.revisions === null ? <small role="status">正在加载旧版本…</small> : props.revisions.length ? <details className="cc-details"><summary>查看旧版本（{props.revisions.length}）</summary>{props.revisions.map(revision => <div key={revision.revision}><small>第 {revision.revision} 版 · {MEMORY_AUTHOR_LABEL[revision.authorType]} · {MEMORY_EPISTEMIC_LABEL[revision.epistemicStatus]} · 来源：{MEMORY_SOURCE_LABEL[revision.sourceType]}</small><p>{revision.content}</p><small>适用于{MEMORY_SCOPE_LABEL[revision.scope]} · {revision.appliesWhen ?? "无额外条件"}</small><small>被替代于 {formatRelative(revision.supersededAt)}</small></div>)}</details> : null}
        <details className="cc-details cc-memory-remove"><summary>移除这条记忆</summary><p>普通删除进入回收区；彻底清除无法恢复。</p><div className="cc-actions"><MemoryDeleteAction active={props.confirmDelete} busy={props.busy !== null} onOpen={() => props.onConfirmDelete(true)} onCancel={() => props.onConfirmDelete(false)} onConfirm={() => props.onAction("remove")} /><MemoryEraseAction active={props.confirmErase} busy={props.busy !== null} onOpen={() => props.onConfirmErase(true)} onCancel={() => props.onConfirmErase(false)} onConfirm={() => props.onAction("erase")} /></div></details>
      </article> : <SectionState message="选择一条记忆" detail="查看它的内容、来源与版本。" />}</aside> : null}
    </div> : null}
  </div>;
}

function memoryTierLabel(tier: CompanionMemoryBudgetTierV1): string {
  return tier === "resident" ? "常驻" : tier === "active" ? "按需检索" : "归档";
}

function MemoryFacts({ item, mode, onOpenSource, onOpenMemory }: { item: CompanionMemoryItemV1; mode: "all" | "rule" | "provenance"; onOpenSource: (messageId: string) => void; onOpenMemory: (memoryId: string) => void }) {
  const sourceIds = [...new Set([item.sourceEventId, ...item.sourceEventIds].filter((id): id is string => Boolean(id)))];
  const linkableSourceIds = sourceIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  return <dl className="cc-facts">
    {mode !== "rule" ? <div><dt>来源</dt><dd>{item.sourceSpeaker ? MEMORY_SPEAKER_LABEL[item.sourceSpeaker] : MEMORY_SOURCE_LABEL[item.sourceType]}{item.sourceBasis === "inferred_from_statement" ? "（根据原话整理）" : ""}{linkableSourceIds.length ? <span className="cc-memory-source-links">{linkableSourceIds.slice(0, 8).map((id, index) => <button type="button" className="cc-link" key={id} onClick={() => onOpenSource(id)}>{linkableSourceIds.length > 1 ? `核对原话 ${index + 1}` : "核对原话"}</button>)}</span> : sourceIds.length ? <small>已保留来源引用，但暂时无法定位到具体消息。</small> : <small>没有可回溯的原话来源。</small>}</dd></div> : null}
    {mode !== "provenance" ? <div><dt>范围</dt><dd>{MEMORY_SCOPE_LABEL[item.scope]}</dd></div> : null}
    {mode !== "rule" ? <div><dt>作者</dt><dd>{MEMORY_AUTHOR_LABEL[item.authorType]} · {MEMORY_EPISTEMIC_LABEL[item.epistemicStatus]}</dd></div> : null}
    {mode !== "provenance" && item.appliesWhen ? <div><dt>适用条件</dt><dd>{item.appliesWhen}</dd></div> : null}
    {mode !== "rule" ? <div><dt>有效期</dt><dd>{formatMemoryTime(item.validFrom ?? item.createdAt)} 至 {item.validUntil ? formatMemoryTime(item.validUntil) : "无截止时间"}</dd></div> : null}
    {mode !== "provenance" ? <div><dt>更新</dt><dd>{formatRelative(item.updatedAt)} · 第 {item.revision} 版</dd></div> : null}
    {mode !== "rule" ? <div><dt>置信度</dt><dd>{Math.round(item.confidence * 100)}%{item.userConfirmed ? ` · ${item.confirmedAt ? `用户于 ${formatMemoryTime(item.confirmedAt)} 确认` : "用户已确认"}` : " · 尚未由用户确认"}</dd></div> : null}
    {item.supersededById ? <div><dt>替代条目</dt><dd><button type="button" className="cc-link" onClick={() => onOpenMemory(item.supersededById!)}>打开替代它的记忆</button></dd></div> : null}
  </dl>;
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
