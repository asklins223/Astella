/// <reference types="vite/client" />

import type { AstellaWindowState } from "../../shared/window-state";
import type { AstellaWindowAction, AstellaWindowFrame } from "../../shared/window-frame";
import type { AstellaDesktopApiM2, UpdateStateV1 } from "@astella/shared/desktop-ipc-contracts";
import type { DesktopRenderingApi } from "../../shared/desktop-rendering";

type DesktopBridge = {
  platform: string;
  rendering: DesktopRenderingApi;
  setTitleBarTheme: (theme: "day" | "night") => void;
  /** Windows 无边框窗口的自绘标题按钮走这里；其他平台的按钮仍由系统画。 */
  controlWindow: (action: AstellaWindowAction) => void;
  onWindowState: (listener: (state: AstellaWindowState) => void) => () => void;
  /** 卡片形状：悬浮带圆角，最大化与全屏收直角。 */
  onWindowFrame: (listener: (frame: AstellaWindowFrame) => void) => () => void;
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
