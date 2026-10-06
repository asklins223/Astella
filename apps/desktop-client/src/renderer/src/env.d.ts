/// <reference types="vite/client" />

import type { AstellaWindowState } from "../../shared/window-state";
import type { AstellaDesktopApiM2, UpdateStateV1 } from "@astella/shared/desktop-ipc-contracts";

type DesktopBridge = {
  platform: string;
  setTitleBarTheme: (theme: "day" | "night") => void;
  onWindowState: (listener: (state: AstellaWindowState) => void) => () => void;
  /** 更新状态由主进程单方面推送；返回退订函数。 */
  onUpdateState: (listener: (state: UpdateStateV1) => void) => () => void;
};

declare global {
  interface Window {
    astellaDesktop?: DesktopBridge;
    astella: AstellaDesktopApiM2;
  }
}

export {};
