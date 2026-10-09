import { useEffect, useRef, useState } from "react";
import { companionMemoryContentMaxLength } from "@astella/shared/companion-memory-desktop-contracts";
import type { CreateAgentRunV1 } from "@astella/shared/agent-contracts";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { ensureAiActionAllowed, guideAiPermissionFailure } from "../../../app/ai-action-gate";
import { goalStatusText } from "../../companion/agent-goal-presentation";
import { openCompanionGoalJournal } from "../../companion/companion-events";
import { plainCompanionBubbleText, renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CenterFeedback, CenterSearch, SectionState } from "./companion-center-primitives";
import { CompanionSelect } from "./companion-select";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

export function CompanionLongGoalsPage({ refreshKey, onMemory }: { refreshKey: number; onMemory: (id: string) => void }) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const resource = useCompanionResource(meta => window.astella.agent.listLongGoals({ meta, query: { query, cursor } }), [refreshKey, query, cursor]);
  useCompanionRecordsRefresh(resource.reload);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false), [taskCursor, setTaskCursor] = useState<string | undefined>();
  const related = useCompanionResource(meta => window.astella.agent.listRuns({ meta, query: { longGoalMemoryId: selectedId!, cursor: taskCursor } }), [selectedId, taskCursor], Boolean(selectedId) && browsing);
  const [creating, setCreating] = useState(false), [content, setContent] = useState(""), [condition, setCondition] = useState("");
  const [task, setTask] = useState(""), [noteId, setNoteId] = useState("");
  const [noteCursor, setNoteCursor] = useState<string | undefined>();
  const notes = useCompanionResource(meta => window.astella.note.list({ meta, limit: 20, cursor: noteCursor }), [noteCursor], selectedId !== null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const writing = useRef(false), generation = useRef(0);
  const submission = useRef<{ key: string; request: CreateAgentRunV1 } | null>(null);
  useEffect(() => {
    generation.current++; writing.current = false; submission.current = null;
    setSelectedId(null); setQuery(""); setCreating(false); setContent(""); setCondition("");
    setCursor(undefined); setBrowsing(false); setTaskCursor(undefined);
    setTask(""); setNoteId(""); setNoteCursor(undefined); setBusy(false); setError(null); setNotice(null);
  }, [scope]);
  const items = resource.section?.ok ? resource.section.value.items : [];
  const selected = items.find(item => item.ref.memoryId === selectedId) ?? null;
  const current = () => useRoomStore.getState().workspaceScopeRevision === scope;
  const write = async (action: () => Promise<void>) => {
    if (writing.current || !current()) return;
    const epoch = generation.current;
    writing.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (epoch === generation.current && current()) { publishCompanionRecordsChanged(); await resource.reload({ silent: true }); }
    } catch (failure) {
      if (epoch === generation.current && current() && guideAiPermissionFailure(failure)) return;
      if (epoch === generation.current && current()) { setError(gatewayErrorMessage(failure)); await resource.reload({ silent: true }); }
    } finally {
      if (epoch === generation.current) { writing.current = false; setBusy(false); }
    }
  };
  const create = () => void write(async () => {
    const created = unwrapGatewayResult(await window.astella.companion.memory.create({ meta: resource.meta(),
      request: { kind: "goal", scope: "workspace", content: content.trim(), appliesWhen: condition.trim() || null } }));
    if (!current()) return;
    setSelectedId(created.memoryItemId); setCreating(false); setContent(""); setCondition("");
    setNotice("目标已留下；每次想推进时，再交代这次要做的事。");
  });
  const start = () => {
    if (!selected || !task.trim()) return;
    const ref = selected.ref, goal = task.trim();
    const key = JSON.stringify([scope, ref, goal, noteId]);
    void write(async () => {
      if (!await ensureAiActionAllowed(resource.meta().workspaceEpoch, current)) return;
      if (submission.current?.key !== key) {
        const inputs: CreateAgentRunV1["inputs"] = [];
        if (noteId) {
          const note = unwrapGatewayResult(await window.astella.note.get({ meta: resource.meta(), noteId }));
          if (!current()) return;
          inputs.push({ kind: "note_version", noteId: note.noteId, noteVersionId: note.currentVersionId });
        }
        submission.current = { key, request: { requestId: crypto.randomUUID(), goal, inputs, longGoal: ref } };
      }
      const run = unwrapGatewayResult(await window.astella.agent.createRun({ meta: resource.meta(), request: submission.current.request }));
      if (!current()) return;
      submission.current = null; setTask(""); setNotice("这次的事已交给伴星，进展与成果会留在我们的对话手记里。");
      openCompanionGoalJournal(run.runId, scope);
    });
  };
  if (!resource.section) return <SectionState loading={resource.loading} message={resource.failure ? "长期目标暂时读不到" : "正在加载长期目标…"} detail={resource.failure ?? undefined} onRetry={resource.failure ? () => void resource.reload() : undefined} />;
  if (!resource.section.ok) return <SectionState message="长期目标暂时读不到" detail={resource.section.message} onRetry={() => void resource.reload()} />;
  const visible = items.filter(item => `${item.content} ${item.appliesWhen ?? ""}`.includes(query.trim()));
  return <section className="cc-long-goals" aria-label="长期目标">
    <div className="cc-rule-intro"><h3>一起慢慢做到的事</h3><p>留下你想达到的目标，再一次次交代具体任务。</p></div>
    <CenterFeedback error={error} notice={notice} />
    <div className="cc-page-tools"><CenterSearch value={query} onChange={value => { if (!busy) { setQuery(value); setCursor(undefined); } }} placeholder="找一个长期目标…" label="筛选长期目标" /><button type="button" className="cc-button" disabled={busy} onClick={() => setCreating(value => !value)}>{creating ? "收起" : "留下一个目标"}</button></div>
    {creating ? <form className="cc-form cc-long-goal-create" onSubmit={event => { event.preventDefault(); create(); }}>
      <label>想慢慢达到什么<textarea value={content} maxLength={companionMemoryContentMaxLength} disabled={busy} onChange={event => setContent(event.currentTarget.value)} placeholder="比如：从基础开始学会分析电路" /></label>
      <label>适用的情境（可选）<input value={condition} maxLength={200} disabled={busy} onChange={event => setCondition(event.currentTarget.value)} placeholder="比如：这段时间学习物理时" /></label>
      <button type="submit" className="cc-button is-primary" disabled={busy || !content.trim()}>{busy ? "正在保存目标…" : "确认留下"}</button>
    </form> : null}
    <div className={`cc-long-goals-workspace${selected ? " has-selection" : ""}`}>
      <div className="cc-long-goals-index" aria-label="目标清单">
        {visible.length ? visible.map(item => <button type="button" key={item.ref.memoryId} aria-pressed={selectedId === item.ref.memoryId} disabled={busy || resource.loading} onClick={() => { setSelectedId(item.ref.memoryId); setTask(""); setNoteId(""); setNoteCursor(undefined); setBrowsing(false); setTaskCursor(undefined); setError(null); setNotice(null); }}>
          <small>已确认 · 第 {item.ref.revision} 版</small><strong>{plainCompanionBubbleText(item.content)}</strong>{item.appliesWhen ? <span>{item.appliesWhen}</span> : null}
        </button>) : <SectionState message={query ? "还没找到这个目标" : "给想做的事留一个位置"} detail={query ? "试试其他关键词。" : "目标会和具体任务关联，方便下次接着推进。"} />}
        {resource.section.value.nextCursor ? <button type="button" className="cc-link" disabled={busy || resource.loading} onClick={() => { setSelectedId(null); setCursor(resource.section?.ok ? resource.section.value.nextCursor ?? undefined : undefined); }}>更早的目标</button> : null}
        {cursor ? <button type="button" className="cc-link" disabled={busy || resource.loading} onClick={() => { setSelectedId(null); setCursor(undefined); }}>回到近期目标</button> : null}
      </div>
      {selected ? <article className="cc-long-goal-detail" aria-label="长期目标详情">
        <header><span className="cc-kicker">你的长期目标</span><button type="button" className="cc-link" disabled={busy} onClick={() => onMemory(selected.ref.memoryId)}>修订或撤回</button></header>
        <div className="cc-long-goal-statement" role="heading" aria-level={3}>{renderCompanionMarkdown(selected.content)}</div>
        {selected.appliesWhen ? <p className="cc-muted">适用情境：{selected.appliesWhen}</p> : null}
        <form className="cc-form" onSubmit={event => { event.preventDefault(); start(); }}>
          <label>这次想做什么<textarea value={task} maxLength={8000} disabled={busy} onChange={event => setTask(event.currentTarget.value)} placeholder="说清楚这次想得到什么，伴星会按真实结果推进。" /></label>
          <label>带上笔记（可选）<CompanionSelect ariaLabel="带上笔记（可选）" paper value={noteId} disabled={busy || notes.loading}
            options={[{value:"",label:"这次不带笔记"}, ...(notes.section?.ok ? notes.section.value.items.map(note => ({value:note.id,label:note.title || "未命名笔记"})) : [])]}
            onChange={setNoteId} /></label>
          {notes.section?.ok && notes.section.value.nextCursor ? <button type="button" className="cc-link" disabled={busy || notes.loading} onClick={() => { setNoteId(""); setNoteCursor(notes.section?.ok ? notes.section.value.nextCursor ?? undefined : undefined); }}>更早的笔记</button> : noteCursor ? <button type="button" className="cc-link" disabled={busy} onClick={() => { setNoteId(""); setNoteCursor(undefined); }}>回到近期笔记</button> : null}
          {notes.section && !notes.section.ok ? <SectionState message="笔记暂时读不到" detail={notes.section.message} onRetry={() => void notes.reload()} /> : null}
          <button type="submit" className="cc-button is-primary" disabled={busy || !task.trim()}>{busy ? "正在提交任务…" : "这次交给伴星"}</button>
        </form>
        <details className="cc-details"><summary>沿这个目标做过的事 · {selected.taskCount}</summary>
          <p className="cc-muted">每次任务保留当时的要求与成果，你可以在手记里查看、调整和接续。</p>
          {(browsing && related.section?.ok ? related.section.value.items.map(item => ({ ...item, goalRevision: item.longGoal?.revision ?? selected.ref.revision })) : selected.tasks).map(item => <button type="button" className="cc-long-goal-task" key={item.runId} onClick={() => openCompanionGoalJournal(item.runId, scope)}>
            <small>{goalStatusText[item.status]} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}{item.goalRevision !== selected.ref.revision ? ` · 依据目标第 ${item.goalRevision} 版` : ""}</small><strong>{item.goal}</strong><span>到我们的对话手记查看 →</span>
          </button>)}
          {!selected.taskCount ? <p>还没有关联的任务，准备好时交代第一件事。</p> : null}
          {!browsing && selected.taskCount > selected.tasks.length ? <button type="button" className="cc-link" onClick={() => setBrowsing(true)}>翻看全部关联任务</button> : null}
          {browsing && related.section?.ok && related.section.value.nextCursor ? <button type="button" className="cc-link" disabled={related.loading} onClick={() => setTaskCursor(related.section?.ok ? related.section.value.nextCursor ?? undefined : undefined)}>更早的关联任务</button> : null}
          {browsing && taskCursor ? <button type="button" className="cc-link" disabled={related.loading} onClick={() => setTaskCursor(undefined)}>回到最近的任务</button> : null}
          {browsing && (related.failure || (related.section && !related.section.ok)) ? <SectionState message="关联任务暂时读不到" onRetry={() => void related.reload()} /> : null}
        </details>
      </article> : null}
    </div>
  </section>;
}
