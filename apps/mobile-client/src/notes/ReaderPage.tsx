import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import { Icon } from '../app/icons.tsx'
import { push } from '../app/nav.ts'
import { noteLinkTarget } from '@astella/shared/note-markdown'
import { localRect } from '../platform/geometry.ts'
import { useMotion } from '../platform/motion.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { openSheet, closeSheet, useSheet, requestSheetClose, isCurrentSheet } from '../ui/sheet-store.ts'
import { handleUnauthorized, useSession } from '../state/session.ts'
import { ApiError } from '../platform/api-client.ts'
import { openContextCompanion } from '../conversation/context-companion.tsx'
import { COMPANION_SELECTION_MAX_CHARS } from '@astella/shared/companion-conversation-contracts'
import {
  explainSelection,
  focusBlock,
  generateExplainer,
  generateOverview,
  removeAnnotation,
  retryAnnotations,
  saveAnnotation,
  useNotes,
  openNote,
  type ReaderState,
} from '../state/notes.ts'
import { NotePaper } from './NotePaper.tsx'
import { anchorFromSelection, blockText, placementsForNote, type BlockPoint } from './reading.ts'
import { notesApi, type NoteListItem } from '../platform/api.ts'

/**
 * 阅读器：一篇笔记就是这一张纸。
 *
 * 速看的要点、脑图、讲解、批注都长在**同一张纸**上——要点在正文之前，批注在原句下面，
 * 脑图与讲解是这张纸摊开的另一种看法（推整屏，返回就回到原来那一格）。
 * 派生视图不是另存一份内容，这也是手机上不给编辑框的原因：看法可以换，笔记本体只有一个。
 */
