import { createStore, useStore } from '../state/store.ts'
import { localRect } from '../platform/geometry.ts'
import type { SheetSpec } from '../ui/sheet.tsx'

const store = createStore<{ sheet: SheetSpec | null }>({ sheet: null })
const set = store.set.bind(store)
const get = store.get.bind(store)
let focusReturnTarget: HTMLElement | null = null
let dismissCurrentSheet: (() => void) | null = null

export function openSheet(sheet: SheetSpec): void {
  if (!get().sheet) {
    const active = document.activeElement
    focusReturnTarget = sheet.trigger ?? (active instanceof HTMLElement ? active : null)
  }
  set({ sheet })
}

export function closeSheet({ restoreFocus = true }: { restoreFocus?: boolean } = {}): void {
  const target = focusReturnTarget ?? get().sheet?.trigger ?? null
  focusReturnTarget = null
  set({ sheet: null })
  if (restoreFocus && target) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true })
    }))
  }
}

/** Let a sheet finish its own close motion before the shared sheet is removed. */
export function registerSheetDismiss(dismiss: () => void): () => void {
  dismissCurrentSheet = dismiss
  return () => {
    if (dismissCurrentSheet === dismiss) dismissCurrentSheet = null
  }
}

export function requestSheetClose(): void {
  if (dismissCurrentSheet) dismissCurrentSheet()
  else closeSheet()
}

export function useSheet(): SheetSpec | null {
  return useStore(store).sheet
}

/** 触发它的那一枚在整屏坐标系里的位置——面板要长在这一处，不是屏幕正中。 */
export function originOf(node: EventTarget | null, root: HTMLElement | null) {
  const element = node instanceof Element ? node.closest<HTMLElement>('[data-sheet-origin]') ?? (node as HTMLElement) : null
  if (!element || !root) return { x: (root?.clientWidth ?? 0) / 2 - 22, y: (root?.clientHeight ?? 0) - 80, width: 44, height: 44 }
  return localRect(element.getBoundingClientRect(), root.getBoundingClientRect())
}
