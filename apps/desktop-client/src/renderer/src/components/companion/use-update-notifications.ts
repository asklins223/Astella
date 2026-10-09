import { useEffect, useRef } from "react";

import type { UpdateStateV1 } from "@astella/shared/desktop-ipc-contracts";
import { useUpdateStatus, useUpdateStatusSubscription } from "../../app/update-status";
import {
  notifyUpdateAvailable,
  notifyUpdateDownloading,
  notifyUpdateFailed,
  notifyUpdateReady,
  notifyUpdateInstalled,
} from "./update-notifications";

/**
 * 把主进程推来的更新状态翻译成伴星通知。
 *
 * ## 只对"值得打扰"的状态发声
 *
 * `checking` / `upToDate` / `unreachable` 一律不通知——用户没在等结果，
 * 而"这次没问到版本"更不该以坏消息的形式出现（它多半是 GitHub 的匿名查询限额）。
 * 用户自己点「检查更新」时，界面已经就在他眼前，也不需要伴星再报一遍。
 *
 * ## 失败要分清是"查"失败还是"装"失败
 *
 * 只有用户**已经点过下载或安装**之后才报 failed。否则一次网络抖动就会换来一条
 * "这次更新没能完成"，而实际上什么都没开始做。
 */
export function useUpdateNotifications(): void {
  // 订阅挂在这里：伴星通知中心的生命周期与窗口一致，所以更新状态不会因为
  // 进出设置页而丢失（放在设置页里的订阅会随设置页卸载）。
  useUpdateStatusSubscription();

  const previous = useRef<string | null>(null);
  useEffect(() => {
    const react = (state: UpdateStateV1): void => {
      // A startup receipt is independent of check/download phase changes.
      if (state.installedUpdate) notifyUpdateInstalled(state);
      const phase = state.phase;
      if (phase === "downloading") { notifyUpdateDownloading(state); previous.current = phase; return; }
      if (phase === previous.current) return;
      previous.current = phase;
      if (phase === "available" && state.availableVersion !== state.currentVersion) notifyUpdateAvailable(state);
      else if (phase === "ready") notifyUpdateReady(state);
      else if (phase === "failed" && state.message) notifyUpdateFailed(state);
    };
    // 先补一次当前状态：主进程启动时会用上一次的缓存打底，那一帧不会再推第二遍，
    // 只靠 subscribe 会漏掉"重启后直接就有一个新版本"这件事。
    react(useUpdateStatus.getState().state);
    // 注意这里订的是 store，不是 hook——`useUpdateStatus(...)` 必须留在组件体里
    // 调用，套在 useEffect 回调里会触发 "Invalid hook call"。
    return useUpdateStatus.subscribe(store => react(store.state));
  }, []);
}
