import { useStore } from '../state/store.ts'
import { createStore } from '../state/store.ts'

export interface MotionState {
  systemCalm: boolean
  accountOff: boolean
  /** 这一台设备上"减少动效"：浏览器里读得到系统设置，但 WebView 与桌面壳里不一定，所以给一枚自己开关。 */
  localOff: boolean
  off: boolean
}

const KEY = 'astella-mobile-motion-off'
const motionStore = createStore<MotionState>({ systemCalm: false, accountOff: false, localOff: false, off: false })

function apply(systemCalm: boolean, accountOff: boolean, localOff: boolean): void {
  motionStore.set({ systemCalm, accountOff, localOff, off: systemCalm || accountOff || localOff })
}

function readLocal(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
apply(query?.matches ?? false, false, readLocal())
query?.addEventListener?.('change', (event) => apply(event.matches, motionStore.get().accountOff, motionStore.get().localOff))

export function setLocalMotionOff(off: boolean): void {
  try {
    localStorage.setItem(KEY, off ? '1' : '0')
  } catch {
    /* 写不进去也先让这一次会话生效 */
  }
  apply(motionStore.get().systemCalm, motionStore.get().accountOff, off)
}

/**
 * `/me/companion` 里带着她自己的动画开关（`animationOff`）。
 * 聚合形状不止一层，所以按名字找，而不是把某个嵌套路径写死。
 */
export function applyAccountMotionPreference(account: unknown): void {
  apply(motionStore.get().systemCalm, findAnimationOff(account), motionStore.get().localOff)
}

function findAnimationOff(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.animationOff === 'boolean') return record.animationOff
  return Object.values(record).some((item) => findAnimationOff(item, depth + 1))
}

export function useMotion(): MotionState {
  return useStore(motionStore)
}
