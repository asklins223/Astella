import { describe, expect, it } from 'vitest'
import { isWindowFrameSnapshot, resolveWindowFrame } from '../window-frame'

describe('window card shape', () => {
  it('只有悬浮算卡片，最大化就收直角', () => {
    expect(resolveWindowFrame({ fullscreen: false, maximized: false })).toBe('floating')
    expect(resolveWindowFrame({ fullscreen: false, maximized: true })).toBe('maximized')
  })

  it('全屏压过最大化：两种铺满场合不必再排先后', () => {
    expect(resolveWindowFrame({ fullscreen: true, maximized: true })).toBe('fullscreen')
  })

  it('通道快照只认这三档', () => {
    expect(isWindowFrameSnapshot({ frame: 'maximized', revision: 1 })).toBe(true)
    expect(isWindowFrameSnapshot({ frame: 'hidden', revision: 1 })).toBe(false)
    expect(isWindowFrameSnapshot({ frame: 'floating', revision: -1 })).toBe(false)
    expect(isWindowFrameSnapshot(null)).toBe(false)
  })
})
