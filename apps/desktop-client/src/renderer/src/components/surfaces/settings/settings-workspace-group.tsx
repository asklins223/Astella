/**
 * 设置页「我的空间」那一组：空间身份清单、改名、退出、解散。
 *
 * ## 为什么第 8 轮没切、这一轮切了（2026-09-29）
 *
 * 上一轮试过一次就撤回了：当时逐个**猜**这些外部符号的签名，`spaceRoleTypeLine`、
 * `switchTo`、`leaveWorkspace` / `dissolveWorkspace`、`loadDissolvePreview` 的入参形状
 * 全对不上，typecheck 连报 12 处。
 *
 * 这次的做法是**先取真实签名再动手**——`switchTo(workspace)` 收的是整个 workspace 对象、
 * `loadDissolvePreview(workspaceId)` 收的是 id、两个「退出/解散」也是收整个对象。
 * 上一轮猜的「都是 id」全错了。**猜签名比重数三遍更慢也更危险**。
 *
 * 另外把 `spaceTypeLabel` / `spaceRoleTypeLine` 这两个**纯函数**搬进了
 * `settings-data-tables.ts`——它们原先是页面里的模块级声明，组件引用不到。
 *
 * ⚠️ 这一组不能拆散：改名 / 退出 / 解散是**同等级后果**，所以防护也是同等级的
 * （行内展开确认 + 按空间名校验）。拆成三个组件会让「确认框长什么样」这件事分家。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ReactElement } from "react";
import type { WorkspaceSummaryV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { SettingRow, SettingsInlineState } from "./settings-primitives.tsx";
import { ArrowRight, LogOut } from "lucide-react";
import { spaceRoleTypeLine } from "./settings-data-tables.ts";

export type DissolvePreviewCounts = { notes: number; sources: number; cards: number; schedules: number };
export type DissolvePreviewState =
  | null
  | { workspaceId: string; phase: "loading" }
  | { workspaceId: string; phase: "unavailable" }
  | { workspaceId: string; phase: "ready"; counts: DissolvePreviewCounts };

/** 确认那一句话：数得出就报数，数不出来说数不出来，绝不拿 0 冒充"什么都没有"。 */
export function dissolveSentence(preview: DissolvePreviewState, workspaceId: string, name: string): string {
  const ask = `输入空间名「${name}」以确认。`;
  if (!preview || preview.workspaceId !== workspaceId) return `正在数这个空间里有多少东西…　${ask}`;
  if (preview.phase === "loading") return `正在数这个空间里有多少东西…　${ask}`;
  if (preview.phase === "unavailable") {
    return `这个空间会连同其中的笔记、来源、卡片与排程一起消失（这一项目前数不出来）。${ask}`;
  }
  const { notes, sources, cards, schedules } = preview.counts;
  return `这个空间里有 ${notes} 篇笔记（含回收站里的）、${sources} 份来源、${cards} 张卡、${schedules} 条排程。`
    + `解散后它们一起消失，取不回来。${ask}`;
}

