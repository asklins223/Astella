import type { AILearnWindowState } from '../shared/window-state'
import type { AILearnDesktopApiM2, UpdateStateV1 } from '@ailearn/shared/desktop-ipc-contracts'

export type { AILearnWindowState } from '../shared/window-state'
export type { AILearnDesktopApiM1, AILearnDesktopApiM2, UpdateStateV1 } from '@ailearn/shared/desktop-ipc-contracts'

export interface AILearnDesktopApi {
  readonly platform: string
  setTitleBarTheme: (theme: 'day' | 'night') => void
  onWindowState: (listener: (state: AILearnWindowState) => void) => () => void
  /** 主进程推来的更新状态；返回退订函数。 */
  onUpdateState: (listener: (state: UpdateStateV1) => void) => () => void
}

declare global {
  interface Window {
    ailearnDesktop: AILearnDesktopApi
    ailearn: AILearnDesktopApiM2
  }
}
