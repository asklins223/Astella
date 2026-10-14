import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { SOURCE_IMAGE_MIME_TYPES } from '@astella/shared/source-image-contracts'
import { Icon } from '../app/icons.tsx'
import { push } from '../app/nav.ts'
import { companionLine } from '../conversation/status-line.ts'
import { useCompanion } from '../state/companion.ts'
import { loadCompanionAccount, permissionLabel, useCompanionAccount } from '../state/companion-account.ts'
import { signOut, updateMyProfile, uploadMyAvatar, useSession } from '../state/session.ts'
import { ApiError, requestBlob } from '../platform/api-client.ts'
import { getToken } from '../platform/credentials.ts'
import { handleUnauthorized } from '../state/session.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { closeSheet, openSheet, originOf, requestSheetClose } from '../ui/sheet-store.ts'

const MAX_AVATAR_BYTES = 10 * 1024 * 1024

/**
 * 个人中心。
 *
 * 账号身份、可保存的资料与伴星中心入口保持各自的阅读重心。
 * 编辑表单独占整行，保存后就地反馈；退出前保留一次明确选择。
 */
export function ProfilePage() {
  const session = useSession()
  const account = useCompanionAccount()
  const root = usePhoneRoot()
  const line = companionLine(useCompanion())
  const filePicker = useRef<HTMLInputElement>(null)
  const nameTrigger = useRef<HTMLButtonElement>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(session.me?.displayName ?? '')
  const [busy, setBusy] = useState<'name' | 'avatar' | 'signout' | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void loadCompanionAccount()
  }, [session.me?.userId, session.me?.workspaceId])

  const me = session.me
  const displayName = me?.displayName?.trim() ?? ''

  useEffect(() => {
    setNameDraft(displayName)
    setEditingName(false)
    setProfileError(null)
  }, [me?.userId, displayName])

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !me) return
    const value = nameDraft.trim()
    if (value.length > 32) {
      setProfileError('称呼最多 32 个字。')
      return
    }
    setBusy('name')
    setProfileError(null)
    setNotice(null)
    try {
      await updateMyProfile({ displayName: value || null })
      setEditingName(false)
      setNotice(value ? '称呼已保存。' : '已改为显示邮箱。')
      window.requestAnimationFrame(() => nameTrigger.current?.focus({ preventScroll: true }))
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        return
      }
      setProfileError(profileErrorMessage(error, '称呼没有保存，输入内容还在。'))
    } finally {
      setBusy(null)
    }
  }

  async function chooseAvatar(file: File | undefined) {
    if (!file || busy) return
    setProfileError(null)
    setNotice(null)
    if (!SOURCE_IMAGE_MIME_TYPES.includes(file.type as typeof SOURCE_IMAGE_MIME_TYPES[number])) {
      setProfileError('暂不支持这种图片，请选 PNG、JPG、GIF 或 WebP。')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileError('头像不能超过 10 MB，请换一张小一点的。')
      return
    }
    setBusy('avatar')
    try {
      await uploadMyAvatar(file)
      setNotice('头像已更新。')
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        return
      }
      setProfileError(profileErrorMessage(error, '头像没有上传成功，可以重新选择后再试。'))
    } finally {
      setBusy(null)
    }
  }

  function confirmSignOut(event: MouseEvent<HTMLButtonElement>) {
    if (busy) return
    openSheet({
      kind: 'signout', title: '退出这台设备？', variant: 'paper', trigger: event.currentTarget,
      origin: originOf(event.currentTarget, root),
      children: <div className="profile-signout-panel">
        <p>下次使用需要重新登录。保存在书房的手记和对话会留在账号里。</p>
        <button type="button" className="primary" onClick={() => {
          closeSheet({ restoreFocus: false })
          setBusy('signout')
          void signOut().finally(() => setBusy(null))
        }}>退出登录</button>
        <button type="button" className="secondary" onClick={requestSheetClose}>继续使用</button>
      </div>,
    })
  }

  return (
    <section className="page-scroll" data-view-key="profile" aria-label="个人中心">
      <div className="utility-page profile-page">
        <div className="profile-card glass">
          <div className="profile-card-top"><span className="utility-eyebrow">我的随身书房</span></div>
          <div className="profile-heading">
            <button className="account-avatar profile-avatar-button" type="button" aria-label="更换头像" disabled={busy !== null} onClick={() => filePicker.current?.click()}>
              {me?.avatarUrl
                ? <ProfileAvatar url={me.avatarUrl} fallback={avatarInitial(displayName, me.email)} />
                : avatarInitial(displayName, me?.email)}
              <span>{busy === 'avatar' ? '上传中' : '换头像'}</span>
            </button>
            <div>
              <h1>{displayName || '我的账号'}</h1>
              <p>{me?.email}</p>
              {!editingName && (
                <button ref={nameTrigger} className="edit-profile-link profile-name-edit" type="button" disabled={busy !== null} onClick={() => { setNameDraft(displayName); setEditingName(true); setProfileError(null); setNotice(null) }}>
                  <Icon name="pencil" />
                  {displayName ? '修改称呼' : '设置称呼'}
                </button>
              )}
              <span className="account-device"><Icon name="monitor" />手机与桌面 · 同一账号</span>
            </div>
          </div>
          {editingName && <form className="profile-name-form" onSubmit={(event) => void saveName(event)}>
            <label htmlFor="profile-display-name">你的称呼 <small>{nameDraft.length} / 32</small></label>
            <input id="profile-display-name" autoFocus maxLength={32} value={nameDraft} placeholder="留空时显示邮箱" autoComplete="nickname" enterKeyHint="done" disabled={busy !== null} onChange={(event) => setNameDraft(event.currentTarget.value)} />
            <div>
              <button type="button" disabled={busy !== null} onClick={() => {
                setNameDraft(displayName); setEditingName(false); setProfileError(null)
                window.requestAnimationFrame(() => nameTrigger.current?.focus({ preventScroll: true }))
              }}>取消</button>
              <button type="submit" disabled={busy !== null || nameDraft.trim() === displayName}>{busy === 'name' ? '保存中…' : '保存称呼'}</button>
            </div>
          </form>}
          <input
            ref={filePicker}
            className="visually-hidden"
            type="file"
            accept={SOURCE_IMAGE_MIME_TYPES.join(',')}
            tabIndex={-1}
            aria-hidden="true"
            disabled={busy !== null}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              void chooseAvatar(file)
            }}
          />
          {profileError && <p className="profile-edit-error" role="alert">{profileError}</p>}
          {notice && <p className="profile-edit-notice" role="status"><Icon name="check" />{notice}</p>}
        </div>

        <button className="account-link glass" type="button" onClick={(event) => push({ kind: 'companion' }, event.currentTarget)} aria-label="进入伴星中心" data-focus-key="profile:companion">
          <span className="portrait">
            <img src="/assets/companion-static.png" alt="蓝发伴星的完整半身形象" />
          </span>
          <span>
            <small>你的学习搭档</small>
            <strong>{line}</strong>
            <em>看看她记得什么，继续你们的学习。</em>
          </span>
          <i className="card-arrow"><Icon name="arrow-right" /></i>
        </button>

        <p className="group-label">账号与日常使用</p>
        <div className="utility-group account-options glass">
          <button className="sheet-row" type="button" onClick={(event) => push({ kind: 'settings' }, event.currentTarget)} data-focus-key="profile:settings">
            <Icon name="settings-2" />
            <span>
              使用设置
              <small>字号、对话显示与动效</small>
            </span>
            <Icon name="chevron-right" />
          </button>
        </div>
        <div className="readonly-field glass">
          <span className="readonly-field-icon"><Icon name="shield" /></span>
          <span className="readonly-field-copy">
            <span>伴星操作权限</span>
            <strong>{!account.loaded ? '正在读取…' : account.error ? '暂时无法读取' : permissionLabel(account.permissionLevel)}</strong>
          </span>
          {account.error && (
            <div className="account-read-error" role="status">
              <small>连接失败，权限状态暂时不可用。</small>
              <button type="button" onClick={() => void loadCompanionAccount()}>重试</button>
            </div>
          )}
        </div>

        <button className="logout-link" type="button" disabled={busy !== null} onClick={confirmSignOut}>
          <Icon name="log-out" />
          {busy === 'signout' ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </section>
  )
}

