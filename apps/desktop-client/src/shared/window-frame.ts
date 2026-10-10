export const WINDOW_FRAME_CHANNEL = 'window:frame-changed'
export const WINDOW_FRAME_SNAPSHOT_CHANNEL = 'window:get-frame'
export const WINDOW_CONTROL_CHANNEL = 'window:control'

export type AstellaWindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type AstellaWindowFrame = 'floating' | 'maximized' | 'fullscreen'

export interface WindowFrameSnapshot {
  readonly frame: AstellaWindowFrame
  readonly revision: number
}

/**
 * 纸面卡片只在悬浮时有圆角：最大化或全屏后卡片铺满整块屏幕，
 * 还留半径就会在四个角露出桌面，并把贴边的内容裁掉一截。
 */
export function resolveWindowFrame(input: {
  readonly fullscreen: boolean
  readonly maximized: boolean
}): AstellaWindowFrame {
  if (input.fullscreen) return 'fullscreen'
  return input.maximized ? 'maximized' : 'floating'
}

const frames: readonly AstellaWindowFrame[] = ['floating', 'maximized', 'fullscreen']

export function isWindowAction(value: unknown): value is AstellaWindowAction {
  return value === 'minimize' || value === 'toggle-maximize' || value === 'close'
}

export function isWindowFrameSnapshot(value: unknown): value is WindowFrameSnapshot {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<WindowFrameSnapshot>

  return frames.includes(candidate.frame as AstellaWindowFrame)
    && typeof candidate.revision === 'number'
    && Number.isInteger(candidate.revision)
    && candidate.revision >= 0
}
