import { ApiError } from '../platform/api-client.ts'
import { authApi, type AuthMe, type WorkspaceInfo } from '../platform/api.ts'
import { clearToken, getToken, saveToken } from '../platform/credentials.ts'
import { createStore, useStore } from './store.ts'

export type SessionStatus = 'unknown' | 'signed_out' | 'restoring' | 'unavailable' | 'ready'

export interface SessionState {
  status: SessionStatus
  me: AuthMe | null
  /** 401 之外的失败（网络、服务端没起来）要说得出原因，不能只显示"登录失败"。 */
  error: string | null
}

export const sessionStore = createStore<SessionState>({ status: 'unknown', me: null, error: null })

/** 会话恢复的上限：过了就当没连上，不给无限期的"正在接上"。 */
const RESTORE_CEILING_MS = 12_000

const get = sessionStore.get.bind(sessionStore)
const set = sessionStore.set.bind(sessionStore)
let authGeneration = 0
let restoreController: AbortController | null = null

function beginSessionRequest(reason: string): AbortController {
  restoreController?.abort(new Error(reason))
  const controller = new AbortController()
  restoreController = controller
  return controller
}

async function loadCurrentUser(controller: AbortController): Promise<AuthMe> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      authApi.me(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error('连接超时，请检查网络后重试。'))
          reject(new ApiError(0, 'restore_timeout', '连接超时，请检查网络后重试。', null))
        }, RESTORE_CEILING_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * 冷启动只做一件事：手里有凭据就先当自己是登录着的。
 *
 * 开屏动画不等这条回包——`/auth/me` 回来后屏已经落位，登录态是**就地换掉**的，
 * 而不是重进一次。功能与焦点不等待动效，也不让动效等待网络。
 */
export async function restoreSession(): Promise<void> {
  const controller = beginSessionRequest('正在用新的请求恢复会话。')
  const generation = ++authGeneration
  if (!getToken()) {
    restoreController = null
    if (generation === authGeneration) set({ status: 'signed_out', me: null, error: null })
    return
  }
  set({ status: 'restoring', error: null })
  try {
    // 恢复不能无限等：fetch 挂住时人会被关在"正在接上"里，所以给这一条一个上限，
    // 到点落到可重试的连接页；只有明确的 401 才清凭据并进入登录。
    const me = await loadCurrentUser(controller)
    if (generation !== authGeneration) return
    set({ status: 'ready', me, error: null })
  } catch (error) {
    if (generation !== authGeneration) return
    if (error instanceof ApiError && error.isUnauthorized) {
      clearToken()
      set({ status: 'signed_out', me: null, error: '登录状态已失效，请重新登录。' })
      return
    }
    set({ status: 'unavailable', me: null, error: messageOf(error) })
  } finally {
    if (restoreController === controller) restoreController = null
  }
}

export async function signInAfterToken(token: string): Promise<void> {
  const controller = beginSessionRequest('登录状态已更新。')
  const generation = ++authGeneration
  saveToken(token)
  set({ status: 'restoring', me: null, error: null })
  try {
    const me = await loadCurrentUser(controller)
    if (generation !== authGeneration) return
    set({ status: 'ready', me, error: null })
  } catch (error) {
    if (generation !== authGeneration) return
    if (error instanceof ApiError && error.isUnauthorized) {
      clearToken()
      set({ status: 'signed_out', me: null, error: '登录状态已失效，请重新登录。' })
    } else {
      // /login 已签发的凭据先保留。若只是 /auth/me 暂时不可达，重连即可继续，
      // 不该让用户重复输入账号密码，也不该把有效 token 静默丢掉。
      set({ status: 'unavailable', me: null, error: messageOf(error) })
    }
    throw error
  } finally {
    if (restoreController === controller) restoreController = null
  }
}

/** 更新当前账号的资料后同步登录态，避免页面保存成功、顶栏仍显示旧名字。 */
export async function updateMyProfile(input: { displayName?: string | null; avatarUrl?: string | null }): Promise<void> {
  const current = get().me
  if (!current) throw new Error('登录状态已经失效，请重新登录。')
  try {
    const profile = await authApi.updateProfile(input)
    const latest = get().me
    if (latest?.userId !== current.userId) return
    set({ me: { ...latest, displayName: profile.displayName ?? '', avatarUrl: profile.avatarUrl } })
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    throw error
  }
}

/** 头像上传由服务端原子更新 users.avatarUrl；这里只同步当前账号的显示态。 */
export async function uploadMyAvatar(file: File): Promise<void> {
  const current = get().me
  if (!current) throw new Error('登录状态已经失效，请重新登录。')
  try {
    const uploaded = await authApi.uploadAvatar(file)
    const latest = get().me
    if (latest?.userId !== current.userId) return
    set({ me: { ...latest, avatarUrl: uploaded.url } })
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    throw error
  }
}

/** Switch tenant only after the server has atomically replaced this session token. */
export async function activateWorkspace(workspace: WorkspaceInfo): Promise<boolean> {
  const current = get().me
  if (!current) throw new Error('登录状态已经失效，请重新登录。')
  if (workspace.workspaceId === current.workspaceId) return false
  const generation = ++authGeneration
  try {
    const result = await authApi.switchWorkspace(workspace.workspaceId)
    if (generation !== authGeneration) return false
    if (result.ctx.userId !== current.userId || result.ctx.workspaceId !== workspace.workspaceId) {
      throw new Error('服务端返回的书房与选择不一致，请重新连接后再试。')
    }
    saveToken(result.token)
    set({
      status: 'ready',
      me: {
        ...current,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        workspaceType: workspace.workspaceType,
        isPersonal: workspace.isPersonal,
        personalWorkspaceId: workspace.isPersonal ? workspace.workspaceId : current.personalWorkspaceId,
        role: result.ctx.membershipRole ?? workspace.role,
        workspaceEpoch: result.ctx.workspaceEpoch,
      },
      error: null,
    })
    return true
  } catch (error) {
    if (generation !== authGeneration) return false
    if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
    throw error
  }
}

export async function signOut(): Promise<void> {
  restoreController?.abort(new Error('正在退出登录。'))
  restoreController = null
  const generation = ++authGeneration
  let logoutError: string | null = null
  try {
    await authApi.logout()
  } catch {
    logoutError = '这台设备已退出，服务端暂时没有收到注销请求。'
  } finally {
    if (generation !== authGeneration) return
    clearToken()
    set({ status: 'signed_out', me: null, error: logoutError })
  }
}

/** 会话被服务端收走（改密、退出所有设备、成员被移出）时，屏上任何请求都会撞 401。 */
export function handleUnauthorized(): void {
  restoreController?.abort(new Error('登录状态已失效。'))
  restoreController = null
  authGeneration += 1
  clearToken()
  set({ status: 'signed_out', me: null, error: '登录已失效，请重新登录。' })
}

export function clearSessionError(): void {
  set({ error: null })
}

export function useSession(): SessionState {
  return useStore(sessionStore)
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return '连接暂时不可用，请检查网络后重试。'
    if (error.status >= 500) return '书房服务暂时不可用，请稍后重试。'
    return error.message
  }
  if (error instanceof TypeError) return '网络连接暂时中断，请检查网络后重试。'
  return error instanceof Error ? error.message : '未知错误'
}