export function ReaderPage({ noteId }: { noteId: string }) {
  const notes = useNotes()
  const session = useSession()
  const motion = useMotion()
  const root = usePhoneRoot()
  const reader = notes.reader
  const [activeId, setActiveId] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [noteLinkMessage, setNoteLinkMessage] = useState<string | null>(null)
  const [resolvingNoteLink, setResolvingNoteLink] = useState(false)
  const marks = useRef<HTMLElement>(null)
  const sheet = useSheet()
  const [selection, setSelection] = useState<{ anchor: NoteAnnotationAnchorV1 | null; text: string } | null>(null)
  const [selectionPosition, setSelectionPosition] = useState({ left: 12, top: 90 })

  useEffect(() => {
    if (!selection || !root) return
    const update = () => {
      const current = window.getSelection()
      if (!current?.rangeCount || current.isCollapsed) return
      const range = current.getRangeAt(0).getBoundingClientRect()
      const frame = root.getBoundingClientRect()
      const width = Math.min(256, root.clientWidth - 24)
      const scaleX = root.clientWidth / Math.max(1, frame.width)
      const scaleY = root.clientHeight / Math.max(1, frame.height)
      const bottom = (range.bottom - frame.top) * scaleY
      const proposedTop = bottom + 8 > root.clientHeight - 100 ? (range.top - frame.top) * scaleY - 62 : bottom + 8
      setSelectionPosition({ left: Math.max(12, Math.min(root.clientWidth - width - 12, (range.left - frame.left + range.width / 2) * scaleX - width / 2)),
        top: Math.max(80, Math.min(root.clientHeight - 110, proposedTop)) })
    }
    update()
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => { document.removeEventListener('scroll', update, true); window.removeEventListener('resize', update) }
  }, [selection, root])

  const blocks = reader?.detail?.currentVersion.blocks ?? []
  const hasContent = blocks.length > 0
  const placements = usePlacements(blocks, reader?.annotations ?? [])

  if (!reader || reader.loading || reader.noteId !== noteId) {
    return (
      <section className="page-scroll reader-scroll" data-view-key={`reader:${noteId}`} aria-label="笔记正文">
        <article className="paper">
          <div className="paper-meta"><Icon name="book-open" /><span>正在取这一篇</span></div>
          <h1>{reader?.title ?? '…'}</h1>
          <p className="state-note">正文正在路上。</p>
        </article>
      </section>
    )
  }
  if (!reader.detail) {
    return (
      <section className="page-scroll reader-scroll" data-view-key={`reader:${noteId}`} aria-label="笔记正文">
        <article className="paper">
          <div className="paper-meta"><Icon name="circle-help" /><span>这一篇没取到</span></div>
          <p className="state-note" role="status">{reader.error ?? '退回列表再试一次。'}</p>
          <button className="secondary" type="button" onClick={() => void openNote(noteId, reader.title)}>重新读取正文</button>
        </article>
      </section>
    )
  }

  const detail = reader.detail
  const quickPhase = reader.overview.phase
  const quoteFrom = (from: BlockPoint, to: BlockPoint, text: string) => {
    const anchor = anchorFromSelection(blocks, from, to, detail.currentVersionId)
    setSelection({ anchor, text: anchor?.excerpt ?? text })
  }

  const openSelectionSheet = (anchor: NoteAnnotationAnchorV1 | null, text: string) => {
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null
    const origin = range && root ? localRect(range, root.getBoundingClientRect()) : { x: (root?.clientWidth ?? 0) / 2 - 40, y: (root?.clientHeight ?? 0) - 160, width: 80, height: 44 }
    openSheet({
      kind: 'selection',
      title: '已选原文',
      origin,
      children: (
        <SelectionPanel
          title={reader.title}
          version={detail.currentVersion.versionNo}
          noteVersionId={detail.currentVersionId}
          quote={anchor?.excerpt ?? text}
          anchor={anchor}
          noteId={noteId}
        />
      ),
    })
  }

  const jumpToMark = (annotation: NoteAnnotationV1) => {
    setActiveId(annotation.annotationId)
    focusBlock(annotation.anchor.startBlockOrdinal)
  }

  return (
    <section className="page-scroll reader-scroll" data-view-key={`reader:${noteId}`} data-companion-note-id={noteId} data-companion-note-version={detail.currentVersionId} aria-label="笔记正文">
      <article className="paper" data-empty={hasContent ? undefined : 'true'}>
        <div className="paper-meta">
          <Icon name={session.me?.isPersonal === false ? 'lock' : 'book-open'} />
          <span>{session.me?.workspaceName ?? '我的书房'} · 只读</span>
        </div>
        <h1>{reader.title}</h1>

        <button
          className="version-strip"
          type="button"
          aria-label={`查看第 ${detail.currentVersion.versionNo} 版的版本记录`}
          onClick={() => push({ kind: 'versions', noteId, title: reader.title })}
        >
          <Icon name="history" />
          <span>
            <b>第 {detail.currentVersion.versionNo} 版</b>
            <em>查看版本记录</em>
          </span>
          <Icon name="chevron-right" />
        </button>

        {reader.error && <p className="state-note" role="status">{reader.error}</p>}
        {noteLinkMessage && <p className="state-note" role="status">{noteLinkMessage}</p>}
        {resolvingNoteLink && <p className="state-note" role="status">正在找这篇手记…</p>}

        {reader.annotationsError && (
          <div className="state-note annotation-load-error" role="status">
            <span>批注暂时没取到：{reader.annotationsError}</span>
            <button type="button" onClick={() => retryAnnotations(noteId)}>重试批注</button>
          </div>
        )}

        {reader.editedByCompanion && (
          <div className="state-note">
            <strong>伴星刚改了这一篇。</strong>
            {reader.editedByCompanion.summary}
            <button type="button" onClick={() => push({ kind: 'versions', noteId, title: reader.title })}>看版本</button>
          </div>
        )}

        {hasContent ? (
          <>
            <div className="reader-tools-heading"><span>换个读法</span><small>同一篇手记的三种入口</small></div>
            <div className="thread-quick reader-chips reader-reading-paths" role="group" aria-label="阅读工具">
              <button
                className="reader-tool"
                type="button"
                disabled={quickPhase === 'queued' || quickPhase === 'running'}
                aria-busy={quickPhase === 'queued' || quickPhase === 'running'}
                onClick={() => {
                  // 没生成过就发起；生成失败就再试一次（失败时不能还说“收起要点”，那下面什么也没有）
                  if (quickPhase === 'idle' || quickPhase === 'failed') {
                    setQuickOpen(true)
                    void generateOverview()
                    return
                  }
                  if (quickPhase === 'ready') setQuickOpen((open) => !open)
                }}
              >
                <Icon name="sparkles" />
                <span>{quickLabel(quickPhase, quickOpen)}</span>
              </button>
              <button className="reader-tool" type="button" onClick={() => push({ kind: 'map', noteId })}>
                <Icon name="list-tree" />
                <span>思维导图</span>
              </button>
              <button className="reader-tool" type="button" onClick={() => push({ kind: 'explain', noteId })}>
                <Icon name="lightbulb" />
                <span>讲一段</span>
              </button>
            </div>
            <p className="reader-selection-hint"><Icon name="quote" />长按拖选原文，选好后再点“问伴星”</p>
            {reader.annotations.length > 0 && (
              <button className="reader-annotations-jump" type="button" onClick={() => marks.current?.scrollIntoView({ behavior: motion.off ? 'instant' : 'smooth', block: 'start' })}>
                <Icon name="quote" />
                <span>回到圈过的句子</span>
                <small>{reader.annotations.length}</small>
                <Icon name="chevron-right" />
              </button>
            )}

            {(quickOpen || reader.overview.phase === 'failed') && (
              <QuickRead overview={reader.overview} version={detail.currentVersion.versionNo} />
            )}

            <NotePaper
              title={reader.title}
              blocks={blocks}
              placements={placements}
              activeAnnotationId={activeId}
              focusOrdinal={reader.focusOrdinal}
              onSelection={(from, to, text) => quoteFrom(from, to, text)}
              onSelectionText={text => setSelection({ anchor: null, text })}
              onClearSelection={() => { if (!sheet) setSelection(null) }}
              onMarkClick={jumpToMark}
              onNoteLink={(href, label, origin) => { void openNoteLink(href, label, origin) }}
            />

            <p className="note-end">
              读完一段，也可以先停在这里。<br />
              讲解与浏览不会自动记作掌握。
            </p>
          </>
        ) : (
          <div className="note-empty" role="status">
            <h2>这篇手记还没有正文</h2>
            <p>在下方和伴星聊聊，把你想留下的内容告诉她。</p>
          </div>
        )}

        {reader.annotations.length > 0 && (
          <section ref={marks}>
            <div className="list-label"><span>圈过的句子</span><span>{reader.annotations.length} 条</span></div>
            {reader.annotations.map((annotation) => (
              <article className="archive-line" key={annotation.annotationId} data-active={activeId === annotation.annotationId ? '1' : '0'}>
                <div className="message-meta">
                  <span>{annotation.sourceMessageId ? '伴星记下' : '你圈的'}</span>
                  <span>{annotation.versionState === 'current' ? '对得上现在的正文' : '这一句已不在现在的正文里'}</span>
                </div>
                <p>{annotation.explanation}</p>
                <div className="message-actions">
                  <button type="button" onClick={() => jumpToMark(annotation)}>回到那一句</button>
                  <button type="button" onClick={() => { closeSheet(); generateExplainerFor(annotation.anchor) }}>用这段讲一段</button>
                  <button type="button" onClick={() => void removeAnnotation(annotation)}>撤掉</button>
                </div>
              </article>
            ))}
          </section>
        )}
      </article>
      {selection && root && !sheet && createPortal(
        <div className="reader-selection-actions" role="group" aria-label="选中原文的操作" style={selectionPosition} onPointerDown={event => event.preventDefault()}>
          <button type="button" disabled={selection.text.length > COMPANION_SELECTION_MAX_CHARS} onClick={() => {
            const source = window.getSelection()?.focusNode?.parentElement ?? root.querySelector<HTMLElement>('.reader-scroll')
            if (source) source.tabIndex = -1
            openContextCompanion(source, root, { label: reader.title, context: { pageKind: 'note', sharing: 'page_registered', noteId, noteVersionId: detail.currentVersionId },
              selection: { text: selection.text, sharing: 'user_selected' } })
          }}><Icon name="message-square-text" />问伴星</button>
          <button type="button" disabled={!selection.anchor} onClick={() => openSelectionSheet(selection.anchor, selection.text)}>批注</button>
          <button className="icon-button" type="button" aria-label="取消选区" onClick={() => { window.getSelection()?.removeAllRanges(); setSelection(null) }}><Icon name="x" /></button>
        </div>, root)}
    </section>
  )

  function generateExplainerFor(anchor: NoteAnnotationAnchorV1): void {
    push({ kind: 'explain', noteId })
    void generateExplainer(anchor)
  }

  async function openNoteLink(href: string, label: string, origin: HTMLAnchorElement): Promise<void> {
    if (resolvingNoteLink) return
    const target = noteLinkTarget(href)
    if (!target) return
    setResolvingNoteLink(true)
    setNoteLinkMessage(null)
    try {
      let linkedNoteId = target.value
      let linkedTitle = label
      if (target.kind === 'title') {
        const wanted = target.value.replace(/\.md$/i, '')
        const matches: NoteListItem[] = []
        let cursor: string | undefined
        do {
          const page = await notesApi.list({ limit: 100, cursor })
          matches.push(...page.items.filter((item) => item.title === target.value || item.title === wanted))
          if (matches.length > 1) break
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        if (matches.length !== 1) {
          setNoteLinkMessage(matches.length > 1
            ? '书房里有多篇同名手记，无法确定要打开哪一篇。'
            : '当前书房里没有这篇手记，或你暂时没有访问权限。')
          return
        }
        linkedNoteId = matches[0]!.id
        linkedTitle = matches[0]!.title
      } else {
        linkedTitle = notes.list.items.find((item) => item.id === linkedNoteId)?.title ?? label
      }
      push({ kind: 'reader', noteId: linkedNoteId, title: linkedTitle }, origin)
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        return
      }
      setNoteLinkMessage('暂时没能读取相关手记，检查连接后再试。')
    } finally {
      setResolvingNoteLink(false)
    }
  }
}

