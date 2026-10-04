/// <reference types="vite/client" />

import type { AILearnWindowState } from "../../shared/window-state";
import type { AILearnDesktopApiM2, UpdateStateV1 } from "@ailearn/shared/desktop-ipc-contracts";

type DesktopBridge = {
  platform: string;
  setTitleBarTheme: (theme: "day" | "night") => void;
  onWindowState: (listener: (state: AILearnWindowState) => void) => () => void;
  /** 更新状态由主进程单方面推送；返回退订函数。 */
  onUpdateState: (listener: (state: UpdateStateV1) => void) => () => void;
};

declare global {
  interface Window {
    ailearnDesktop?: DesktopBridge;
    ailearn: AILearnDesktopApiM2;
  }
}

export {};
