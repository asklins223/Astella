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
 * 头像自 2026-10-06 起先过取景框（`avatar-crop-dialog.tsx`）再上传：`onUploadAvatar`
 * 收到的已经是裁剪产物，返回上传结果——取景框要等它落定，网慢时那段时间里不能
 * 让人觉得"点了没反应"（对话框留在原地显示「正在上传…」）。
 *
 * 判据见 `AGENTS.md` §工程结构与分层：单函数超过 400 行或 hook 超过 25 个就是信号。
 */
import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { AuthProfileResultV1 } from "@ailearn/shared";
import { ImageUp } from "lucide-react";
import { SettingRow } from "./settings-primitives.tsx";
import { AvatarCropDialog } from "./avatar-crop-dialog.tsx";

/** 上传结果：失败时 `message` 是给人看的一句话，取景框就地显示它。 */
export type AvatarUploadOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export function SettingsAccountPanel(props: {
  readonly profile: AuthProfileResultV1 | null;
  readonly displayName: string;
  /** 账户域那个"正在忙哪一步"，与成员/邀请共用，所以由父层传进来。 */
  readonly busy: string | null;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onSaveDisplayName: () => Promise<void>;
  readonly onUploadAvatar: (file: File) => Promise<AvatarUploadOutcome>;
  readonly onClearAvatar: () => Promise<void>;
}): ReactElement {
  const { profile, displayName, busy } = props;
  const setDisplayName = props.onDisplayNameChange;
  const saveDisplayName = props.onSaveDisplayName;
  const uploadAvatar = props.onUploadAvatar;
  const clearAvatar = props.onClearAvatar;
  /**
   * 选中的文件先进取景框，确认才上传；取消或关闭把焦点还给"更换…"那颗文件输入，
   * 键盘用户不会掉回页面开头。
   */
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeCropper = (restoreFocus: boolean) => {
    setPendingAvatar(null);
    if (restoreFocus) fileInputRef.current?.focus();
  };
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
        disabled={props.busy !== null || !profile}
        onChange={(event) => setDisplayName(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (busy === null && displayName.trim() !== (profile?.displayName ?? "")) void saveDisplayName();
        }}
      />
      <button
        type="button"
        className="button primary"
        disabled={props.busy !== null || !profile || displayName.trim() === (profile.displayName ?? "")}
        onClick={() => void saveDisplayName()}
      >
        {props.busy === "displayName" ? "保存中…" : "保存"}
      </button>
    </div>
  </div>
  <div className="settings-rows">
    <SettingRow title="头像" detail="PNG / JPG / WebP / GIF；选好后拖动、缩放取景，圆环里就是最终的头像。">
      <label className="button" data-disabled={props.busy !== null || !profile ? "true" : undefined} aria-disabled={props.busy !== null || !profile}>
        <ImageUp size={13} aria-hidden="true" />
        {props.busy === "avatar" ? "上传中…" : "更换…"}
        <input
          ref={fileInputRef}
          className="settings-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={props.busy !== null || !profile}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) setPendingAvatar(file);
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
  {pendingAvatar ? (
    <AvatarCropDialog
      file={pendingAvatar}
      onCancel={() => closeCropper(true)}
      onConfirm={async (cropped) => {
        const outcome = await uploadAvatar(cropped);
        // 成功了才收框（按钮随即被禁用，焦点不还给它）；失败把原因抛回去，
        // 取景框留在原地显示，裁剪结果不丢，可以直接再试。
        if (outcome.ok) {
          closeCropper(false);
          return;
        }
        throw new Error(outcome.message);
      }}
    />
  ) : null}
</div>
  );
}
