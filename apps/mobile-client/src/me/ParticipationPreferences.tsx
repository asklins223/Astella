import { useEffect, useRef, useState } from 'react'
import { companionParticipationPreferencesV1Schema, type CompanionParticipationPreferencesV1 } from '@astella/shared/companion-initiative-contracts'
import { COMPANION_DEFAULT_PARTICIPATION } from '@astella/shared'
import { Icon } from '../app/icons.tsx'
import { ApiError, requestJson } from '../platform/api-client.ts'
import { handleUnauthorized, useSession } from '../state/session.ts'

const editingDrafts = new Map<string, string>()

/** 个人约定可独立保存、暂停；刷新版本时保留本地编辑。 */
export function ParticipationPreferences() {
  const me = useSession().me
  const scopeKey = `${me?.userId ?? ''}:${me?.workspaceId ?? ''}`
  const [value, setValue] = useState<CompanionParticipationPreferencesV1 | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | 'toggle' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showDefaults, setShowDefaults] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft

  async function load(preserveDraft = false) {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    const scope = ++generation.current
    setBusy('load')
    setError(null)
    setNotice(null)
    try {
      const result = companionParticipationPreferencesV1Schema.parse(await requestJson('/me/companion/participation', { signal: request.signal }))
      if (scope !== generation.current) return
      setValue(result)
      if (!preserveDraft) {
        const cached = editingDrafts.get(scopeKey)
        setDraft(cached ?? result.markdown)
        if (cached !== undefined && cached !== result.markdown) setNotice('已恢复你尚未保存的编辑。')
      }
      else setNotice('已读取最新约定，你正在编辑的内容仍然保留。')
    } catch (reason) {
      if (scope !== generation.current || request.signal.aborted) return
      if (reason instanceof ApiError && reason.isUnauthorized) handleUnauthorized()
      else setError('相处偏好没有同步成功，请检查连接后重试。')
    } finally {
      if (scope === generation.current) setBusy(null)
    }
  }

  useEffect(() => {
    setValue(null)
    setDraft('')
    setShowSaved(false)
    void load()
    return () => { generation.current += 1; controller.current?.abort() }
  }, [me?.userId, me?.workspaceId])

  async function save(kind: 'save' | 'toggle') {
    if (!value || busy) return
    const request = new AbortController()
    controller.current = request
    const scope = ++generation.current
    const submitted = kind === 'save' ? draftRef.current : value.markdown
    const enabled = kind === 'toggle' ? !value.enabled : value.enabled
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const result = companionParticipationPreferencesV1Schema.parse(await requestJson('/me/companion/participation', {
        method: 'PUT', body: { expectedRevision: value.revision, markdown: submitted, enabled }, signal: request.signal,
      }))
      if (scope !== generation.current) return
      setValue(result)
      if (kind === 'save') { setDraft(result.markdown); editingDrafts.delete(scopeKey) }
      setNotice(kind === 'save' ? '相处偏好已保存。' : result.enabled ? '个人约定已恢复。' : '个人约定已暂停，默认陪伴方式仍然生效。')
    } catch (reason) {
      if (scope !== generation.current || request.signal.aborted) return
      if (reason instanceof ApiError && reason.isUnauthorized) handleUnauthorized()
      else setError(reason instanceof ApiError && reason.status === 409
        ? '另一台设备刚改过约定。读取最新版本后再保存，你写的内容会保留。'
        : '这次没有保存成功，你写的内容还在。请检查连接后重试。')
    } finally {
      if (scope === generation.current) setBusy(null)
    }
  }

  const dirty = Boolean(value && draft !== value.markdown)
  return (
    <section className="utility-group glass settings-group participation-preferences" aria-label="我们怎样相处">
      <h2>我们怎样相处</h2>
      <p>直接写下你希望她怎么陪你学习，或在交流中告诉她。</p>
      <button className="preference-defaults-toggle" type="button" aria-expanded={showDefaults} aria-controls="preference-defaults" onClick={() => setShowDefaults((shown) => !shown)}><span>默认陪伴方式<span>问候、相关页面帮助与久学休息</span></span><Icon name="chevron-down" /></button>
      {showDefaults && <div id="preference-defaults" className="settings-preference-defaults"><ul>{COMPANION_DEFAULT_PARTICIPATION.map((item) => <li key={item.id}><b>{item.title}</b><span>{item.description}</span></li>)}</ul></div>}

      {!value && busy === 'load' ? <p className="preference-load-state" role="status">正在同步你的个人约定…</p> : <>
        <label className="preference-editor" htmlFor="participation-markdown"><span>个人约定{dirty && <small>有未保存的编辑</small>}</span>
          <textarea id="participation-markdown" rows={5} value={draft} maxLength={16_000} placeholder="例如：我遇到难懂的地方时，先举例，再让我试着解释。" disabled={!value || busy !== null} onChange={(event) => { setDraft(event.target.value); if (event.target.value === value?.markdown) editingDrafts.delete(scopeKey); else editingDrafts.set(scopeKey, event.target.value); setNotice(null) }} />
        </label>
        <div className="preference-actions"><button className="primary" type="button" disabled={!value || busy !== null || !dirty} onClick={() => void save('save')}>{busy === 'save' ? '正在保存…' : '保存约定'}</button>
          {value?.markdown && <button className="secondary" type="button" disabled={busy !== null} onClick={() => void save('toggle')}>{busy === 'toggle' ? '正在更新…' : value.enabled ? '暂停个人约定' : '恢复个人约定'}</button>}
        </div>
        {value && <p className="preference-save-state">{value.markdown ? value.enabled ? '个人约定正在生效。' : '个人约定已暂停，默认陪伴方式仍会生效。' : '尚未添加个人约定，默认陪伴方式会照常生效。'}</p>}
        {dirty && value?.markdown && <><button className="text-action preference-saved-toggle" type="button" aria-expanded={showSaved} onClick={() => setShowSaved((shown) => !shown)}>{showSaved ? '收起已保存内容' : '查看已保存内容'}</button>{showSaved && <blockquote className="preference-saved-copy">{value.markdown}</blockquote>}</>}
      </>}
      {notice && <p className="preference-notice" role="status"><Icon name="check" />{notice}</p>}
      {error && <div className="preference-error state-note" role="alert"><p>{error}</p><button type="button" disabled={busy !== null} onClick={() => void load(Boolean(value))}>{busy === 'load' ? '正在读取…' : '重新读取约定'}</button></div>}
    </section>
  )
}
