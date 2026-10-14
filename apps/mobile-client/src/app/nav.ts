import { createStore, useStore } from '../state/store.ts'

/** 一级内容按学习动作分组；个人中心由全局菜单进入，不占一级内容位。 */
export type Tab = 'chat' | 'hand' | 'notes' | 'me'

export type Pushed =
  | { kind: 'reader'; noteId: string; title: string }
  | { kind: 'versions'; noteId: string; title: string }
  | { kind: 'map'; noteId: string }
  | { kind: 'explain'; noteId: string }
  | { kind: 'companion' }
  | { kind: 'settings' }
  | { kind: 'profile' }

export type NavDirection = 'push' | 'pop' | 'tab-forward' | 'tab-backward' | 'none'

export interface NavState {
  tab: Tab
  pushed: Pushed[]
  /** 每次导航都有自己的序号；过期动画不能结束后来那次导航。 */
  transitionId: number
  /** 方向决定页面进出；一级分区保持自己的前后顺序。 */
  direction: NavDirection
}

export const navStore = createStore<NavState>({ tab: 'chat', pushed: [], transitionId: 0, direction: 'none' })

const get = navStore.get.bind(navStore)
const set = navStore.set.bind(navStore)
let captureTransition: ((id: number, direction: NavDirection, origin?: HTMLElement | null) => void) | null = null

export function registerTransitionCapture(capture: (id: number, direction: NavDirection, origin?: HTMLElement | null) => void): () => void {
  captureTransition = capture
  return () => {
    if (captureTransition === capture) captureTransition = null
  }
}

function navigate(patch: Pick<NavState, 'tab' | 'pushed'>, direction: NavDirection, origin?: HTMLElement | null): void {
  const transitionId = get().transitionId + 1
  if (direction !== 'none') captureTransition?.(transitionId, direction, origin)
  set({ ...patch, transitionId, direction })
}

export function finishTransition(transitionId: number): void {
  if (get().transitionId === transitionId) set({ direction: 'none' })
}

export function goTab(tab: Tab): void {
  const current = get()
  if (current.tab === tab && current.pushed.length === 0) return
  const direction = tabDirection(current.tab, tab, current.pushed.length > 0)
  navigate({ tab, pushed: [] }, direction)
}

/** 同一分区内的主视图变化（例如伴星场景 ↔ 对话记录）沿用同一套进出动画。 */
export function transitionCurrentPage(direction: 'tab-forward' | 'tab-backward'): void {
  const current = get()
  if (current.tab !== 'chat' || current.pushed.length > 0) return
  navigate({ tab: current.tab, pushed: current.pushed }, direction)
}

export function push(route: Pushed, origin?: HTMLElement | null): void {
  const same = (item: Pushed) =>
    item.kind === route.kind && ('noteId' in item ? 'noteId' in route && item.noteId === route.noteId : true)
  const current = get()
  const existingIndex = current.pushed.findIndex(same)
  if (existingIndex === current.pushed.length - 1 && existingIndex >= 0) return
  if (existingIndex >= 0) {
    navigate({ tab: current.tab, pushed: current.pushed.slice(0, existingIndex + 1) }, 'pop', origin)
    return
  }
  navigate({ tab: current.tab, pushed: [...current.pushed, route] }, 'push', origin)
}

export function pop(): void {
  const pushed = get().pushed
  if (pushed.length === 0) return
  navigate({ tab: get().tab, pushed: pushed.slice(0, -1) }, 'pop')
}

function tabDirection(from: Tab, to: Tab, leavingDetail: boolean): NavDirection {
  if (to === 'me' && from !== 'me') return 'push'
  if (from === 'me' && to !== 'me') return 'pop'
  if (leavingDetail && from === to) return 'pop'
  const order: Tab[] = ['chat', 'hand', 'notes']
  const fromIndex = order.indexOf(from)
  const toIndex = order.indexOf(to)
  if (fromIndex < 0 || toIndex < 0) return toIndex < 0 ? 'push' : 'pop'
  return toIndex > fromIndex ? 'tab-forward' : 'tab-backward'
}

export function top(): Pushed | null {
  const pushed = get().pushed
  return pushed[pushed.length - 1] ?? null
}

export function useNav(): NavState {
  return useStore(navStore)
}
