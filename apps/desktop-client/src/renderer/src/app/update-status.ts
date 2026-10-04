/**
 * 桌面端更新状态（渲染层唯一的一份）。
 *
 * ## 为什么不是一个只活在设置页里的 hook
 *
 * 更新这件事有三个消费方：伴星通知、设置页的角标、设置页里的那组「客户端更新」。
 * 若把订阅放在设置页里，关掉设置页订阅就没了——通知会跟着一起消失，角标也跟着灭。
 * 所以这里用一份 app 级 store：主进程那条 `UPDATE_STATE_CHANNEL` **只订阅一次**，
 * 谁要用谁读，不重复挂监听。
 *
 * 与 `companion-notifications.ts` 是同一种形状（zustand + 单一真相），因为它们
 * 面对的是同一类问题：多方观察、单一写入者。
 */

import { useEffect } from "react";
import { create } from "zustand";

import type { UpdateStateV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta } from "./desktop-client";

/** 没有收到主进程快照之前的占位。`currentVersion` 留空，由界面显示「—」。 */
export const UNKNOWN_UPDATE_STATE: UpdateStateV1 = {
  phase: "idle",
  currentVersion: "",
  availableVersion: null,
  releaseNotes: null,
  releaseUrl: null,
  percent: null,
  transferred: null,
  total: null,
  message: null,
  installBlockedReason: null,
  checkedAt: null,
};

interface UpdateStatusStore {
  readonly state: UpdateStateV1;
  /** 四个动作各自在飞时为 true——界面据此禁用按钮，避免重复点。 */
  readonly checking: boolean;
  readonly downloading: boolean;
  readonly installing: boolean;
  accept(state: UpdateStateV1): void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}

export const useUpdateStatus = create<UpdateStatusStore>((set, get) => ({
  state: UNKNOWN_UPDATE_STATE,
  checking: false,
  downloading: false,
  installing: false,

  accept: state => set({ state }),

  check: async () => {
    if (get().checking) return;
    set({ checking: true });
    try {
      // 用户主动点的「检查更新」：绕过 6 小时缓存立刻联网。
      const result = await window.ailearn.update.check({ meta: createRequestMeta(), userInitiated: true });
      if (result.ok) set({ state: result.data });
    } catch {
      // 主进程那边已经把失败表达成 state（unreachable / failed），这里无需再抛一次。
    } finally {
      set({ checking: false });
    }
  },

  download: async () => {
    if (get().downloading) return;
    set({ downloading: true });
    try {
      const result = await window.ailearn.update.download({ meta: createRequestMeta() });
      if (result.ok) set({ state: result.data });
    } finally {
      set({ downloading: false });
    }
  },

  install: async () => {
    if (get().installing) return;
    set({ installing: true });
    try {
      const result = await window.ailearn.update.install({ meta: createRequestMeta() });
      if (result.ok) set({ state: result.data });
    } finally {
      set({ installing: false });
    }
  },
}));

/**
 * 有没有值得提醒用户的新版本。
 *
 * 只认「拿到包」与「下载中/已就绪」：查不到（`unreachable`）不是新闻，
 * 用户主动点开设置自己会看见，不该由伴星去报。
 */
export function hasActionableUpdate(state: UpdateStateV1): boolean {
  return state.phase === "available" || state.phase === "downloading" || state.phase === "ready";
}

/**
 * 补读一次当前状态。
 *
 * 必须由渲染层做：preload 拿不到 `createRequestMeta()`，而 `requestMetaSchema`
 * 是 strictObject，缺任何一个字段都会被 `readPayload` 判成 invalid_request——
 * 补读静默失败，界面就一直空着，直到主进程下一次推送。
 *
 * 主进程启动时会用上次的结果打底（`primeUpdateStateFromCache`），那一帧不会再推
 * 第二遍，所以**只靠订阅会漏掉「重启后就有一个新版本」**。补的就是这一下。
 */
async function primeUpdateStatus(): Promise<void> {
  try {
    const result = await window.ailearn.update.getState({ meta: createRequestMeta() });
    if (result.ok) useUpdateStatus.getState().accept(result.data.state);
  } catch {
    // 主进程不可用（浏览器预览）时保持 idle 即可，不要抛。
  }
}

/**
 * 主进程那条推送的唯一订阅点。挂在伴星通知中心（见
 * `use-companion-notification-sources.ts`）——那是整块通知机制本来就有的落点，
 * 它的生命周期与窗口一致，所以更新状态不会因为进出设置页而丢。
 */
export function useUpdateStatusSubscription(): void {
  useEffect(() => {
    // `ailearnDesktop` 在浏览器预览（无 preload）下不存在，那里没有主进程。
    const bridge = window.ailearnDesktop;
    if (!bridge) return;
    void primeUpdateStatus();
    return bridge.onUpdateState(state => useUpdateStatus.getState().accept(state));
  }, []);
}