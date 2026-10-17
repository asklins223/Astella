import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron'

export type NativeTitleBarTheme = 'day' | 'night'

/** 原生窗口自己的背板颜色；首帧之前用户看到的就是它。 */
const opaqueWindowBackdrop = '#211914'
/** 逐像素透明的窗口必须给出全透明底色，否则 Electron 先用不透明底色闪一下。 */
const transparentWindowBackdrop = '#00000000'

export function titleBarOverlayForTheme(theme: NativeTitleBarTheme): TitleBarOverlay {
  return {
    color: '#00000000',
    symbolColor: theme === 'day' ? '#33251d' : '#f6ead7',
    height: 40
  }
}

export function nativeWindowChrome(
  platform: NodeJS.Platform
): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'titleBarOverlay' | 'transparent' | 'hasShadow' | 'backgroundColor'> {
  if (platform === 'darwin') {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset',
      backgroundColor: opaqueWindowBackdrop
    }
  }

  if (platform === 'win32') {
    // Win10 的 DWM 不给窗口倒角，只有无边框 + 逐像素透明才画得出反锯齿圆角；
    // 代价是标题按钮不再由系统画，渲染层要自己接（见 components/hud/window-caption.tsx）。
    // 阴影按矩形算，留着会在四个圆角后面露出一圈直边。
    return {
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: transparentWindowBackdrop
    }
  }

  return {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTheme('day'),
    backgroundColor: opaqueWindowBackdrop
  }
}
