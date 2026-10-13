import { useEffect, useState } from 'react'
import { companionParticipationPreferencesV1Schema, type CompanionParticipationPreferencesV1 } from '@astella/shared/companion-initiative-contracts'
import { requestJson } from '../platform/api-client.ts'
import { COMPANION_DEFAULT_PARTICIPATION } from '@astella/shared'
export function ParticipationPreferences() {
  const [value, setValue] = useState<CompanionParticipationPreferencesV1 | null>(null)
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const load = async () => {
    try { const result = companionParticipationPreferencesV1Schema.parse(await requestJson('/me/companion/participation')); setValue(result); setDraft(result.markdown) }
    catch { setError('相处偏好暂时没有同步，请稍后重新打开。') }
  }
  useEffect(() => { void load() }, [])
  const save = async (enabled = value?.enabled ?? true) => {
    if (!value || busy) return
    setBusy(true); setError(null)
    try { setValue(companionParticipationPreferencesV1Schema.parse(await requestJson('/me/companion/participation', {
      method: 'PUT', body: { expectedRevision: value.revision, markdown: draft, enabled },
    }))) } catch { setError('这次没有保存成功，偏好可能刚刚有变化。请重新读取后再改。') }
    finally { setBusy(false) }
  }
  return <section className="utility-group glass settings-group" aria-label="我们怎样相处">
    <h2>我们怎样相处</h2><p>这些是每个账号都自带的相处方式。也可以直接告诉她：“以后每次打开应用都跟我问好”“学久了提醒我走走”，按你的习惯继续调整。</p>
    <div className="settings-preference-defaults" aria-label="默认主动参与方式"><strong>她默认会</strong>
      <ul>{COMPANION_DEFAULT_PARTICIPATION.map(item => <li key={item.id}><b>{item.title}</b><span>{item.description}</span></li>)}</ul>
    </div>
    <label>相处偏好<textarea rows={5} value={draft} maxLength={16_000} disabled={!value || busy} onChange={e => setDraft(e.target.value)} /></label>
    <button type="button" disabled={!value || busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存偏好'}</button>
    {!value?.markdown ? <p>你还没有添加个人约定；上面的默认方式仍会照常生效。</p> : null}
    {value?.markdown ? <button type="button" disabled={busy} onClick={() => void save(!value.enabled)}>{value.enabled ? '暂停主动约定' : '恢复主动约定'}</button> : null}
    {error ? <p role="alert">{error}<button type="button" onClick={() => void load()}>重新读取</button></p> : null}
  </section>
}
