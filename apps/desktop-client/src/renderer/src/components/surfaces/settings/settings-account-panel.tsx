/**
 * 设置页的「个人档案」那一块：显示名与头像。
 *
 * ## 为什么从 `settings-surface.tsx` 拆出来（2026-09-29）
 *
 * 那个文件里 `SettingsSurface` 单个函数 2600 多行。它的 **state 是跨域共享的**——
 * `props.busy` 31 处，散在账户、成员、邀请三个域里，所以「按状态簇收成 hook」这条路
 * 在这份文件上不成立（试过，牵一发而动全身）。能干净切的是**面板**：这块 58 行、
 * 只用 4 个值与 2 个回调，是整份文件里外部依赖最少的一块。
 *
 * 所以这里的样板是「**一块面板 = 一个组件 + 显式 props**」，而不是「一堆 state 收进一个 hook」。
 * 后面按设置域切时照这个做。
 *
 * ⚠️ JSX 与那三个 `settings-field` / `settings-block__*` 类名是逐字搬的。`id="settings-display-name"`
 * 也要保留——它是 `<label htmlFor>` 的目标，改了就断了一条无障碍关联。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import type { ChangeEvent, KeyboardEvent, ReactElement } from "react";
import type { AuthProfileResultV1 } from "@ailearn/shared";
import { ImageUp } from "lucide-react";
import { SettingRow } from "./settings-primitives.tsx";

export function SettingsAccountPanel(props: {
  readonly profile: AuthProfileResultV1 | null;
  readonly displayName: string;
  /** 账户域那个"正在忙哪一步"，与成员/邀请共用，所以由父层传进来。 */
  readonly busy: string | null;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onSaveDisplayName: () => Promise<void>;
  readonly onUploadAvatar: (file: File) => Promise<void>;
  readonly onClearAvatar: () => Promise<void>;
}): ReactElement {
  const { profile, displayName, busy } = props;
  const setDisplayName = props.onDisplayNameChange;
  const saveDisplayName = props.onSaveDisplayName;
  const uploadAvatar = props.onUploadAvatar;
  const clearAvatar = props.onClearAvatar;
  return (
<div className="settings-block">
  <div className="settings-block__head">
    <div>
      <b>个人档案</b>
      <p>显示名与头像在所有空间通用；清空显示名则只显示邮箱。</p>
    </div>
  </div>
  <div className="settings-field">
    <label className="settings-field__label" htmlFor="settings-display-name">显示名</label>
    <div className="hud-field">
      <input
        id="settings-display-name"
        value={displayName}
        placeholder="最长 32 字"
        maxLength={32}
        disabled={props.busy !== null}
        onChange={(event) => setDisplayName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void saveDisplayName();
        }}
      />
      <button
        type="button"
        className="button primary"
        disabled={props.busy !== null || displayName.trim() === (profile?.displayName ?? "")}
        onClick={() => void saveDisplayName()}
      >
        {props.busy === "displayName" ? "保存中…" : "保存"}
      </button>
    </div>
  </div>
  <div className="settings-rows">
    <SettingRow title="头像" detail="PNG / JPG / WebP / GIF，最大 2MB；上传后立即生效。">
      <label className="button" data-disabled={props.busy !== null ? "true" : undefined} aria-disabled={props.busy !== null}>
        <ImageUp size={13} aria-hidden="true" />
        {props.busy === "avatar" ? "上传中…" : "更换…"}
        <input
          className="settings-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={props.busy !== null}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void uploadAvatar(file);
          }}
        />
      </label>
      {profile?.avatarUrl ? (
        <button type="button" className="button" disabled={props.busy !== null} onClick={() => void clearAvatar()}>
          清除
        </button>
      ) : null}
    </SettingRow>
  </div>
</div>
  );
}
