import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, House, Leaf, Plus, Search, Settings2, Ticket, UsersRound, X } from "lucide-react";
import type { WorkspaceSummaryV1 } from "@astella/shared/desktop-ipc-contracts";
import { spaceRoleLabel } from "../../app/space-identity";
import { HudBubbleConfirmation, HudBubbleHeader } from "./HudBubbleParts";
import { useHudSpaces } from "./use-hud-spaces";
import { useTactileSurface } from "../motion/use-tactile-surface";

export const SPACE_SEARCH_MINIMUM = 5;

export function HudSpaceMenu({ notice, onSwitched, onClose, onManage }: {
  readonly notice?: string | null;
  readonly onSwitched?: (name: string) => void;
  readonly onClose?: () => void;
  readonly onManage?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<"join" | "create" | null>(null);
  useTactileSurface(rootRef, form ?? "spaces");
  const spaces = useHudSpaces(onSwitched);
  const { state, busy, message, recents, confirmation } = spaces;
  const personalId = useId(), collaborativeId = useId(), formId = useId();
  const searchable = state.workspaces.length >= SPACE_SEARCH_MINIMUM;
  const normalized = searchable ? query.trim().toLowerCase() : "";
  const visible = state.workspaces.filter(workspace => workspace.name.toLowerCase().includes(normalized));
  const recent = (rows: readonly WorkspaceSummaryV1[]) => [...rows].sort((a, b) =>
    (recents[b.workspaceId] ?? 0) - (recents[a.workspaceId] ?? 0));
  const personal = recent(visible.filter(workspace => workspace.workspaceType === "personal"));
  const collaborative = recent(visible.filter(workspace => workspace.workspaceType === "collaborative"));
  const currentId = state.session?.workspace?.workspaceId;

  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (form) fieldRef.current?.focus(); }, [form]);
  const cancelConfirmation = () => { spaces.cancelConfirmation(); actionRef.current?.focus(); };
  const toggleForm = (next: "join" | "create", trigger: HTMLButtonElement) => {
    actionRef.current = trigger;
    setForm(current => current === next ? null : next); spaces.clearMessage();
  };
  const closeForm = () => { setForm(null); actionRef.current?.focus(); };
  const renderRow = (workspace: WorkspaceSummaryV1) => {
    const current = workspace.workspaceId === currentId;
    const rowBusy = busy === workspace.workspaceId;
    const personalSpace = workspace.workspaceType === "personal";
    return (
      <button key={workspace.workspaceId} type="button" className="hud-space-row" aria-current={current ? "true" : undefined}
        data-current={current || undefined} data-joined={spaces.joinedId === workspace.workspaceId || undefined}
        data-busy={rowBusy || undefined} aria-busy={rowBusy || undefined} disabled={busy !== null || current}
        onClick={event => { actionRef.current = event.currentTarget; void spaces.enter(workspace); }}>
        <span className="hud-space-row__icon" data-personal={personalSpace || undefined} aria-hidden="true">
          {personalSpace ? <House size={20} /> : <UsersRound size={20} />}
        </span>
        <span className="hud-space-row__text"><b title={workspace.name}>{workspace.name}</b>
          <small>{spaceRoleLabel(workspace)}</small></span>
        {rowBusy ? <span className="hud-bubble-badge">进入中…</span>
          : current ? <span className="hud-bubble-badge" data-tone="mint"><Check size={12} aria-hidden="true" />当前</span>
            : <ArrowRight className="hud-space-row__arrow" size={16} aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="hud-space-bubble" role="dialog" aria-label="学习空间" tabIndex={-1}>
      <HudBubbleHeader title="学习空间" hint="选一间书房，接着学" icon={<Leaf size={20} />} onClose={onClose} />
      {searchable ? <label className="hud-space-search"><Search size={16} aria-hidden="true" />
        <input type="search" value={query} maxLength={50} autoComplete="off" spellCheck={false}
          aria-label="搜索学习空间" placeholder="找一间学习空间" onChange={event => setQuery(event.target.value)} />
      </label> : null}
      <div className="hud-space-list">
        {state.loading ? <p className="hud-bubble-status" role="status">{state.ready ? "正在更新列表……" : "正在读取可用的学习空间……"}</p> : null}
        {state.failure ? <div className="hud-bubble-notice" data-tone="error">
          <p role="alert">{state.failure}</p><button type="button" className="hud-bubble-button" disabled={busy !== null} onClick={() => void spaces.load()}>重试</button>
        </div> : null}
        {state.ready && !state.workspaces.length ? <p className="hud-bubble-status">这个账号还没有可用的学习空间。</p> : null}
        {state.workspaces.length > 0 && !visible.length ? <p className="hud-bubble-status">没有匹配「{query.trim()}」的学习空间。</p> : null}
        {personal.length ? <section className="hud-space-group" aria-labelledby={personalId}>
          <h3 id={personalId}>个人空间</h3>{personal.map(renderRow)}
        </section> : null}
        {collaborative.length ? <section className="hud-space-group" aria-labelledby={collaborativeId}>
          <h3 id={collaborativeId}>协作空间</h3>{collaborative.map(renderRow)}
        </section> : null}
      </div>
      <footer className="hud-space-footer">
        {message || notice ? <p className="hud-bubble-status" data-tone={message?.tone}
          role={message?.tone === "error" ? "alert" : "status"}>{message?.text ?? notice}</p> : null}
        {confirmation ? <HudBubbleConfirmation title="切换会中断当前测评" confirmLabel={confirmation.kind === "create" ? "创建并进入" : "确认切换"}
          onConfirm={spaces.confirm} onCancel={cancelConfirmation}>
          {confirmation.kind === "switch" ? `准备进入「${confirmation.workspace.name}」。` : `准备创建并进入「${confirmation.name}」。`}正在进行的正式测评会结束。
        </HudBubbleConfirmation> : <>
          <div className="hud-space-actions">
            <button type="button" className="hud-bubble-button" disabled={!state.ready || busy !== null} aria-expanded={form === "join"}
              aria-controls={form === "join" ? formId : undefined} data-selected={form === "join" || undefined}
              onClick={event => toggleForm("join", event.currentTarget)}><Ticket size={16} aria-hidden="true" />加入空间</button>
            <button type="button" className="hud-bubble-button" disabled={!state.ready || busy !== null} aria-expanded={form === "create"}
              aria-controls={form === "create" ? formId : undefined} data-selected={form === "create" || undefined}
              onClick={event => toggleForm("create", event.currentTarget)}><Plus size={16} aria-hidden="true" />新建空间</button>
          </div>
          {form ? <form id={formId} className="hud-space-form" data-tactile-page="true" onSubmit={event => {
            event.preventDefault();
            if (form === "create") void spaces.create(newSpaceName);
            else void spaces.join(inviteCode).then(committed => { if (committed) setInviteCode(""); });
          }} onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}>
            <div className="hud-space-form__heading"><label htmlFor={`${formId}-input`}>{form === "join" ? "协作空间邀请码" : "新协作空间名称"}</label>
              <button type="button" className="hud-bubble-close" aria-label="收起表单" data-hud-cancel="true" disabled={busy !== null} onClick={closeForm}><X size={15} aria-hidden="true" /></button>
            </div>
            <div className="hud-space-form__line"><input ref={fieldRef} id={`${formId}-input`} value={form === "join" ? inviteCode : newSpaceName}
              maxLength={form === "join" ? 200 : 50} autoComplete="off" spellCheck={false} disabled={busy !== null}
              onChange={event => { if (form === "join") setInviteCode(event.target.value); else setNewSpaceName(event.target.value); spaces.clearMessage(); }}
              placeholder={form === "join" ? "粘贴收到的邀请码" : "给新空间起个名字"} />
              <button type="submit" className="hud-bubble-button" data-tone="mint" disabled={busy !== null || !(form === "join" ? inviteCode : newSpaceName).trim()}>
                {busy ? "处理中…" : form === "join" ? "加入" : "创建"}
              </button></div>
            <p>{form === "join" ? "加入后留在这里，由你选择何时进入。" : "创建后会直接进入，邀请朋友一起学。"}</p>
          </form> : null}
          {onManage ? <button type="button" className="hud-space-manage" disabled={busy !== null} onClick={onManage}>
            <Settings2 size={14} aria-hidden="true" />管理空间与邀请<ArrowRight size={13} aria-hidden="true" />
          </button> : null}
        </>}
      </footer>
    </div>
  );
}
