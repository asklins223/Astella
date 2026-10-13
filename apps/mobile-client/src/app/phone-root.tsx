import { createContext, useContext } from 'react'

/**
 * `.phone` 那一层。
 *
 * 面板几何、伴星画布的位置、开屏的覆层都以整屏那一个盒子为坐标系，
 * 所以把它交给需要的组件，而不是各处 `document.querySelector`（换一屏就找错）。
 */
export const PhoneRootContext = createContext<HTMLElement | null>(null)

export function usePhoneRoot(): HTMLElement | null {
  return useContext(PhoneRootContext)
}
