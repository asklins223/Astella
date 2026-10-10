import { describe, expect, it } from 'vitest'
import { nativeWindowChrome, titleBarOverlayForTheme } from '../window-chrome'

describe('native window chrome', () => {
  it('keeps the macOS traffic lights over full-size content', () => {
    expect(nativeWindowChrome('darwin')).toEqual({
      frame: true,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#211914'
    })
  })

  it('gives Windows a frameless per-pixel transparent window so the sheet can be rounded', () => {
    // Win10 的 DWM 不给窗口倒角：只有无边框 + 逐像素透明才画得出反锯齿圆角，
    // 代价是标题按钮改由渲染层自绘（components/hud/window-caption.tsx）。
    expect(nativeWindowChrome('win32')).toEqual({
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000'
    })
  })

  it('keeps the Linux native caption buttons in a transparent overlay', () => {
    expect(nativeWindowChrome('linux')).toEqual({
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#33251d',
        height: 40
      },
      backgroundColor: '#211914'
    })
  })

  it('keeps native symbols legible in both room themes', () => {
    expect(titleBarOverlayForTheme('day').symbolColor).toBe('#33251d')
    expect(titleBarOverlayForTheme('night').symbolColor).toBe('#f6ead7')
  })

  it('makes the window backdrop the transparent one only where the window is transparent', () => {
    // 不透明窗口给了 alpha 底色会在首帧前闪一下桌面；透明窗口反过来会用实色堵死圆角。
    expect(nativeWindowChrome('win32').backgroundColor).toBe('#00000000')
    expect(nativeWindowChrome('darwin').backgroundColor).not.toBe('#00000000')
    expect(nativeWindowChrome('linux').backgroundColor).not.toBe('#00000000')
  })
})
