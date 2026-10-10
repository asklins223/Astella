import type { AstellaWindowState } from '../shared/window-state'
import type { AstellaWindowAction, AstellaWindowFrame } from '../shared/window-frame'
import type { AstellaDesktopApiM2, UpdateStateV1 } from '@astella/shared/desktop-ipc-contracts'
import type { DesktopRenderingApi } from '../shared/desktop-rendering'

export type { AstellaWindowState } from '../shared/window-state'
export type { AstellaWindowAction, AstellaWindowFrame } from '../shared/window-frame'
export type { AstellaDesktopApiM1, AstellaDesktopApiM2, UpdateStateV1 } from '@astella/shared/desktop-ipc-contracts'

export interface AstellaDesktopApi {
  readonly platform: string
  readonly rendering: DesktopRenderingApi
  setTitleBarTheme: (theme: 'day' | 'night') => void
  /** Windows 无边框窗口的自绘标题按钮走这里；其他平台的按钮仍由系统画。 */
  controlWindow: (action: AstellaWindowAction) => void
  onWindowState: (listener: (state: AstellaWindowState) => void) => () => void
  /** 卡片形状：悬浮带圆角，最大化与全屏收直角。 */
  onWindowFrame: (listener: (frame: AstellaWindowFrame) => void) => () => void
  /** 主进程推来的更新状态；返回退订函数。 */
  onUpdateState: (listener: (state: UpdateStateV1) => void) => () => void
}

declare global {
  interface Window {
    astellaDesktop: AstellaDesktopApi
    astella: AstellaDesktopApiM2
  }
}
