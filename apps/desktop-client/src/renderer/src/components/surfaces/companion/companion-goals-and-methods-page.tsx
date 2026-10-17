import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import type { AgentLongGoalV1 } from "@astella/shared/agent-long-goal-contracts";
import { companionMemoryContentMaxLength } from "@astella/shared/companion-memory-desktop-contracts";
import type { CreateAgentRunV1 } from "@astella/shared/agent-contracts";
import type { RequestMetaV1 } from "@astella/shared/desktop-ipc-contracts";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { ensureAiActionAllowed, guideAiPermissionFailure } from "../../../app/gate/ai-action-gate";
import { goalStatusText } from "../../companion/goals/agent-goal-presentation";
import { openCompanionGoalJournal } from "../../companion/content/companion-events";
import { plainCompanionBubbleText, renderCompanionMarkdown } from "../../companion/content/companion-markdown";
import { HUD_PAGES } from "../../hud/hud-pages";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { CenterFeedback, CenterSearch, SectionState } from "./companion-center-primitives";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

const stateLabels: Record<AgentMethodV1["availability"], string> = {
  available: "已采用", pending: "暂定做法", disabled: "暂时停用", source_changed: "依据需核对",
  capability_changed: "做法需复验", previous_version: "以前的版本",
};
type Draft = { methodId: string; revision: number; title: string; appliesWhen: string; steps: string; exceptions: string; reason: string };
type Selection = { kind: "goal"; id: string } | { kind: "method"; id: string };
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
/** 反思提炼出来的做法，依据就是那段相处里的某几句话（`eventId` 形如 `message:<uuid>`）。 */
const evidenceEventLabel = (eventId?: string | null) => eventId?.startsWith("message:") ? "那段相处里的原话" : "已记录的事件";

type GoalGroup = "all" | "长期目标" | "我们的方法";
const GROUP_OPTIONS: ReadonlyArray<CompanionSelectOption<GoalGroup>> = [
  { value: "all", label: "两类都看" },
  { value: "长期目标", label: "只看长期目标" },
  { value: "我们的方法", label: "只看我们的方法" },
];

/**
 * 长期目标与我们的方法合到一档：目标是「要去哪」，方法是「怎么做」，
 * 都是她长期带着走、每次合作会查阅的东西，各自却不再与「关于你的」重复成一个 tab。
 */
