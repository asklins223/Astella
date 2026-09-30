export const WINDOW_STATE_CHANNEL = 'window:state-changed'
export const WINDOW_STATE_SNAPSHOT_CHANNEL = 'window:get-state'

/**
 * 标题栏主题（2026-09-30，B6）。原先 `main/index.ts` 与 `preload/index.ts`
 **各写一份字面量**——两边拼错一处不会报任何类型错，只在用户点「跟随系统」
 * 时安静地什么都不发生。窗口那两条通道早就收在这里了，这一条漏了。
 */
export const TITLE_BAR_THEME_CHANNEL = 'window:set-titlebar-theme'

export type AILearnWindowState = 'visible' | 'hidden' | 'minimized'

export interface WindowStateSnapshot {
  readonly state: AILearnWindowState
  readonly revision: number
}

/**
 * 「她该不该停下来」只看**看不看得见**，不看焦点。
 *
 * 旧口径把"未聚焦"算成 hidden（`visible && focused`）。代价落在最常见的两种摆放上：
 * 副屏、并排窗口——恰恰是用户最容易正看着她的时刻——她一动不动、也不再朗读，
 * 而"她在听"那颗照常亮着（方案 35 E7）。真正该停的三种都由系统事件给：最小化、
 * 隐藏（Cmd+H / 关到托盘）、被完全遮挡（Chromium 自己会把 occluded 报成 `document.hidden`）。
 * 所以 `focused` 这个输入整个消失了：留着它，下一个读代码的人还会以为焦点是判据。
 */
export function resolveWindowState(input: {
  readonly minimized: boolean
  readonly visible: boolean
}): AILearnWindowState {
  if (input.minimized) return 'minimized'
  return input.visible ? 'visible' : 'hidden'
}

export function isWindowStateSnapshot(value: unknown): value is WindowStateSnapshot {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<WindowStateSnapshot>

  return (
    (candidate.state === 'visible' ||
      candidate.state === 'hidden' ||
      candidate.state === 'minimized') &&
    Number.isSafeInteger(candidate.revision) &&
    typeof candidate.revision === 'number' &&
    candidate.revision >= 0
  )
}
