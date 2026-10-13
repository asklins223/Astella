import { createStore, useStore } from './store.ts'
import { transitionCurrentPage } from '../app/nav.ts'

export type ChatLayout = 'scene' | 'history'

export interface PrefsState {
  /** 打开对话时先见到她，还是先见到记录。两种视图共用同一段交流。 */
  chatLayout: ChatLayout
  /** 阅读字号：落在 `.phone` 的 `--text-scale` 上，demo 的每一处 `calc(px * var(--text-scale))` 都跟着走。 */
  textScale: number
}

const SCALES = [1, 1.25, 1.5]
const KEY = 'astella-mobile-prefs'

const store = createStore<PrefsState>({ chatLayout: 'scene', textScale: 1 })
const set = store.set.bind(store)

/**
 * 偏好按账号存在本机。
 *
 * 服务端那一侧的账号偏好（她的名字、表达、权限）是另一个域；这一份只管"这台设备看着舒不舒服"，
 * 所以不必等接口，也不会在退出后串到下一个账号上——登录成功后再 `loadFor` 一次。
 */
export function loadFor(userId: string | undefined): void {
  if (!userId) return
  const saved = read()?.[userId]
  const scale = SCALES.includes(saved?.textScale ?? 1) ? (saved?.textScale ?? 1) : 1
  set({ chatLayout: saved?.chatLayout === 'history' ? 'history' : 'scene', textScale: scale })
}

export function setChatLayout(chatLayout: ChatLayout, userId?: string): void {
  const previous = store.get().chatLayout
  if (previous !== chatLayout) {
    transitionCurrentPage(previous === 'scene' ? 'tab-forward' : 'tab-backward')
  }
  set({ chatLayout })
  persist(userId, { chatLayout })
}

export function setTextScale(textScale: number, userId?: string): void {
  if (!SCALES.includes(textScale)) return
  set({ textScale })
  persist(userId, { textScale })
}

export function usePrefs(): PrefsState {
  return useStore(store)
}

export function textScaleOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 1, label: '标准' },
    { value: 1.25, label: '较大' },
    { value: 1.5, label: '大字' },
  ]
}

function persist(userId: string | undefined, patch: Partial<PrefsState>): void {
  if (!userId) return
  const raw = read() ?? {}
  raw[userId] = { ...raw[userId], ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(raw))
  } catch {
    /* 隐私模式下写不进去；这一次会话里偏好仍然生效，只是下次要重选 */
  }
}

function read(): Record<string, Partial<PrefsState>> | null {
  try {
    const value = localStorage.getItem(KEY)
    return value ? (JSON.parse(value) as Record<string, Partial<PrefsState>>) : null
  } catch {
    return null
  }
}
