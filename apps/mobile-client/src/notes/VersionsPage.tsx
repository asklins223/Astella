import { useEffect, useState } from 'react'
import { Icon } from '../app/icons.tsx'
import { notesApi } from '../platform/api.ts'
import { useNotes } from '../state/notes.ts'

/**
 * 版本与来处。
 *
 * 手机上正文只能由伴星改，所以"谁改的、改成了什么"必须看得见——
 * 这一屏就是把那条规矩落成一份可回看的账。
 */
export function VersionsPage({ noteId, title }: { noteId: string; title: string }) {
  const reader = useNotes().reader
  const [items, setItems] = useState<Awaited<ReturnType<typeof notesApi.versions>>['items'] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setItems(null)
    setFailed(false)
    notesApi
      .versions(noteId)
      .then((page) => {
        if (alive) setItems(page.items)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [attempt, noteId])

  const currentVersionId = reader?.noteId === noteId ? reader.detail?.currentVersionId : undefined

  return (
    <section className="page-scroll reader-scroll" data-view-key={`history:${noteId}`} aria-label="版本与来处">
      <article className="paper">
        <div className="paper-meta"><Icon name="history" />版本与来处</div>
        <h1>{reader?.title || title}</h1>
        <p className="archive-note">这里按时间列出已保存的版本。正文仍以当前打开的版本为准。</p>
        {failed && (
          <div className="state-note versions-load-error" role="alert">
            <p>版本记录暂时取不到。检查连接后再试。</p>
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>
          </div>
        )}
        {!items && !failed && <p className="archive-note" role="status">正在取这一篇的版本。</p>}
        {items?.map((version) => (
          <div
            className={`history-line${version.id === currentVersionId ? ' current' : ''}`}
            key={version.id}
            data-current={version.id === currentVersionId ? 'true' : 'false'}
          >
            <i aria-hidden="true" />
            <div>
              <strong>第 {version.versionNo} 版{version.id === currentVersionId ? ' · 正在读' : ''}</strong>
              <p>{version.id === currentVersionId ? '当前正文版本' : '已保存的更早版本'}</p>
              <small>{clock(version.createdAt)} · {dayOf(version.createdAt)}</small>
            </div>
          </div>
        ))}
        {items?.length === 0 && <p className="archive-note">目前没有可查看的历史版本。</p>}
        {!failed && items?.length ? <p className="note-end">
          对象身份 <i className="artifact-id">{noteId.slice(0, 8)}</i>
          <br />
          手机端不提供直接编辑正文；需要调整时，在对话里告诉伴星。
        </p> : null}
        {!failed && items && items.length > 0 && <p className="change-label"><Icon name="check" />共 {items.length} 个已保存版本</p>}
      </article>
    </section>
  )
}

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function dayOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}