function SelectionPanel({ title, version, noteVersionId, quote, anchor, noteId }: {
  title: string
  version: number
  noteVersionId: string
  quote: string
  anchor: NoteAnnotationAnchorV1 | null
  noteId: string
}) {
  const root = usePhoneRoot()
  const sheet = useSheet()
  const ownedSheet = useRef(sheet)
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const [asked, setAsked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notes = useNotes()
  const existing = useRef(new Set(notes.reader?.annotations.map(item => item.annotationId) ?? []))
  const tooLong = quote.length > COMPANION_SELECTION_MAX_CHARS
  useEffect(() => {
    if (!asked || !anchor || !ownedSheet.current || !isCurrentSheet(ownedSheet.current)) return
    const finished = notes.reader?.noteId === noteId && notes.reader.annotations.some(item => !existing.current.has(item.annotationId) && item.anchor.excerpt === anchor.excerpt)
    if (finished) requestSheetClose()
  }, [asked, anchor, noteId, notes.reader])

  return (
    <>
      <div className="ask-reference selection-reference"><strong>《{title}》 · 第 {version} 版</strong><p>{quote}</p></div>
      <button className="selection-send" type="button" disabled={tooLong || !quote.trim()} onClick={event => openContextCompanion(event.currentTarget, root, {
        label: title, context: { pageKind: 'note', sharing: 'page_registered', noteId, noteVersionId },
        selection: { text: quote, sharing: 'user_selected' },
      })}><Icon name="message-square-text" /><span>带着这段原文问伴星</span><Icon name="arrow-right" /></button>
      {tooLong && <p className="selection-send-error" role="status">选中的内容超过 20,000 字，请缩小范围后再问。</p>}
      {anchor ? <>
        {!writing && <div className="thread-quick">
          <button type="button" disabled={asked} onClick={() => {
            setAsked(true); setError(null)
            void explainSelection(anchor).then(ok => { if (!ok) { setAsked(false); setError('这段讲解没有开始，原文仍留在这里，可以重试。') } })
          }}>在原文旁留讲解</button>
          <button type="button" onClick={() => { push({ kind: 'explain', noteId }); void generateExplainer(anchor) }}>打开讲解页</button>
          <button type="button" onClick={() => setWriting(true)}>自己记一笔</button>
        </div>}
        {asked && <p className="status-inline" role="status">正在整理，完成后会留在这段原文旁边。</p>}
        {writing && <>
          <label className="visually-hidden" htmlFor="selection-annotation">给这段原文的批注</label>
          <textarea id="selection-annotation" className="review-answer" rows={4} value={draft} placeholder="写下你自己的理解或问题" onChange={event => setDraft(event.target.value)} />
          <button className="primary" type="button" disabled={!draft.trim() || saving} onClick={() => {
            setSaving(true); setError(null)
            void saveAnnotation(anchor, draft.trim()).then(ok => {
              if (ok && ownedSheet.current && isCurrentSheet(ownedSheet.current)) requestSheetClose()
              else if (!ok) setError('这条批注没有保存，文字仍在这里，可以重试。')
            }).finally(() => setSaving(false))
          }}>{saving ? '正在留下…' : '留下这一笔'}</button>
        </>}
      </> : <p className="sheet-copy">这段可以带着原文问伴星；当前选区无法精确落回正文，暂时不能保存批注。</p>}
      {(error || notes.reader?.annotationsError) && <p className="selection-send-error" role="alert">{error || notes.reader?.annotationsError}</p>}
    </>
  )
}

function quickLabel(phase: ReaderState['overview']['phase'], open: boolean): string {
  if (phase === 'failed') return '再试一次'
  if (phase === 'queued' || phase === 'running') return '正在整理'
  if (phase === 'ready') return open ? '收起要点' : '看要点'
  return '先看要点'
}

function QuickRead({ overview, version }: { overview: ReaderState['overview']; version: number }) {
  const notes = useNotes()
  if (overview.phase === 'queued' || overview.phase === 'running') {
    return <p className="state-note">她在读这一篇，要点马上回来。</p>
  }
  if (overview.phase === 'failed') {
    return <p className="state-note" role="status">{overview.error ?? '要点暂时没有生成，请再试一次。'}</p>
  }
  const data = overview.data
  if (!data) return null
  const older = version !== data.noteVersionNumber
  const points = data.points ?? []
  return (
    <div className="quick-read" data-open="1">
      {older && (
        <p className="change-label">
          <Icon name="circle-help" />
          这一份是她读第 {data.noteVersionNumber} 版时写的，正文已经到第 {version} 版。
        </p>
      )}
      <div className="list-label"><span>先看这几条</span><span>每条都能回到原文</span></div>
      {points.length > 0 ? points.map((point, index) => {
        const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
        const matches = notes.reader?.detail?.currentVersion.blocks.filter(block => normalize(blockText(block)).includes(normalize(point.quote))) ?? []
        const ordinal = !older ? point.blockOrdinal : matches.length === 1 ? matches[0]!.ordinal : null
        return (
        <div className="review-prompt" key={index}>
          <Icon name="lightbulb" />
          <span>
            {point.explanation}
            <button className="text-action" type="button" disabled={ordinal === null} onClick={() => { if (ordinal !== null) focusBlock(ordinal) }}>{point.quote}{ordinal === null && <small> · 原句已变化</small>}</button>
          </span>
        </div>
      )}) : <p className="quick-body">{data.body}</p>}
      {data.coverage && data.coverage.imageBlocksNotRead > 0 && (
        <p className="change-label"><Icon name="image" />图她没读：这一篇有 {data.coverage.imageBlocksNotRead} 处配图这次没看。</p>
      )}
    </div>
  )
}

/** 批注落到正文哪几个字符上：验证过的范围，不靠猜。 */
function usePlacements(blocks: Parameters<typeof placementsForNote>[0], annotations: NoteAnnotationV1[]) {
  return useMemo(() => placementsForNote(blocks, annotations), [blocks, annotations])
}
