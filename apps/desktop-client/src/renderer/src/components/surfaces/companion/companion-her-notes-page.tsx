import { useEffect, useMemo, useRef, useState } from "react";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import type { CompanionMemoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import type { CompanionSelfNoteV1 } from "@astella/shared";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CenterFeedback, CenterSearch, SectionState } from "./companion-center-primitives";
import { CompanionSelect, type CompanionSelectOption } from "./companion-select";
import { memoryState } from "./companion-center-model";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

const tiers = { resident: "常放在手边", active: "还在关注", archived: "已归档" };
const noteState = (note: CompanionSelfNoteV1) => note.userDisabled ? "你已停用"
  : note.expiresAt && Date.parse(note.expiresAt) <= Date.now() ? "已过期" : tiers[note.tier];
function judgmentState(item: CompanionMemoryItemV1): string {
  const state = memoryState(item);
  if (state === "archived") return "她已经收回";
  if (state === "expired") return "已过期";
  return item.userConfirmed ? "她确定这样看" : "她还在琢磨";
}

/**
 * 她的记事与她的看法是同一次反思写出来的两个槽（一篇记事、一条 judgment 记忆），
 * 跨表没有去重，所以放在同一张清单里由她自己的口吻呈现，而不是分成两档。
 */
type HerRow = {
  id: string; group: "她的记事" | "她的看法"; title: string; body: string;
  state: string; revision: number; updatedAt: string; wake: string | null;
  note: CompanionSelfNoteV1 | null; memory: CompanionMemoryItemV1 | null;
};

const GROUP_OPTIONS: ReadonlyArray<CompanionSelectOption<HerGroup>> = [
  { value: "all", label: "两类都看" },
  { value: "她的记事", label: "只看她写下的记事" },
  { value: "她的看法", label: "只看她的看法" },
];

type HerGroup = "all" | "她的记事" | "她的看法";