export function CompanionGoalsAndMethodsPage({ refreshKey, requestedMethodId, onFocusConsumed, onMemory }: {
  refreshKey: number; requestedMethodId?: string | null; onFocusConsumed?: () => void; onMemory: (id: string) => void;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const goals = useCompanionResource(meta => window.astella.agent.listLongGoals({ meta, query: { query, cursor } }), [refreshKey, query, cursor]);
  const methods = useCompanionResource(meta => window.astella.agent.listMethods({ meta }), [refreshKey, scope]);
  const reloadAll = async () => { await Promise.all([goals.reload(), methods.reload()]); };
  useCompanionRecordsRefresh(reloadAll);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [group, setGroup] = useState<GoalGroup>("all");
  const [creating, setCreating] = useState(false), [content, setContent] = useState(""), [condition, setCondition] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const writing = useRef(false), generation = useRef(0);
  /** 未提交的这次要求跟着目标留着：切走再回来不该把人刚打的字丢掉。必须是 state，用 ref 存就不会重渲染，提交按钮会一直停在禁用。 */
  const [goalDrafts, setGoalDrafts] = useState<Record<string, { task: string; noteId: string; noteCursor?: string }>>({});
  const saveDraft = (id: string, next: { task: string; noteId: string; noteCursor?: string }) => setGoalDrafts(current => ({ ...current, [id]: next }));
  const detailRef = useRef<HTMLElement>(null), indexRef = useRef<HTMLDivElement>(null);
  const readingIntent = useRef(false), returnFocus = useRef<string | null>(null);
  const goalItems = goals.section?.ok ? goals.section.value.items : [];
  const methodItems = methods.section?.ok ? methods.section.value.items : [];
  const keyword = query.trim().toLowerCase();
  const visibleGoals = group === "all" || group === "长期目标" ? goalItems.filter(item => `${item.content} ${item.appliesWhen ?? ""}`.toLowerCase().includes(keyword)) : [];
  const visibleMethods = group === "all" || group === "我们的方法" ? methodItems.filter(method => `${method.title} ${method.appliesWhen}`.toLowerCase().includes(keyword)) : [];
  const selectedGoal = selected?.kind === "goal" ? visibleGoals.find(item => item.ref.memoryId === selected.id) ?? null : null;
  const selectedMethod = selected?.kind === "method" ? visibleMethods.find(method => method.methodId === selected.id) ?? null : null;
  const meta = () => goals.meta();
  useEffect(() => {
    generation.current++; writing.current = false; setBusy(false); setSelected(null);
    setGoalDrafts({});
    setQuery(""); setGroup("all"); setCursor(undefined); setError(null); setNotice(null);
    setCreating(false); setContent(""); setCondition("");
  }, [scope]);
  useEffect(() => { if (requestedMethodId) { setSelected({ kind: "method", id: requestedMethodId }); setQuery(""); } }, [requestedMethodId]);
  useEffect(() => {
    if (!requestedMethodId || !methods.section?.ok || methods.loading) return;
    if (!methodItems.some(method => method.methodId === requestedMethodId)) setNotice("这条方法现在不在清单里，请核对空间与来源。");
    onFocusConsumed?.();
  }, [requestedMethodId, methods.section, methods.loading, onFocusConsumed]);
  useLayoutEffect(() => {
    if (readingIntent.current && selected && detailRef.current) {
      if (indexRef.current && getComputedStyle(indexRef.current).display === "none") detailRef.current.scrollIntoView?.({ block: "start", behavior: "instant" });
      detailRef.current.focus({ preventScroll: true }); readingIntent.current = false;
    }
    if (!selected && returnFocus.current) {
      indexRef.current?.querySelector<HTMLButtonElement>(`button[data-row-id="${returnFocus.current}"]`)?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [selected, goals.section, methods.section]);
  const pick = (row: Selection) => { readingIntent.current = true; setSelected(row); setError(null); setNotice(null); };
  const returnToIndex = () => { returnFocus.current = selected ? `${selected.kind}:${selected.id}` : null; setSelected(null); };
  const write = async (action: () => Promise<unknown>, message: string): Promise<boolean> => {
    if (writing.current) return false;
    const epoch = generation.current;
    writing.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (epoch !== generation.current || useRoomStore.getState().workspaceScopeRevision !== scope) return false;
      setNotice(message); publishCompanionRecordsChanged();
      await reloadAll();
      return true;
    } catch (failure) {
      if (epoch === generation.current && guideAiPermissionFailure(failure)) return false;
      if (epoch === generation.current) { setError(gatewayErrorMessage(failure)); await reloadAll(); }
      return false;
    } finally { if (epoch === generation.current) { writing.current = false; setBusy(false); } }
  };
  const create = () => void write(async () => { unwrapGatewayResult(await window.astella.companion.memory.create({ meta: meta(),
    request: { kind: "goal", scope: "workspace", content: content.trim(), appliesWhen: condition.trim() || null } })); },
  "目标已留下；每次想推进时，再交代这次要做的事。").then(ok => { if (ok) { setCreating(false); setContent(""); setCondition(""); } });
  const readable = useMemo<PageReadableV1>(() => ({ pageId: "companion", title: HUD_PAGES.companion.title,
    statusLine: error ?? notice ?? (!goals.section || !methods.section ? "正在加载目标与方法…" : undefined),
    filters: [{ label: "类型", value: GROUP_OPTIONS.find(option => option.value === group)?.label ?? "两类都看" }, ...(keyword ? [{ label: "关键词", value: query.trim().slice(0, 40) }] : [])],
    items: [...visibleGoals.map(item => ({ label: item.content.slice(0, 120), state: `长期目标· 第 ${item.ref.revision} 版` })),
      ...visibleMethods.map(method => ({ label: method.title.slice(0, 120), state: `我们的方法· ${stateLabels[method.availability]}` }))].slice(0, 12)
      .map((row, index) => ({ ordinal: index + 1, ...row })),
  }), [error, notice, goals.section, methods.section, keyword, query, group, visibleGoals, visibleMethods]);
  usePageReadableView(readable);
  if (!goals.section || !methods.section) return <SectionState loading message={goals.failure ?? methods.failure ? "目标与方法暂时读不到" : "正在加载目标与方法…"}
    detail={(goals.failure ?? methods.failure) ?? undefined}
    onRetry={goals.failure ?? methods.failure ? () => { void reloadAll(); } : undefined} />;
  if (!goals.section.ok) return <SectionState message="长期目标暂时读不到" detail={goals.section.message} onRetry={() => void goals.reload()} />;
  if (!methods.section.ok) return <SectionState message="方法暂时读不到" detail={methods.section.message} onRetry={() => void methods.reload()} />;
  const rows = visibleGoals.length + visibleMethods.length;
  return <section className="cc-methods" aria-label="目标与方法">
    <p className="cc-rule-intro">目标决定往哪儿推进，方法决定怎么做；两条都长期带着走。</p>
    <CenterFeedback error={error} notice={notice} />
    <div className="cc-page-tools"><CenterSearch value={query} onChange={value => { if (!busy) { setQuery(value); setCursor(undefined); } }} placeholder="找一条目标或一种做法…" label="筛选目标与方法" /><button type="button" className="cc-button" disabled={busy} onClick={() => setCreating(value => !value)}>{creating ? "收起" : "留下一个目标"}</button></div>
    <div className="cc-filter-line" role="group" aria-label="目标与方法筛选"><CompanionSelect paper ariaLabel="筛选目标与方法的类型" value={group} options={GROUP_OPTIONS} onChange={setGroup} /><span>{visibleGoals.length + visibleMethods.length} 条</span></div>
    {creating ? <form className="cc-form cc-long-goal-create" onSubmit={event => { event.preventDefault(); create(); }}>
      <label>想慢慢达到什么<textarea autoFocus value={content} maxLength={companionMemoryContentMaxLength} disabled={busy} onChange={event => setContent(event.currentTarget.value)} placeholder="比如：从基础开始学会分析电路" /></label>
      <label>适用的情境（可选）<input value={condition} maxLength={200} disabled={busy} onChange={event => setCondition(event.currentTarget.value)} placeholder="比如：这段时间学习物理时" /></label>
      <div className="cc-actions"><button type="button" className="cc-link" disabled={busy} onClick={() => setCreating(false)}>取消添加</button><button type="submit" className="cc-button is-primary" disabled={busy || !content.trim()}>{busy ? "正在保存目标…" : "确认留下"}</button></div>
    </form> : null}
    <div className={`cc-methods-workspace${selected ? " has-selection" : ""}`}>
      <div ref={indexRef} className="cc-methods-index" aria-label="目标与方法清单">
        {rows ? <>
          {visibleGoals.length ? <section aria-label="长期目标"><h3>一起慢慢做到的事</h3>{visibleGoals.map(item => <button type="button" key={`goal:${item.ref.memoryId}`}
            data-row-id={`goal:${item.ref.memoryId}`} data-goal-id={item.ref.memoryId} aria-pressed={selected?.kind === "goal" && selected.id === item.ref.memoryId} disabled={busy}
            onClick={() => pick({ kind: "goal", id: item.ref.memoryId })}>
            <small>已确认 · 第 {item.ref.revision} 版</small><strong>{plainCompanionBubbleText(item.content)}</strong>{item.appliesWhen ? <span>{item.appliesWhen}</span> : null}
          </button>)}</section> : null}
          {visibleMethods.length ? <section aria-label="我们的方法"><h3>我们的方法<small>她自主整理和修订的做法，适用时采用。</small></h3>{visibleMethods.map(method => <button type="button" key={`method:${method.methodId}`}
            data-row-id={`method:${method.methodId}`} data-method-id={method.methodId} aria-pressed={selected?.kind === "method" && selected.id === method.methodId} disabled={busy}
            onClick={() => pick({ kind: "method", id: method.methodId })}>
            <small>{stateLabels[method.availability]} · 第 {method.revision} 版</small><strong>{method.title}</strong><span>{method.appliesWhen}</span>
          </button>)}</section> : null}
          {goals.section.value.nextCursor ? <button type="button" className="cc-link" disabled={busy || goals.loading} onClick={() => { setSelected(null); setCursor(goals.section?.ok ? goals.section.value.nextCursor ?? undefined : undefined); }}>更早的目标</button> : null}
          {cursor ? <button type="button" className="cc-link" disabled={busy || goals.loading} onClick={() => { setSelected(null); setCursor(undefined); }}>回到近期目标</button> : null}
        </> : <SectionState message={query ? "还没找到这一条" : "还没有留下目标或方法"}
          detail={query ? "试试其他关键词。" : "留下一个目标，或者在任务做好后于我们的对话手记里把这次合作留成方法；她也会自主从相处中整理。"} />}
      </div>
      {selectedGoal ? <LongGoalDetail key={selectedGoal.ref.memoryId} goal={selectedGoal} busy={busy} meta={meta} onBusyWrite={write} onBack={returnToIndex}
        draft={goalDrafts[selectedGoal.ref.memoryId] ?? { task: "", noteId: "" }}
        onDraft={next => saveDraft(selectedGoal.ref.memoryId, next)}
        onMemory={() => onMemory(selectedGoal.ref.memoryId)} detailRef={detailRef} /> : null}
      {selectedMethod ? <MethodDetail key={selectedMethod.methodId} method={selectedMethod} busy={busy} meta={meta}
        onWrite={write} onBack={returnToIndex} detailRef={detailRef} /> : null}
    </div>
  </section>;
}

function LongGoalDetail({ goal, busy, meta, onBusyWrite, onBack, onMemory, detailRef, draft, onDraft }: {
  goal: AgentLongGoalV1; busy: boolean; meta: () => RequestMetaV1;
  onBusyWrite: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onBack: () => void; onMemory: () => void;
  detailRef: React.RefObject<HTMLElement | null>;
  draft: { task: string; noteId: string; noteCursor?: string }; onDraft: (next: { task: string; noteId: string; noteCursor?: string }) => void;
}) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const { task, noteId, noteCursor } = draft;
  const setTask = (value: string) => onDraft({ ...draft, task: value });
  const setNoteId = (value: string) => onDraft({ ...draft, noteId: value });
  const setNoteCursor = (value: string | undefined) => onDraft({ ...draft, noteCursor: value });
  const [browsing, setBrowsing] = useState(false), [taskCursor, setTaskCursor] = useState<string | undefined>();
  const notes = useCompanionResource(m => window.astella.note.list({ meta: m, limit: 20, cursor: noteCursor }), [noteCursor]);
  const related = useCompanionResource(m => window.astella.agent.listRuns({ meta: m, query: { longGoalMemoryId: goal.ref.memoryId, cursor: taskCursor } }), [taskCursor], browsing);
  const submission = useRef<{ key: string; request: CreateAgentRunV1 } | null>(null);
  const current = () => useRoomStore.getState().workspaceScopeRevision === scope;
  const start = () => {
    if (!task.trim()) return;
    const ref = goal.ref, goalText = task.trim();
    const key = JSON.stringify([scope, ref, goalText, noteId]);
    void onBusyWrite(async () => {
      if (!await ensureAiActionAllowed(meta().workspaceEpoch, current)) return;
      if (submission.current?.key !== key) {
        const inputs: CreateAgentRunV1["inputs"] = [];
        if (noteId) {
          const note = unwrapGatewayResult(await window.astella.note.get({ meta: meta(), noteId }));
          if (!current()) return;
          inputs.push({ kind: "note_version", noteId: note.noteId, noteVersionId: note.currentVersionId });
        }
        submission.current = { key, request: { requestId: crypto.randomUUID(), goal: goalText, inputs, longGoal: ref } };
      }
      const run = unwrapGatewayResult(await window.astella.agent.createRun({ meta: meta(), request: submission.current.request }));
      if (!current()) return;
      submission.current = null; setTask("");
      openCompanionGoalJournal(run.runId, scope);
    }, "这次的事已交给伴星，进展与成果会留在我们的对话手记里。");
  };
  return <article ref={detailRef} tabIndex={-1} className="cc-long-goal-detail" aria-label="长期目标详情">
    <button type="button" className="cc-link cc-reading-back" disabled={busy} onClick={onBack}>← 返回清单</button>
    <header><span className="cc-kicker">你的长期目标</span><button type="button" className="cc-link" disabled={busy} onClick={onMemory}>修订或撤回</button></header>
    <div className="cc-long-goal-statement" role="heading" aria-level={3}>{renderCompanionMarkdown(goal.content)}</div>
    {goal.appliesWhen ? <p className="cc-muted">适用情境：{goal.appliesWhen}</p> : null}
    <form className="cc-form" onSubmit={event => { event.preventDefault(); start(); }}>
      <label>这次想做什么<textarea value={task} maxLength={8000} disabled={busy} onChange={event => setTask(event.currentTarget.value)} placeholder="说清楚这次想得到什么，伴星会按真实结果推进。" /></label>
      <label>带上笔记（可选）<CompanionSelect ariaLabel="带上笔记（可选）" paper value={noteId} disabled={busy || notes.loading}
        options={[{ value: "", label: "这次不带笔记" }, ...(notes.section?.ok ? notes.section.value.items.map(note => ({ value: note.id, label: note.title || "未命名笔记" })) : [])]}
        onChange={setNoteId} /></label>
      {notes.section?.ok && notes.section.value.nextCursor ? <button type="button" className="cc-link" disabled={busy || notes.loading} onClick={() => { setNoteId(""); setNoteCursor(notes.section?.ok ? notes.section.value.nextCursor ?? undefined : undefined); }}>更早的笔记</button> : noteCursor ? <button type="button" className="cc-link" disabled={busy} onClick={() => { setNoteId(""); setNoteCursor(undefined); }}>回到近期笔记</button> : null}
      {notes.section && !notes.section.ok ? <SectionState message="笔记暂时读不到" detail={notes.section.message} onRetry={() => void notes.reload()} /> : null}
      <button type="submit" className="cc-button is-primary" disabled={busy || !task.trim()}>{busy ? "正在提交任务…" : "这次交给伴星"}</button>
    </form>
    <details className="cc-details"><summary>沿这个目标做过的事 · {goal.taskCount}</summary>
      <p className="cc-muted">每次任务保留当时的要求与成果，你可以在手记里查看、调整和接续。</p>
      {(browsing && related.section?.ok ? related.section.value.items.map(item => ({ ...item, goalRevision: item.longGoal?.revision ?? goal.ref.revision })) : goal.tasks).map(item => <button type="button" className="cc-long-goal-task" key={item.runId} onClick={() => openCompanionGoalJournal(item.runId, scope)}>
        <small>{goalStatusText[item.status]} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}{item.goalRevision !== goal.ref.revision ? ` · 依据目标第 ${item.goalRevision} 版` : ""}</small><strong>{item.goal}</strong><span>到我们的对话手记查看 →</span>
      </button>)}
      {!goal.taskCount ? <p>还没有关联的任务，准备好时交代第一件事。</p> : null}
      {!browsing && goal.taskCount > goal.tasks.length ? <button type="button" className="cc-link" onClick={() => setBrowsing(true)}>翻看全部关联任务</button> : null}
      {browsing && related.section?.ok && related.section.value.nextCursor ? <button type="button" className="cc-link" disabled={related.loading} onClick={() => setTaskCursor(related.section?.ok ? related.section.value.nextCursor ?? undefined : undefined)}>更早的关联任务</button> : null}
      {browsing && taskCursor ? <button type="button" className="cc-link" disabled={related.loading} onClick={() => setTaskCursor(undefined)}>回到最近的任务</button> : null}
      {browsing && (related.failure || (related.section && !related.section.ok)) ? <SectionState message="关联任务暂时读不到" onRetry={() => void related.reload()} /> : null}
    </details>
  </article>;
}

