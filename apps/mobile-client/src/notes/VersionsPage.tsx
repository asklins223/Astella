import { useEffect, useRef, useState } from 'react'
import { Icon } from '../app/icons.tsx'
import { pop } from '../app/nav.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { localRect } from '../platform/geometry.ts'
import { notesApi } from '../platform/api.ts'
import { ApiError } from '../platform/api-client.ts'
import { useNotes, applyRestoredNoteVersion } from '../state/notes.ts'
import { handleUnauthorized } from '../state/session.ts'
import { closeSheet, openSheet, requestSheetClose } from '../ui/sheet-store.ts'

type NoteVersion = Awaited<ReturnType<typeof notesApi.versions>>['items'][number]
const PAGE_SIZE = 100

/** 一条有来有回的保存轨迹：当前正文在前，旧版可以明确切回。 */
export function VersionsPage({ noteId, title }: { noteId: string; title: string }) {
  const root = usePhoneRoot()
  const currentReader = useNotes().reader
  const reader = currentReader?.noteId === noteId ? currentReader : null
  const [items, setItems] = useState<NoteVersion[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const loadMoreGeneration = useRef(0)
  const versionsGeneration = useRef(0)
  const currentVersionId = reader?.detail?.currentVersionId

  useEffect(() => {
    let alive = true
    const generation = ++versionsGeneration.current
    loadMoreGeneration.current += 1
    setFailed(false)
    setMoreFailed(false)
    setLoadingMore(false)
    if (!items) setHasMore(false)
    notesApi
      .versions(noteId, { limit: PAGE_SIZE + 1, offset: 0 })
      .then((page) => {
        if (!alive || generation !== versionsGeneration.current) return
        setItems(page.items.slice(0, PAGE_SIZE))
        setHasMore(page.items.length > PAGE_SIZE)
      })
      .catch((error: unknown) => {
        if (!alive || generation !== versionsGeneration.current) return
        if (alive && error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
        setFailed(true)
      })
    return () => {
      alive = false
      if (versionsGeneration.current === generation) versionsGeneration.current += 1
    }
  }, [attempt, currentVersionId, noteId])

  const currentVersionNo = reader?.detail?.currentVersion.versionNo ?? null
  const canRestore = Boolean(reader?.detail?.permissions.canEdit && reader.detail.permissions.canSave && currentVersionId)
  const ordered = items?.slice().sort((first, second) => second.versionNo - first.versionNo)
  const loadedCount = items?.length ?? 0

  async function loadMore() {
    if (!items || !hasMore || loadingMore) return
    const generation = ++loadMoreGeneration.current
    const offset = items.length
    setLoadingMore(true)
    setMoreFailed(false)
    try {
      const page = await notesApi.versions(noteId, { limit: PAGE_SIZE + 1, offset })
      if (generation !== loadMoreGeneration.current) return
      setItems((current) => {
        if (!current) return page.items
        const known = new Set(current.map((item) => item.id))
        return [...current, ...page.items.slice(0, PAGE_SIZE).filter((item) => !known.has(item.id))]
      })
      setHasMore(page.items.length > PAGE_SIZE)
    } catch (error) {
      if (generation !== loadMoreGeneration.current) return
      if (error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
      setMoreFailed(true)
    } finally {
      if (generation === loadMoreGeneration.current) setLoadingMore(false)
    }
  }

  function confirmRestore(version: NoteVersion, trigger: HTMLButtonElement) {
    if (!currentVersionId || !currentVersionNo || version.id === currentVersionId || !canRestore) return
    const origin = root
      ? localRect(trigger.getBoundingClientRect(), root.getBoundingClientRect())
      : { x: 12, y: 96, width: 48, height: 48 }
    openSheet({
      kind: 'version-restore',
      title: '切回这次保存',
      variant: 'paper',
      origin,
      trigger,
      children: <RestoreVersionConfirmation
        noteId={noteId}
        noteTitle={reader?.title || title}
        version={version}
        currentVersionId={currentVersionId}
        currentVersionNo={currentVersionNo}
      />,
    })
  }

  return (
    <section className="page-scroll edition-scroll" data-view-key={`history:${noteId}`} data-companion-note-id={noteId} data-companion-note-version={currentVersionId} aria-label="版本与来处">
      <header className="edition-heading">
        <p><Icon name="history" /> 一篇手记 · 保存轨迹</p>
        <h1>{reader?.title || title}</h1>
        <span>每次保存都留在这里，需要时可以切回旧版。</span>
      </header>
      {currentVersionNo !== null && (
        <div className="edition-now" aria-label={`当前正在阅读第 ${currentVersionNo} 版`}>
          <span className="edition-now-mark"><Icon name="book-open" /></span>
          <span className="edition-now-copy"><small>现在读到</small><strong>第 {currentVersionNo} 版</strong></span>
          <span className="edition-now-rule" aria-hidden="true" />
          <span className="edition-now-caption">当前正文</span>
        </div>
      )}
      {items && items.length > 0 && (
        <p className="edition-guide">
          {canRestore ? '手机端先切回某一版查看正文。所有保存记录都会保留，之后也能切回来。' : '当前书房为只读状态，可以查看记录；切回旧版需要笔记修改权限。'}
        </p>
      )}
      {failed && (
        <div className="state-note versions-load-error edition-error" role="alert">
          <p>版本记录暂时取不到。检查连接后再试。</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>
        </div>
      )}
      {!items && !failed && <p className="edition-loading" role="status"><i aria-hidden="true" />正在把保存记录接回来…</p>}
      {ordered && ordered.length > 0 && <div className="edition-timeline" aria-label="笔记版本时间线">
        <p className="edition-timeline-label">从最近一次保存往前</p>
        {ordered.map((version) => {
          const isCurrent = version.id === currentVersionId
          return (
            <article className={`edition-entry${isCurrent ? ' is-current' : ''}`} key={version.id} data-current={isCurrent ? 'true' : 'false'}>
              <span className="edition-marker" aria-hidden="true"><i /></span>
              <div className="edition-entry-paper">
                <div className="edition-entry-date">
                  <time dateTime={version.createdAt}>{dayOf(version.createdAt)}</time>
                  <span>{clock(version.createdAt)}</span>
                </div>
                <strong>第 {version.versionNo} 版</strong>
                <p>{isCurrent ? '正在阅读的正文' : '当时保存下来的正文'}</p>
                {isCurrent
                  ? <span className="edition-current-seal"><Icon name="check" />当前打开</span>
                  : canRestore
                    ? <button className="edition-restore" type="button" onClick={(event) => confirmRestore(version, event.currentTarget)} aria-label={`将正文切回第 ${version.versionNo} 版`}>
                        <Icon name="history" />切回这一版<Icon name="arrow-right" />
                      </button>
                    : <span className="edition-readonly">只读 · 不能切回</span>}
              </div>
            </article>
          )
        })}
        {hasMore && (
          <div className="edition-more">
            {moreFailed && <p role="alert">更早的记录没有取到，再试一次。</p>}
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? '正在翻到更早的记录…' : moreFailed ? '重试加载' : '再往前看 100 次保存'}
            </button>
          </div>
        )}
        <footer className="edition-colophon">
          <span><Icon name="check" />已载入 {loadedCount} 条保存记录</span>
          <button type="button" onClick={pop}>回到正文 <Icon name="arrow-right" /></button>
        </footer>
      </div>}
      {items?.length === 0 && <div className="edition-empty"><Icon name="history" /><p>这篇手记还没有可回看的旧版本。</p><button type="button" onClick={pop}>回到正文</button></div>}
    </section>
  )
}

function RestoreVersionConfirmation({
  noteId,
  noteTitle,
  version,
  currentVersionId,
  currentVersionNo,
}: {
  noteId: string
  noteTitle: string
  version: NoteVersion
  currentVersionId: string
  currentVersionNo: number
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function restore() {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await notesApi.restoreVersion(noteId, version.id, currentVersionId)
      if (!applyRestoredNoteVersion(noteId, result)) {
        setFailure('版本已经切回，但当前笔记页已离开。重新打开这篇手记即可核对。')
        return
      }
      closeSheet({ restoreFocus: false })
      pop()
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        setFailure('登录状态已失效，请重新登录后再试。')
      } else if (error instanceof ApiError && (error.status === 409 || error.code === 'revision_conflict')) {
        setFailure('这篇手记刚刚有新改动。请回到正文更新后，再切回历史版本。')
      } else if (error instanceof ApiError && error.status === 403) {
        setFailure('当前书房没有恢复权限，原来的正文没有变化。')
      } else {
        setFailure(error instanceof Error ? error.message : '没有切回这一版，请稍后再试。')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="version-restore-sheet" aria-busy={busy}>
      <div className="version-restore-intro">
        <span><Icon name="history" /></span>
        <p>将《{noteTitle}》的正文切回第 {version.versionNo} 版。</p>
      </div>
      <div className="version-restore-path" aria-label={`从第 ${currentVersionNo} 版切回第 ${version.versionNo} 版`}>
        <span><small>现在</small><strong>第 {currentVersionNo} 版</strong></span>
        <Icon name="arrow-right" />
        <span className="version-restore-destination"><small>切回</small><strong>第 {version.versionNo} 版</strong></span>
      </div>
      <p className="version-restore-note">其他保存记录仍会保留。之后也可以在这里再切回来。</p>
      {failure && <p className="version-restore-error" role="alert">{failure}</p>}
      <div className="version-restore-actions">
        <button type="button" className="secondary" disabled={busy} onClick={requestSheetClose}>再想想</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void restore()}>
          {busy ? '正在切回…' : `切回第 ${version.versionNo} 版`}
        </button>
      </div>
    </div>
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
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}
