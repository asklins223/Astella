import { useEffect, useMemo, useRef, useState } from "react";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";
import { usePageReadableView } from "../../hud/use-page-readable-view";
import { HUD_PAGES } from "../../hud/hud-pages";
import type { CompanionSelfNoteV1 } from "@astella/shared";
import { gatewayErrorMessage, unwrapGatewayResult } from "../../../app/desktop-client";
import { useRoomStore } from "../../../app/room-store";
import { renderCompanionMarkdown } from "../../companion/companion-markdown";
import { CenterFeedback, CenterSearch, SectionState } from "./companion-center-primitives";
import { publishCompanionRecordsChanged, useCompanionRecordsRefresh, useCompanionResource } from "./use-companion-resource";

const tiers = { resident: "常放在手边", active: "还在关注", archived: "已归档" };
const noteState = (note: CompanionSelfNoteV1) => note.userDisabled ? "你已停用"
  : note.expiresAt && Date.parse(note.expiresAt) <= Date.now() ? "已过期" : tiers[note.tier];
export function CompanionSelfNotesPage({ refreshKey }: { refreshKey: number }) {
  const scope = useRoomStore(state => state.workspaceScopeRevision);
  const resource = useCompanionResource(meta => window.astella.agent.listSelfNotes({ meta }), [scope, refreshKey]);
  useCompanionRecordsRefresh(resource.reload);
  const [key, setKey] = useState<string | null>(null), [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CompanionSelfNoteV1 | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0), writing = useRef(false), detail = useRef<HTMLElement>(null);
  useEffect(() => { generation.current++; writing.current = false; setBusy(false); setKey(null); setDraft(null);
    setQuery(""); setError(null); setNotice(null); }, [scope]);
  const items = resource.section?.ok ? resource.section.value.items : [];
  const visibleItems = items.filter(note => `${note.title} ${note.body}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = items.find(note => note.key === key) ?? null;
  const history = useCompanionResource(async meta => {
    const result = await window.astella.agent.getSelfNoteHistory({ meta, key: key! });
    return result.ok ? { ...result, data: { ...result.data, noteKey: key } } : result;
  },
    [scope, key, selected?.revision, refreshKey], key !== null);
  const readable = useMemo<PageReadableV1>(() => ({ pageId: "companion", title: HUD_PAGES.companion.title,
    statusLine: error ?? notice ?? (!resource.section ? "正在读取她的记事…" : !resource.section.ok ? "她的记事暂时读不到" : draft ? "正在纠正记事" : undefined),
    filters: [{ label: "视图", value: "她的记事" }, ...(query.trim() ? [{ label: "关键词", value: query.trim().slice(0, 40) }] : [])],
    ...(!draft && visibleItems.length ? { items: visibleItems.slice(0, 12).map((note, index) => ({ ordinal: index + 1,
      label: note.title, state: noteState(note) })) } : {}),
  }), [error, notice, resource.section, draft, query, visibleItems]);
  usePageReadableView(readable);
  const write = async (action: () => Promise<unknown>, message: string) => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError(null);
    const epoch = generation.current;
    try {
      await action();
      if (epoch !== generation.current || useRoomStore.getState().workspaceScopeRevision !== scope) return;
      setDraft(null); setNotice(message); publishCompanionRecordsChanged();
      await resource.reload({ silent: true });
    } catch (failure) { if (epoch === generation.current) { setError(gatewayErrorMessage(failure)); await resource.reload({ silent: true }); } }
    finally { if (epoch === generation.current) { writing.current = false; setBusy(false); } }
  };
  const control = (action: "disable" | "restore") => {
    if (!selected) return;
    void write(async () => unwrapGatewayResult(await window.astella.agent.controlSelfNote({ meta: resource.meta(),
      request: { key: selected.key, expectedRevision: selected.revision, action } })),
    action === "disable" ? "已停用，伴星不会自行恢复或继续重评这条记事。" : "已恢复，伴星可以继续整理这条记事。");
  };
  if (!resource.section) return <SectionState loading={resource.loading} message="正在读取她的记事…"
    detail={resource.failure ?? undefined} onRetry={() => void resource.reload()} />;
  if (!resource.section.ok) return <SectionState message="她的记事暂时读不到" detail={resource.section.message} onRetry={() => void resource.reload()} />;
  return <section className="cc-methods" aria-label="她的记事">
    <div className="cc-rule-intro"><h3>她的记事</h3><p>她自主留下、整理和继续关注的内容，适用时带入后续交流。你随时可以查看、纠正或停用。</p></div>
    <CenterFeedback error={error} notice={notice} />
    <CenterSearch value={query} onChange={setQuery} placeholder="找她记下的问题或素材…" label="筛选她的记事" />
    <div className={`cc-methods-workspace${selected ? " has-selection" : ""}`}>
      <div className="cc-methods-index" aria-label="她的记事目录">
        {visibleItems.map(note =>
          <button type="button" data-note-key={note.key} key={note.key} aria-pressed={note.key === key} disabled={busy} onClick={() => {
            setKey(note.key); setDraft(null); setError(null); requestAnimationFrame(() => detail.current?.focus({ preventScroll: true }));
          }}><small>{noteState(note)} · 第 {note.revision} 版</small><strong>{note.title}</strong>
            {note.nextReviewAt ? <span>她打算 {new Date(note.nextReviewAt).toLocaleString("zh-CN")} 再看看</span> : null}</button>)}
        {items.length && !visibleItems.length ? <SectionState message="没有找到这篇记事" detail="可以换个词看看。" /> : null}
        {!items.length ? <SectionState message="她还没有留下自己的记事" detail="她会根据相处和自己的关注自主整理，不需要你逐条选择。" /> : null}
      </div>
      {selected ? <article ref={detail} className="cc-method-detail" tabIndex={-1} aria-label="自己的记事详情">
        <button type="button" className="cc-link cc-reading-back" onClick={() => { setKey(null); setDraft(null); requestAnimationFrame(() => {
          const button = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-note-key]")).find(node => node.dataset.noteKey === selected.key); button?.focus();
        }); }}>← 返回记事目录</button>
        {draft ? <form className="cc-form" onSubmit={event => {
          event.preventDefault(); void write(async () => unwrapGatewayResult(await window.astella.agent.writeSelfNote({
            meta: resource.meta(), request: { key: draft.key, expectedRevision: draft.revision, title: draft.title,
              body: draft.body, tier: draft.tier, expiresAt: draft.expiresAt,
              reason: "纠正这篇记事的内容。" } })), "纠正已保存，原文仍在旧版本里。");
        }}><label>标题<input value={draft.title} maxLength={120} disabled={busy} onChange={event => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
          <label>她留下的内容<textarea rows={14} value={draft.body} maxLength={32768} disabled={busy} onChange={event => setDraft({ ...draft, body: event.currentTarget.value })} /></label>
          {selected.revision !== draft.revision ? <p role="status">她已经写了新版本；这份草稿保留，保存时会核对版本。</p> : null}
          <div className="cc-actions"><button type="button" className="cc-link" disabled={busy} onClick={() => setDraft(null)}>取消纠正</button>
            <button type="submit" className="cc-button is-primary" disabled={busy || !draft.title.trim() || !draft.body.trim()}>保存纠正</button></div>
        </form> : <><h3>{selected.title}</h3><div className="cc-persona-prose">{renderCompanionMarkdown(selected.body)}</div>
          <p className="cc-muted">{selected.reason}</p><div className="cc-actions">
            <button type="button" className="cc-button" disabled={busy} onClick={() => setDraft(selected)}>纠正内容</button>
            <button type="button" className="cc-link" disabled={busy} onClick={() => control(selected.userDisabled ? "restore" : "disable")}>{selected.userDisabled ? "恢复这条记事" : "停用这条记事"}</button>
          </div></>}
        <details className="cc-details"><summary>她怎样改过这篇记事</summary>
          {history.loading ? <p>正在读取旧版本…</p> : history.section?.ok && history.section.value.noteKey === key ? history.section.value.items.map(note =>
            <details key={note.revision}><summary>第 {note.revision} 版 · {new Date(note.updatedAt).toLocaleString("zh-CN")}</summary>
              <div>{renderCompanionMarkdown(note.body)}</div><p>{note.reason}</p></details>) : <SectionState message="旧版本暂时读不到" onRetry={() => void history.reload()} />}
        </details>
      </article> : null}
    </div>
  </section>;
}
