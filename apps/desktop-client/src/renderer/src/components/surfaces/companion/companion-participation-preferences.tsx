import { useEffect, useRef, useState } from "react";
import { COMPANION_DEFAULT_PARTICIPATION } from "@astella/shared";
import type { CompanionParticipationPreferencesV1 } from "@astella/shared/companion-initiative-contracts";
import { createRequestMeta, gatewayErrorMessage, requireWorkspaceEpoch, unwrapGatewayResult } from "../../../app/client/desktop-client";
import { useRoomStore } from "../../../app/home/room-store";
import { renderCompanionMarkdown } from "../../companion/content/companion-markdown";

export function CompanionParticipationPreferences() {
  const scope = useRoomStore(s => s.workspaceScopeRevision);
  const [value, setValue] = useState<CompanionParticipationPreferencesV1 | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const reload = async () => {
    try {
      const epoch = await requireWorkspaceEpoch();
      const loaded = unwrapGatewayResult(await window.astella.companion.initiative.getPreferences({ meta: createRequestMeta(epoch) }));
      if (scope !== useRoomStore.getState().workspaceScopeRevision) return;
      setValue(loaded); setError(null);
    } catch (err) { if (scope === useRoomStore.getState().workspaceScopeRevision) setError(gatewayErrorMessage(err)); }
  };
  useEffect(() => { setValue(null); setDraft(null); if (window.astella?.companion?.initiative) void reload(); }, [scope]);
  const close = () => { setDraft(null); queueMicrotask(() => editButton.current?.focus()); };
  const save = async (markdown: string, enabled: boolean) => {
    if (!value || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const epoch = await requireWorkspaceEpoch();
      const saved = unwrapGatewayResult(await window.astella.companion.initiative.setPreferences({
        meta: createRequestMeta(epoch), request: { expectedRevision: value.revision, markdown, enabled },
      }));
      if (scope !== useRoomStore.getState().workspaceScopeRevision) return;
      setValue(saved); close(); setNotice(enabled ? "相处偏好已保存，她会结合实际情境践行。" : "主动交流偏好已暂停。");
    } catch (err) {
      if (scope === useRoomStore.getState().workspaceScopeRevision) { setError(gatewayErrorMessage(err)); }
    } finally { if (scope === useRoomStore.getState().workspaceScopeRevision) setBusy(false); }
  };
  return <section className="cc-participation" aria-label="我们怎样相处">
    <header><h4>我们怎样相处</h4><button ref={editButton} type="button" className="cc-link" disabled={!value || busy} onClick={() => setDraft(value?.markdown ?? "")}>编辑偏好</button></header>
    <p className="cc-muted">这些是每个账号都自带的相处方式。你还可以直接告诉她：“以后每次打开应用都跟我问好”“学久了提醒我走走”，按你的习惯继续调整。</p>
    <div className="cc-participation-defaults" aria-label="默认主动参与方式">
      <strong>她默认会</strong>
      <ul>{COMPANION_DEFAULT_PARTICIPATION.map(item => <li key={item.id}><b>{item.title}</b><span>{item.description}</span></li>)}</ul>
    </div>
    {draft === null ? <div className="cc-persona-prose">{value?.markdown ? renderCompanionMarkdown(value.markdown) : <p className="cc-muted">你还没有添加个人约定；上面的默认方式仍会照常生效。</p>}</div>
      : <form className="cc-form" onSubmit={e => { e.preventDefault(); void save(draft, value?.enabled ?? true); }} onKeyDown={e => { if (e.key === "Escape" && !busy) { e.preventDefault(); close(); } }}>
        <details className="cc-details"><summary>当前已保存的约定</summary>{renderCompanionMarkdown(value?.markdown || "还没有特别约定。")}</details>
        <label><span>希望她以后怎样参与</span><textarea autoFocus rows={7} maxLength={16_000} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} /></label>
        <div className="cc-actions"><button type="submit" className="cc-button is-primary" disabled={busy}>{busy ? "正在保存…" : "保存偏好"}</button><button type="button" className="cc-link" disabled={busy} onClick={close}>取消</button></div>
      </form>}
    {value?.markdown && draft === null ? <button className="cc-link" type="button" disabled={busy} onClick={() => void save(value.markdown, !value.enabled)}>{value.enabled ? "暂停这些主动约定" : "恢复这些主动约定"}</button> : null}
    {error ? <p role="alert" className="cc-feedback">{error}<button type="button" className="cc-link" onClick={() => void reload()}>重新读取</button></p> : null}
    {notice ? <p role="status" className="cc-muted">{notice}</p> : null}
  </section>;
}
