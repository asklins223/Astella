import type { UpdateStateV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { notifyCompanion, useCompanionNotifications } from "./companion-notifications";
import { useUpdateStatus } from "../../app/update-status";
import { useRoomStore } from "../../app/room-store";

export const SETTINGS_ATTENTION_UPDATE = "desktop-update";

/**
 * 「去设置里看更新」这一个动作。
 *
 * 与 `openVoiceModelSettings` 同样理由：更新在设置页的「客户端更新」分组，
 * 角标点进去也要落在那一格。两处各写一遍 `open-settings`，迟早有一处忘了
 * 设分区，用户会被丢回设置首页自己找。
 */
export function openUpdateSettings(): void {
  const room = useRoomStore.getState();
  // 「客户端更新」与「导出与归档」并排在**数据与维护**这一格（见 SETTINGS_SECTIONS
  // 的 `management`）。角标与通知都要落到同一格，不能只 invoke("open-settings")
  // 而不设分区——那会把人丢回设置首页自己找。
  room.setSettingsSection("management");
  room.setSettingsAttention(SETTINGS_ATTENTION_UPDATE);
  room.invoke("open-settings");
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * 发现新版本。
 *
 * `kind: "reminder"` 是刻意的：通知中心在静音（专注）模式下只放行 `reminder`
 * 与 `immediate` 两类，别的会被压下去。更新是"不急但别错过"的事——静音时也该
 * 只露一个角标，不该弹成打断。
 *
 * `delivery: "when-idle"`：绝不在用户正做题时抢话。
 */
export function notifyUpdateAvailable(state: UpdateStateV1): void {
  if (!state.availableVersion) return;
  notifyCompanion({
    id: "update-available", kind: "reminder", scope: "device", delivery: "when-idle", repeat: true,
    source: "客户端更新", title: `有新版本 ${state.availableVersion}`,
    body: state.releaseNotes
      ? `${state.releaseNotes}\n\n可以在设置的「客户端更新」里下载，更新从 GitHub 下载，不会打断你现在做的事。`
      : "可以在设置的「客户端更新」里下载，更新从 GitHub 下载，不会打断你现在做的事。",
    audio: { text: `有新版本 ${state.availableVersion}，可以在设置里下载，不会打断你。` },
    snoozable: true,
    actions: [
      { id: "go", label: "去看看", kind: "navigate", run: openUpdateSettings },
      { id: "later", label: "稍后", kind: "cancel" },
    ],
  });
}

/**
 * 下载中。
 *
 * 和语音模型那条一样用**同一条 id + `repeat`**，所以进度是就地更新而不是
 * 每次下 1% 就多一条通知。`progress.percent` 在慢连接下长时间为 0，
 * 所以 label 里带上真实字节数——那是"真的在动"的证据。
 */
export function notifyUpdateDownloading(state: UpdateStateV1): void {
  const id = "update-downloading";
  const label = state.transferred !== null && state.total !== null && state.total > 0
    ? `正在下载 ${state.percent ?? 0}%　${megabytes(state.transferred)} / ${megabytes(state.total)}`
    : `正在下载 ${state.percent ?? 0}%`;
  const progress = { percent: state.percent ?? 0, label };

  if (useCompanionNotifications.getState().items.some(item => item.id === id)) {
    useCompanionNotifications.getState().update(id, { progress });
    return;
  }
  useCompanionNotifications.getState().remove("update-available");
  notifyCompanion({
    id, kind: "reminder", scope: "device", delivery: "when-idle", priority: "normal", repeat: true,
    source: "客户端更新", title: "正在下载新版本", progress,
    body: "下载在后台继续，可以接着学。下完了我会告诉你。",
    actions: [{ id: "go", label: "查看下载", kind: "navigate", run: openUpdateSettings }],
  });
}

export function notifyUpdateReady(state: UpdateStateV1): void {
  useCompanionNotifications.getState().remove("update-downloading");
  useCompanionNotifications.getState().remove("update-available");
  notifyCompanion({
    id: "update-ready", kind: "reminder", scope: "device", priority: "high", repeat: true,
    source: "下载完成", title: "新版本已经下好了",
    body: `装上 ${state.availableVersion ?? "新版本"} 需要重启一下书房。要现在装吗？`,
    audio: { text: "新版本已经下载好了。安装需要重启一下书房。随时可以告诉我。", clip: "task-ready" },
    actions: [
      { id: "install", label: "现在安装", kind: "confirm", run: () => { void useUpdateStatus.getState().install(); } },
      { id: "later", label: "下次再说", kind: "cancel" },
    ],
  });
}

/**
 * 更新失败。
 *
 * 只在**已经点过下载/安装**之后才报（由 hook 判断）。自动检查没问到版本那种
 * `unreachable` 不走这里——那不是"更新坏了"，不该用坏消息的形式打扰人。
 */
export function notifyUpdateFailed(state: UpdateStateV1): void {
  useCompanionNotifications.getState().remove("update-downloading");
  notifyCompanion({
    id: "update-failed", kind: "reminder", scope: "device", priority: "high", repeat: true,
    source: "客户端更新", title: state.installBlockedReason === "macosUnsigned" ? "macOS 需要手动安装" : "这次更新没能完成",
    body: state.installBlockedReason === "macosUnsigned"
      ? "这份安装包没有代码签名，系统不允许书房自己替换自己。到下载页手动装一下就好。"
      : (state.message ?? "可以在设置的「客户端更新」里再试一次。"),
    actions: [{ id: "go", label: "打开更新设置", kind: "navigate", run: openUpdateSettings }],
  });
}