export function SettingsWorkspaceGroup(props: {
  readonly workspaces: readonly WorkspaceSummaryV1[];
  readonly workspaceListFailure: string | null;
  readonly currentWorkspace: WorkspaceSummaryV1 | null;
  readonly renamableWorkspace: WorkspaceSummaryV1 | null;
  readonly renameValue: string;
  readonly setRenameValue: (value: string) => void;
  readonly switchTo: (workspace: WorkspaceSummaryV1) => Promise<void>;
  readonly renamePersonalWorkspace: () => Promise<void>;
  /** 退出与解散：都收整个 workspace 对象（页面上判定 role 之后才调）。 */
  readonly leaveWorkspace: (workspace: WorkspaceSummaryV1) => Promise<void>;
  readonly dissolveWorkspace: (workspace: WorkspaceSummaryV1) => Promise<void>;
  readonly leavePending: string | null;
  readonly setLeavePending: (value: string | null) => void;
  readonly dissolvePending: string | null;
  readonly setDissolvePending: (value: string | null) => void;
  readonly dissolveConfirmText: string;
  readonly setDissolveConfirmText: (value: string) => void;
  readonly dissolvePreview: DissolvePreviewState;
  readonly loadDissolvePreview: (workspaceId: string) => void;
  /** 一次性动作的进行中标记：切空间 / 改名 / 退出 / 解散共用一个。 */
  readonly switching: string | null;
  readonly profileBusy: string | null;
}): ReactElement {
  const {
    workspaces, workspaceListFailure, currentWorkspace,
    renamableWorkspace, renameValue, setRenameValue, switchTo, renamePersonalWorkspace,
    leaveWorkspace, dissolveWorkspace, leavePending, setLeavePending,
    dissolvePending, setDissolvePending, dissolveConfirmText, setDissolveConfirmText,
    dissolvePreview, loadDissolvePreview,
    switching, profileBusy,
  } = props;
  return (
<section className="settings-group">
  <h3 className="settings-group__title">我的空间</h3>
  <div className="settings-ledger" role="group" aria-label="我的空间身份">
    {workspaces.length === 0 && !workspaceListFailure ? (
      <SettingsInlineState title="没有可切换的空间" detail="当前会话未返回其他学习空间。" />
    ) : workspaces.map((workspace) => {
      const current = workspace.workspaceId === currentWorkspace?.workspaceId;
      const busy = switching === workspace.workspaceId;
      const canLeave = !workspace.isPersonal && workspace.role !== "owner";
      const canDissolve = !workspace.isPersonal && workspace.role === "owner";
      const dissolveNoteId = `settings-dissolve-note-${workspace.workspaceId}`;
      return (
        <div key={workspace.workspaceId} className="settings-ledger__item">
          <button
            type="button"
            className="settings-ledger__row"
            aria-current={current ? "true" : undefined}
            aria-busy={busy || undefined}
            disabled={switching !== null}
            onClick={() => void switchTo(workspace)}
          >
            <span className="settings-ledger__seal" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
            <span>
              <b>{workspace.name}</b>
              <small>{spaceRoleTypeLine(workspace.role, workspace.workspaceType)}</small>
            </span>
            {busy
              ? <span className="tag">切换中…</span>
              : current ? <span className="tag green">当前</span> : <ArrowRight size={14} aria-hidden="true" />}
          </button>
          {canLeave ? (
            leavePending === workspace.workspaceId ? (
              <div
                className="settings-ledger__dissolve-panel"
                role="group"
                aria-label={`退出 ${workspace.name} 的确认`}
              >
                <p className="settings-group__note">
                  退出后这个空间的笔记、卡片与排程都看不到了；要再进来，需要空间所有者重新发一个邀请码。
                </p>
                <div className="settings-ledger__dissolve-actions">
                  <button
                    type="button"
                    className="button danger"
                    aria-label={`确认退出 ${workspace.name}`}
                    disabled={profileBusy !== null || switching !== null}
                    onClick={() => void leaveWorkspace(workspace)}
                  >
                    <LogOut size={12} aria-hidden="true" />
                    {profileBusy === `leave-${workspace.workspaceId}` ? "退出中…" : "确认退出"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={profileBusy !== null}
                    onClick={() => setLeavePending(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="button danger settings-ledger__leave"
                aria-label={`退出 ${workspace.name}`}
                disabled={profileBusy !== null || switching !== null}
                onClick={() => setLeavePending(workspace.workspaceId)}
              >
                <LogOut size={12} aria-hidden="true" />
                退出
              </button>
            )
          ) : null}
          {canDissolve ? (
            dissolvePending === workspace.workspaceId ? (
              <div
                className="settings-ledger__dissolve-panel"
                role="group"
                aria-label={`解散 ${workspace.name} 的确认`}
              >
                <p className="settings-group__note" id={dissolveNoteId}>
                  {dissolveSentence(dissolvePreview, workspace.workspaceId, workspace.name)}
                </p>
                <div className="hud-field">
                  <input
                    aria-labelledby={dissolveNoteId}
                    value={dissolveConfirmText}
                    onChange={(event) => setDissolveConfirmText(event.target.value)}
                    placeholder="输入空间名"
                  />
                </div>
                <div className="settings-ledger__dissolve-actions">
                  <button
                    type="button"
                    className="button danger"
                    disabled={dissolveConfirmText !== workspace.name || profileBusy !== null}
                    onClick={() => void dissolveWorkspace(workspace)}
                  >
                    {profileBusy === `dissolve-${workspace.workspaceId}` ? "解散中…" : "确认解散"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setDissolvePending(null);
                      setDissolveConfirmText("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="button danger settings-ledger__dissolve-trigger"
                aria-label={`解散 ${workspace.name}`}
                disabled={profileBusy !== null || switching !== null}
                onClick={() => {
                  setDissolvePending(workspace.workspaceId);
                  setDissolveConfirmText("");
                  void loadDissolvePreview(workspace.workspaceId);
                }}
              >
                解散空间
              </button>
            )
          ) : null}
        </div>
      );
    })}
  </div>
  {renamableWorkspace ? (
    <div className="settings-block">
      <div className="settings-block__head">
        <div>
          <b>{renamableWorkspace.isPersonal ? "个人空间改名" : "协作空间改名"}</b>
          <p>
            {renamableWorkspace.isPersonal
              ? `只对「${renamableWorkspace.name}」生效。`
              : `改的是「${renamableWorkspace.name}」；协作空间里只有所有者能改名，成员要改动请找所有者。`}
          </p>
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="settings-personal-name">空间名称</label>
        <div className="hud-field">
          <input
            id="settings-personal-name"
            value={renameValue}
            placeholder="最长 50 字"
            maxLength={50}
            disabled={profileBusy !== null}
            onChange={(event) => setRenameValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void renamePersonalWorkspace();
            }}
          />
          <button
            type="button"
            className="button primary"
            disabled={profileBusy !== null || !renameValue.trim()}
            onClick={() => void renamePersonalWorkspace()}
          >
            {profileBusy === "rename" ? "改名中…" : "改名"}
          </button>
        </div>
      </div>
    </div>
  ) : null}
</section>
  );
}
