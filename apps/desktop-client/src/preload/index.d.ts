import type { AstellaWindowState } from '../shared/window-state'
import type { AstellaDesktopApiM2, UpdateStateV1 } from '@astella/shared/desktop-ipc-contracts'

export type { AstellaWindowState } from '../shared/window-state'
export type { AstellaDesktopApiM1, AstellaDesktopApiM2, UpdateStateV1 } from '@astella/shared/desktop-ipc-contracts'

export interface AstellaDesktopApi {
  readonly platform: string
  setTitleBarTheme: (theme: 'day' | 'night') => void
  onWindowState: (listener: (state: AstellaWindowState) => void) => () => void
  /** 主进程推来的更新状态；返回退订函数。 */
  onUpdateState: (listener: (state: UpdateStateV1) => void) => () => void
}

declare global {
  interface Window {
    astellaDesktop: AstellaDesktopApi
    astella: AstellaDesktopApiM2
  }
}
