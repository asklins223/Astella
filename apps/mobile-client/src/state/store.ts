import { useSyncExternalStore } from 'react'

export interface Store<S extends object> {
  get(): S
  set(patch: Partial<S> | ((current: S) => Partial<S>)): void
  subscribe(listener: () => void): () => void
}

/**
 * 一个最小的外部状态源。
 *
 * 手机端的实时性全压在"同一条流改一份状态"上（增量、提案、笔记回执），
 * 所以这里只要三件事：稳定的快照引用、批量写入只通知一次、订阅即回滚。
 * 引状态库换来的抽象层数，不值这个场景。
 */
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<() => void>()
  let queued = false

  const flush = () => {
    queued = false
    for (const listener of listeners) listener()
  }

  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch
      let changed = false
      for (const [key, value] of Object.entries(next)) {
        if (!Object.is((state as Record<string, unknown>)[key], value)) changed = true
      }
      if (!changed) return
      state = { ...state, ...next }
      // 流式增量会在同一帧里连来多条：合并成一次通知，画面不抖。
      if (listeners.size === 0) return
      if (queued) return
      queued = true
      queueMicrotask(flush)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useStore<S extends object>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
