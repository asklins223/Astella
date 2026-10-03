/**
 * 「协作空间邀请码」那一栏：粘贴一个码，加入另一个空间。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 20 行、3 个外部符号。成员那半的入群路径只有这一条，边界清楚。
 *
 * 当前加入按钮复用公共主按钮；版式与视觉权重可随设置任务调整。
 */
import type { ReactElement } from "react";

export function SettingsInviteJoinField(props: {
  readonly inviteCode: string;
  readonly setInviteCode: (value: string) => void;
  readonly joining: boolean;
  readonly joinWithInvite: () => Promise<void>;
}): ReactElement {
  const { inviteCode, setInviteCode, joining, joinWithInvite } = props;
  return (
<div className="settings-field">
  <label className="settings-field__label" htmlFor="settings-invite-code">协作空间邀请码</label>
  <div className="hud-field">
    <input
      id="settings-invite-code"
      value={inviteCode}
      placeholder="粘贴邀请码"
      disabled={joining}
      onChange={(event) => setInviteCode(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (!joining && inviteCode.trim()) void joinWithInvite();
      }}
    />
    <button type="button" className="button primary" disabled={joining || !inviteCode.trim()} onClick={() => void joinWithInvite()}>
      {joining ? "加入中…" : "加入"}
    </button>
  </div>
</div>
  );
}