function MethodDetail({ method, busy, meta, onWrite, onBack, detailRef }: {
  method: AgentMethodV1; busy: boolean; meta: () => RequestMetaV1;
  onWrite: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onBack: () => void;
  detailRef: React.RefObject<HTMLElement | null>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const uses = useCompanionResource(m => window.astella.agent.getMethodUses({ meta: m, methodId: method.methodId }), [method.revision]);
  const history = useCompanionResource(m => window.astella.agent.getMethodHistory({ meta: m, methodId: method.methodId }), [method.revision]);
  const editing = draft?.methodId === method.methodId ? draft : null;
  const save = () => {
    if (!editing) return;
    // 草稿只在服务端确认真收下之后才丢；撞版本时要留着人刚打的字。
    void onWrite(async () => unwrapGatewayResult(await window.astella.agent.reviseMethod({ meta: meta(), methodId: editing.methodId,
      request: { expectedRevision: editing.revision, title: editing.title, appliesWhen: editing.appliesWhen, steps: lines(editing.steps), exceptions: lines(editing.exceptions), reason: editing.reason } })),
    "修订已保存，旧版本和来源保留。").then(ok => { if (ok) setDraft(null); });
  };
  const control = (action: "confirm" | "disable" | "restore") => void onWrite(async () => unwrapGatewayResult(await window.astella.agent.controlMethod({ meta: meta(), methodId: method.methodId,
    request: { expectedRevision: method.revision, action } })), action === "disable" ? "已停用，后续合作不会再采用这条方法。" : "已恢复采用；仍以你当下的要求和新材料为准。");
  return <article ref={detailRef} tabIndex={-1} className="cc-method-detail" aria-label="方法详情">
    <button type="button" className="cc-link cc-reading-back" disabled={busy} onClick={onBack}>← 返回清单</button>
    <header><span className="cc-kicker">这个书房的合作方法</span><span className="cc-badge">{stateLabels[method.availability]}{method.epistemicStatus === "tentative" ? " · 仍在尝试" : ""}</span></header>
    {editing ? <form className="cc-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <label>方法名称<input value={editing.title} maxLength={120} disabled={busy} onChange={event => setDraft({ ...editing, title: event.currentTarget.value })} /></label>
      <label>什么时候适用<textarea value={editing.appliesWhen} maxLength={200} disabled={busy} onChange={event => setDraft({ ...editing, appliesWhen: event.currentTarget.value })} /></label>
      <label>怎么合作（每行一步）<textarea value={editing.steps} maxLength={8000} disabled={busy} onChange={event => setDraft({ ...editing, steps: event.currentTarget.value })} /></label>
      <label>例外与边界（每行一条）<textarea value={editing.exceptions} maxLength={4000} disabled={busy} onChange={event => setDraft({ ...editing, exceptions: event.currentTarget.value })} /></label>
      <label>为什么修订<textarea value={editing.reason} maxLength={500} disabled={busy} onChange={event => setDraft({ ...editing, reason: event.currentTarget.value })} /></label>
      {method.revision !== editing.revision ? <p role="status">方法已经有新版本；你的草稿保留着，保存时会核对版本。</p> : null}
      <div className="cc-actions"><button className="cc-link" type="button" disabled={busy} onClick={() => setDraft(null)}>取消修订</button><button className="cc-button is-primary" type="submit" disabled={busy || !editing.title.trim() || !editing.appliesWhen.trim() || !lines(editing.steps).length || !editing.reason.trim()}>{busy ? "正在保存…" : "保存修订"}</button></div>
    </form> : <>
      <h3>{method.title}</h3><p className="cc-method-condition">适用于：{method.appliesWhen}</p>
      <ol className="cc-method-steps">{method.steps.map((step, index) => <li key={index}>{renderCompanionMarkdown(step)}</li>)}</ol>
      {method.exceptions.length ? <details className="cc-details"><summary>例外与边界</summary><ul>{method.exceptions.map((exception, index) => <li key={index}>{renderCompanionMarkdown(exception)}</li>)}</ul></details> : null}
      <p className="cc-method-reason">{method.changeReason ?? "当前要求优先；方法不会自动启动任务。"}</p>
      <div className="cc-actions">
        {method.state === "disabled" ? <button className="cc-button" type="button" disabled={busy} onClick={() => control("restore")}>恢复采用</button> : <button className="cc-link" type="button" disabled={busy} onClick={() => control("disable")}>暂时不用</button>}
        <button className="cc-button" type="button" disabled={busy} onClick={() => setDraft({ methodId: method.methodId, revision: method.revision, title: method.title, appliesWhen: method.appliesWhen, steps: method.steps.join("\n"), exceptions: method.exceptions.join("\n"), reason: "" })}>修订做法</button>
      </div>
    </>}
    <details className="cc-details"><summary>来源与旧版本</summary>
      <p>依据 {method.evidence.length} 条真实来源整理。第 {method.revision} 版，更新于 {new Date(method.updatedAt).toLocaleDateString("zh-CN")}。</p>
      <ul>{method.evidence.map((ref, index) => <li key={index}>{ref.memoryId ? `已保存记忆 · 第 ${ref.memoryRevision ?? "待核对"} 版` : ref.runId ? `已经完成的合作 · 第 ${ref.runRevision ?? "待核对"} 次要求` : evidenceEventLabel(ref.eventId)}{ref.note ? `：${ref.note}` : ""}</li>)}</ul>
      {history.loading ? <p>正在加载旧版本…</p> : history.section?.ok ? history.section.value.items.map(item => <details key={item.revision}><summary>第 {item.revision} 版 · {item.title}</summary><p>{item.appliesWhen}</p><ol>{item.steps.map((step, index) => <li key={index}>{renderCompanionMarkdown(step)}</li>)}</ol><p>{item.changeReason}</p></details>) : <SectionState message="旧版本暂时读不到" onRetry={() => void history.reload()} />}
    </details>
    <details className="cc-details"><summary>后续合作与反馈 · 本版查阅 {method.consultedCount} 次</summary>
      <p>查阅表示伴星读取过这条方法；好不好用，由真实合作和你的反馈核对。</p>
      {uses.loading ? <p>正在加载使用记录…</p> : uses.section?.ok ? uses.section.value.items.length ? uses.section.value.items.map(use => <div className="cc-method-use" key={use.useId}>
        <span>{use.contextKind === "agent_goal" ? "任务中查阅" : "对话中查阅"} · 第 {use.methodRevision} 版 · {new Date(use.createdAt).toLocaleDateString("zh-CN")}</span>
        <div className="cc-actions">{(["helpful", "unhelpful"] as const).map(feedback => <button type="button" className="cc-link" key={feedback} disabled={busy} aria-pressed={use.feedback === feedback}
          onClick={() => void onWrite(async () => unwrapGatewayResult(await window.astella.agent.feedbackMethod({ meta: meta(), useId: use.useId, request: { feedback } })), "这次合作的反馈已留下。")}>{feedback === "helpful" ? "这次有帮助" : "这次不合适"}</button>)}</div>
      </div>) : <p>还没有后续使用记录。</p> : uses.section && !uses.section.ok ? <SectionState message="使用记录暂时读不到" onRetry={() => void uses.reload()} /> : null}
    </details>
  </article>;
}
