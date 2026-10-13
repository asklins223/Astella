import { useCallback, useEffect, useState } from 'react'
import { Icon } from './icons.tsx'
import { authApi, type WorkspaceInfo } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { activateWorkspace, useSession } from '../state/session.ts'
import { closeSheet } from '../ui/sheet-store.ts'

/** The top bar's workspace pill changes the actual tenant-bound session. */
export function WorkspaceSwitcher() {
  const session = useSession()
  const [items, setItems] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await authApi.workspaces())
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthorized) closeSheet()
      setError(describe(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const select = async (workspace: WorkspaceInfo) => {
    if (switchingId) return
    if (workspace.workspaceId === session.me?.workspaceId) {
      closeSheet()
      return
    }
    setSwitchingId(workspace.workspaceId)
    setError(null)
    try {
      await activateWorkspace(workspace)
      closeSheet()
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthorized) closeSheet()
      setError(describe(cause))
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="workspace-switcher">
      <p className="sheet-copy">手机和桌面会一起切到所选书房。</p>
      {loading && <p className="empty" role="status">正在取你能进入的书房…</p>}
      {error && (
        <div className="workspace-switcher-error" role="status">
          <p>{error}</p>
          {!loading && <button type="button" className="secondary" onClick={() => void load()}>重新加载</button>}
        </div>
      )}
      {!loading && !error && items.length === 0 && <p className="empty">还没有可以进入的书房。</p>}
      {!loading && !error && items.map((workspace) => {
        const current = workspace.workspaceId === session.me?.workspaceId
        const switching = switchingId === workspace.workspaceId
        return (
          <button
            key={workspace.workspaceId}
            className={`sheet-row workspace-row${current ? ' current' : ''}`}
            type="button"
            aria-current={current ? 'true' : undefined}
            disabled={Boolean(switchingId)}
            onClick={() => void select(workspace)}
          >
            <Icon name={workspace.isPersonal ? 'book-open' : 'folder'} />
            <span>
              <strong>{workspace.workspaceName}</strong>
              <small>{workspace.isPersonal ? '个人书房' : '协作书房'} · {roleLabel(workspace.role)}{switching ? ' · 正在切换…' : ''}</small>
            </span>
            <Icon name={current ? 'check' : 'chevron-right'} />
          </button>
        )
      })}
    </div>
  )
}

function roleLabel(role: string): string {
  if (role === 'owner') return '所有者'
  if (role === 'admin') return '管理员'
  if (role === 'member') return '成员'
  return role
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return '连不上服务端，检查网络后再试。'
    if (error.status === 401) return '登录状态已失效，请重新登录。'
    if (error.status === 403 || error.status === 404) return '你已不能进入这个书房，请刷新列表。'
  }
  return '书房暂时没有取到，请稍后重试。'
}