export function CompanionHerNotesPage({ refreshKey }: { refreshKey: number }) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const notes = useCompanionResource(meta => window.astella.agent.listSelfNotes({ meta }), [scope, refreshKey]);
  const memories = useCompanionResource(meta => window.astella.companion.memory.list({ meta, query: { includeCandidates: true, includeArchived: true } }), [scope, refreshKey]);
  const reloadAll = async () => { await Promise.all([notes.reload(), memories.reload()]); };
  useCompanionRecordsRefresh(reloadAll);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<HerGroup>("all");
  const [draft, setDraft] = useState<{ title: string; body: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0), writing = useRef(false), detail = useRef<HTMLElement>(null);
  useEffect(() => { generation.current++; writing.current = false; setBusy(false); setSelectedId(null); setDraft(null);
    setQuery(""); setGroup("all"); setError(null); setNotice(null); }, [scope]);
  const rows = useMemo<HerRow[]>(() => [
    ...(notes.section?.ok ? notes.section.value.items : []).map(note => ({
      id: `note:${note.key}`, group: "她的记事" as const, title: note.title, body: note.body,
      state: noteState(note), revision: note.revision, updatedAt: note.updatedAt,
      wake: note.nextReviewAt ? `她打算 ${new Date(note.nextReviewAt).toLocaleString("zh-CN")} 再看看` : null,
      note, memory: null,
    })),
    ...(memories.section?.ok ? memories.section.value.items : []).filter(item => item.kind === "judgment").map(item => ({
      id: `judgment:${item.memoryItemId}`, group: "她的看法" as const, title: item.content, body: item.content,
      state: judgmentState(item), revision: item.revision, updatedAt: item.updatedAt, wake: null,
      note: null, memory: item,
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [notes.section, memories.section]);
  const visible = rows.filter(row => (group === "all" || row.group === group) && `${row.title} ${row.body}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = visible.find(row => row.id === selectedId) ?? null;
  useEffect(() => { if (visible.length && !visible.some(row => row.id === selectedId)) setSelectedId(visible[0].id); }, [visible, selectedId]);
  const selectedNoteKey = selected?.note?.key ?? null;
  const selectedJudgmentId = selected?.memory?.memoryItemId ?? null;
  const noteHistory = useCompanionResource(async meta => {
    const result = await window.astella.agent.getSelfNoteHistory({ meta, key: selectedNoteKey! });
    return result.ok ? { ...result, data: { ...result.data, noteKey: selectedNoteKey } } : result;
  }, [scope, selectedId, selected?.revision, refreshKey], selectedNoteKey !== null);
  const judgmentHistory = useCompanionResource(async meta => {
    const result = await window.astella.companion.memory.revisions({ meta, memoryId: selectedJudgmentId! });
    return result.ok ? { ...result, data: { ...result.data, focusId: selectedJudgmentId } } : result;
  }, [scope, selectedId, selected?.revision, refreshKey], selectedJudgmentId !== null);
  const readable = useMemo<PageReadableV1>(() => ({ pageId: "companion", title: HUD_PAGES.companion.title,
    statusLine: error ?? notice ?? (!notes.section || !memories.section ? "正在读取她的记事…" : draft ? "正在纠正记事" : undefined),
    filters: [{ label: "类型", value: GROUP_OPTIONS.find(option => option.value === group)?.label ?? "两类都看" }, ...(query.trim() ? [{ label: "关键词", value: query.trim().slice(0, 40) }] : [])],
    ...(!draft && visible.length ? { items: visible.slice(0, 12).map((row, index) => ({ ordinal: index + 1,
      label: row.title.slice(0, 120), state: `${row.group}· ${row.state}` })) } : {}),
  }), [error, notice, notes.section, memories.section, draft, query, visible, group]);
  usePageReadableView(readable);
  const write = async (action: () => Promise<unknown>, message: string) => {
    if (writing.current || !selected) return;
    const epoch = generation.current;
    writing.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (epoch !== generation.current || useRoomStore.getState().workspaceScopeRevision !== scope) return;
      setDraft(null); setNotice(message); publishCompanionRecordsChanged();
      await Promise.all([notes.reload({ silent: true }), memories.reload({ silent: true })]);
    } catch (failure) { if (epoch === generation.current) { setError(gatewayErrorMessage(failure)); void Promise.all([notes.reload({ silent: true }), memories.reload({ silent: true })]); } }
    finally { if (epoch === generation.current) { writing.current = false; setBusy(false); } }
  };
  const save = () => {
    if (!selected || !draft) return;
    const body = draft.body.trim();
    if (selected.note) {
      const note = selected.note, title = draft.title.trim() || note.title;
      void write(async () => unwrapGatewayResult(await window.astella.agent.writeSelfNote({ meta: notes.meta(), request: {
        key: note.key, expectedRevision: draft.revision, title, body, tier: note.tier, expiresAt: note.expiresAt,
        reason: "纠正这篇记事的内容。" } })), "纠正已保存，原文仍在旧版本里。");
      return;
    }
    const item = selected.memory!;
    void write(async () => unwrapGatewayResult(await window.astella.companion.memory.correct({ meta: notes.meta(),
      memoryId: item.memoryItemId, request: { content: body, expectedRevision: draft.revision } })), "纠正已保存，她原来的说法留在旧版本里。");
  };
  const control = () => {
    if (!selected) return;
    if (selected.note) {
      const note = selected.note;
      void write(async () => unwrapGatewayResult(await window.astella.agent.controlSelfNote({ meta: notes.meta(),
        request: { key: note.key, expectedRevision: note.revision, action: note.userDisabled ? "restore" : "disable" } })),
      note.userDisabled ? "已恢复，伴星可以继续整理这条记事。" : "已停用，伴星不会自行恢复或继续重评这条记事。");
      return;
    }
    const item = selected.memory!;
    const action = item.archived ? "restore" : "archive";
    void write(async () => unwrapGatewayResult(await window.astella.companion.memory[action]({ meta: notes.meta(), memoryId: item.memoryItemId })),
      action === "archive" ? "她已经不再这样看了；随时可以恢复。" : "已恢复，她还会带着这个看法。");
  };
  if (!notes.section || !memories.section) return <SectionState loading
    message={notes.failure ?? memories.failure ? "她的记事暂时读不到" : "正在读取她的记事…"}
    detail={(notes.failure ?? memories.failure) ?? undefined}
    onRetry={notes.failure ?? memories.failure ? () => { void notes.reload(); void memories.reload(); } : undefined} />;
  if (!notes.section.ok) return <SectionState message="她的记事暂时读不到" detail={notes.section.message} onRetry={() => void notes.reload()} />;
  if (!memories.section.ok) return <SectionState message="她的看法暂时读不到" detail={memories.section.message} onRetry={() => void memories.reload()} />;
  return <section className="cc-methods" aria-label="她的记事">
    <p className="cc-rule-intro">记事是她整理过的一段，看法是她对某一件事的理解；两条都会在她下次开口时带上。</p>
    <CenterFeedback error={error} notice={notice} />
    <div className="cc-toolbar"><CenterSearch value={query} onChange={setQuery} placeholder="找她记下的判断或素材…" label="筛选她的记事" /></div>
    <div className="cc-filter-line" role="group" aria-label="她的记事筛选"><CompanionSelect paper ariaLabel="筛选她的记事的类型" value={group} options={GROUP_OPTIONS} onChange={setGroup} /><span>{visible.length} 条</span></div>
    <div className={`cc-methods-workspace${selected ? " has-selection" : ""}`}>
      <div className="cc-methods-index" aria-label="她的记事目录">
        {visible.length ? ([{ key: "她的记事", label: "她写下的记事" }, { key: "她的看法", label: "她的看法" }] as const).map(group => {
          const groupRows = visible.filter(row => row.group === group.key);
          if (!groupRows.length) return null;
          return <section key={group.key} aria-label={group.label}>
            <h3>{group.label}</h3>
            {groupRows.map(row => <button type="button" key={row.id} data-note-key={row.note?.key} data-memory-id={row.memory?.memoryItemId}
              aria-pressed={row.id === selectedId} disabled={busy} onClick={() => { setSelectedId(row.id); setDraft(null); setError(null); requestAnimationFrame(() => detail.current?.focus({ preventScroll: true })); }}>
              <small>{row.state} · 第 {row.revision} 版</small><strong>{row.title}</strong>{row.wake ? <span>{row.wake}</span> : null}
            </button>)}
          </section>;
        }) : <SectionState message={rows.length ? "没有找到她记下的这一条" : "她还没有留下自己的记事"}
          detail={rows.length ? "可以换个词看看。" : "她会根据相处和自己的关注自主整理，不需要你逐条选择。"} />}
      </div>
      {selected ? <article ref={detail} className="cc-method-detail" tabIndex={-1} aria-label="自己的记事详情">
        <button type="button" className="cc-link cc-reading-back" onClick={() => { setSelectedId(null); setDraft(null); requestAnimationFrame(() => {
          const node = document.querySelector<HTMLButtonElement>(`[data-note-key="${selected.note?.key ?? ""}"],[data-memory-id="${selected.memory?.memoryItemId ?? ""}"]`); node?.focus();
        }); }}>← 返回记事目录</button>
        <header><span className="cc-kicker">{selected.group}</span><span className="cc-badge">{selected.state}</span></header>
        {draft ? <form className="cc-form" onSubmit={event => { event.preventDefault(); save(); }}>
          {selected.note ? <label>标题<input value={draft.title} maxLength={120} disabled={busy} onChange={event => setDraft({ ...draft, title: event.currentTarget.value })} /></label> : null}
          <label>{selected.note ? "她留下的内容" : "她现在的看法"}<textarea rows={selected.note ? 14 : 4} value={draft.body} maxLength={selected.note ? 32768 : 200} disabled={busy} onChange={event => setDraft({ ...draft, body: event.currentTarget.value })} /></label>
          {selected.revision !== draft.revision ? <p role="status">她已经写了新版本；这份草稿保留，保存时会核对版本。</p> : null}
          <div className="cc-actions"><button type="button" className="cc-link" disabled={busy} onClick={() => setDraft(null)}>取消纠正</button>
            <button type="submit" className="cc-button is-primary" disabled={busy || !draft.body.trim()}>保存纠正</button></div>
        </form> : <>{selected.note ? <><h3>{selected.title}</h3><div className="cc-persona-prose">{renderCompanionMarkdown(selected.body)}</div></>
          : <p className="cc-memory-detail__body">{selected.body}</p>}
          {selected.memory?.candidate ? <div className="cc-actions"><button type="button" className="cc-button is-primary" disabled={busy}
            onClick={() => void write(async () => unwrapGatewayResult(await window.astella.companion.memory.confirm({ meta: notes.meta(), memoryId: selected.memory!.memoryItemId })), "已确认，她会把这个看法带进后续合作。")}>确认采用</button></div> : null}
          <div className="cc-actions">
            <button type="button" className="cc-button" disabled={busy} onClick={() => setDraft({ title: selected.note?.title ?? "", body: selected.body, revision: selected.revision })}>纠正内容</button>
            <button type="button" className="cc-link" disabled={busy} onClick={control}>{selected.note ? selected.note.userDisabled ? "恢复这条记事" : "停用这条记事" : selected.memory?.archived ? "恢复这条看法" : "暂时不这样看"}</button>
          </div></>}
        <details className="cc-details"><summary>她怎样改过这一条</summary>
          {selected.note ? (!noteHistory.section || noteHistory.loading ? <p>正在读取旧版本…</p>
            : noteHistory.section.ok && noteHistory.section.value.noteKey === selected.note.key ? noteHistory.section.value.items.map(item => <details key={item.revision}>
              <summary>第 {item.revision} 版 · {new Date(item.updatedAt).toLocaleString("zh-CN")}</summary>
              <div>{renderCompanionMarkdown(item.body)}</div><p>{item.reason}</p></details>)
            : <SectionState message="旧版本暂时读不到" onRetry={() => void noteHistory.reload()} />) : null}
          {selected.memory ? (!judgmentHistory.section || judgmentHistory.loading ? <p>正在读取旧版本…</p>
            : judgmentHistory.section.ok && judgmentHistory.section.value.focusId === selected.memory.memoryItemId ? judgmentHistory.section.value.items.map(item => <details key={item.revision}>
              <summary>第 {item.revision} 版 · {new Date(item.supersededAt).toLocaleString("zh-CN")}</summary>
              <p>{item.content}</p></details>)
            : <SectionState message="旧版本暂时读不到" onRetry={() => void judgmentHistory.reload()} />) : null}
        </details>
      </article> : null}
    </div>
  </section>;
}