function avatarInitial(displayName: string, email: string | undefined): string {
  return Array.from(displayName)[0] || email?.slice(0, 1).toUpperCase() || '阅'
}

function avatarObjectKey(url: string): string | null {
  const match = /^\/api\/uploads\/(avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp))$/i.exec(url)
  return match?.[1] ?? null
}

function ProfileAvatar({ url, fallback }: { url: string; fallback: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const objectKey = avatarObjectKey(url)
    if (!objectKey) {
      setSrc(null)
      setFailed(true)
      return
    }
    const controller = new AbortController()
    const token = getToken()
    let active = true
    let objectUrl: string | null = null
    setSrc(null)
    setFailed(false)
    requestBlob(`/uploads/${objectKey}`, { signal: controller.signal })
      .then((blob) => {
        const mimeType = blob.type.split(';', 1)[0]?.trim().toLowerCase()
        if (!SOURCE_IMAGE_MIME_TYPES.includes(mimeType as typeof SOURCE_IMAGE_MIME_TYPES[number])) {
          throw new Error('头像格式不受支持。')
        }
        objectUrl = URL.createObjectURL(blob)
        if (active) setSrc(objectUrl)
        else URL.revokeObjectURL(objectUrl)
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted && getToken() === token && error instanceof ApiError && error.isUnauthorized) {
          handleUnauthorized()
        }
        if (active && !controller.signal.aborted) setFailed(true)
      })
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  return src
    ? <img src={src} alt="个人头像" onError={() => { setSrc(null); setFailed(true) }} />
    : <span aria-label={failed ? '头像暂时无法显示' : '正在加载头像'}>{fallback}</span>
}

function profileErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return '图片超过 10 MB，请换一张小一点的。'
    if (error.status === 415) return '图片格式暂不支持，请选 PNG、JPG、GIF 或 WebP。'
    if (error.status === 429) return '操作太频繁了，请稍后再试。'
    if (error.status >= 500) return '服务暂时不可用，请稍后重试。'
    return error.message || fallback
  }
  return fallback
}
