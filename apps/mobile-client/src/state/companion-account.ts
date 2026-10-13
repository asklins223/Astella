import { companionApi } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { applyAccountMotionPreference } from '../platform/motion.ts'
import { createStore, useStore } from './store.ts'

export interface CompanionAccountState {
  loaded: boolean
  /** 她的执行档：read_only / guided / full。取不到时屏上要说"没读到"，不是猜一个默认值。 */
  permissionLevel: string | null
  error: string | null
}

const store = createStore<CompanionAccountState>({ loaded: false, permissionLevel: null, error: null })
const set = store.set.bind(store)
let requestGeneration = 0

/**
 * 她那一份账号设置。
 *
 * `/me/companion` 回的是一个聚合形状（不同来源嵌在不同层），所以按名字找，
 * 不把某一条嵌套路径写死——写死的代价是"接口一挪，屏上就显示默认档"。
 */
export async function loadCompanionAccount(): Promise<void> {
  const generation = ++requestGeneration
  try {
    const account = await companionApi.account()
    if (generation !== requestGeneration) return
    applyAccountMotionPreference(account)
    set({ loaded: true, permissionLevel: findPermissionLevel(account), error: null })
  } catch (error) {
    if (generation !== requestGeneration) return
    const message = error instanceof ApiError
      ? error.status === 0 ? '连接暂时不可用，请稍后重试。'
        : error.status >= 500 ? '伴星设置暂时不可用，请稍后重试。' : error.message
      : error instanceof Error ? error.message : '她的设置没读到'
    set({ loaded: true, permissionLevel: null, error: message })
  }
}

/** A tenant/account change invalidates both the visible permission and any late response. */
export function resetCompanionAccount(): void {
  requestGeneration += 1
  applyAccountMotionPreference(null)
  set({ loaded: false, permissionLevel: null, error: null })
}

export function useCompanionAccount(): CompanionAccountState {
  return useStore(store)
}

export function permissionLabel(level: string | null): string {
  switch (level) {
    case 'read_only':
      return '只读（她只看，不动手）'
    case 'full':
      return '全自动（她做完再告诉你）'
    case 'guided':
      return '先给你看，你点头才动'
    default:
      return '暂时无法读取权限信息'
  }
}

function findPermissionLevel(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const settings = record.agentSettings
  if (settings && typeof settings === 'object' && typeof (settings as { permissionLevel?: unknown }).permissionLevel === 'string') {
    return (settings as { permissionLevel: string }).permissionLevel
  }
  for (const item of Object.values(record)) {
    const found = findPermissionLevel(item, depth + 1)
    if (found) return found
  }
  return null
}
