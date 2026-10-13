import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import { Icon } from '../app/icons.tsx'
import { goTab, push } from '../app/nav.ts'
import { setChatLayout } from '../state/prefs.ts'
import { noteLinkTarget } from '@astella/shared/note-markdown'
import { localRect } from '../platform/geometry.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { openSheet, closeSheet } from '../ui/sheet-store.ts'
import { useSession } from '../state/session.ts'
import { companionStore, openConversation, retryConversation, sendTurn, type CompanionState } from '../state/companion.ts'
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
  const root = usePhoneRoot()
  const reader = notes.reader
  const [activeId, setActiveId] = useState<string | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [noteLinkMessage, setNoteLinkMessage] = useState<string | null>(null)
  const [resolvingNoteLink, setResolvingNoteLink] = useState(false)
  const marks = useRef<HTMLElement>(null)

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
        </article>
      </section>
    )
  }

  const detail = reader.detail
  const quickPhase = reader.overview.phase
  const quoteFrom = (from: BlockPoint, to: BlockPoint, text: string) => {
    const anchor = anchorFromSelection(blocks, from, to, detail.currentVersionId)
    openSelectionSheet(anchor, text)
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
          userId={session.me?.userId}
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
    <section className="page-scroll reader-scroll" data-view-key={`reader:${noteId}`} aria-label="笔记正文">
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
            <div className="thread-quick reader-chips" role="group" aria-label="阅读工具">
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
            <p className="reader-selection-hint"><Icon name="quote" />长按正文并拖选，可跨连续段落一次问伴星</p>
            {reader.annotations.length > 0 && (
              <button className="reader-annotations-jump" type="button" onClick={() => marks.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                <Icon name="quote" />
                <span>回到圈过的句子</span>
                <small>{reader.annotations.length}</small>
                <Icon name="chevron-right" />
              </button>
            )}

            {(quickOpen || reader.overview.phase === 'ready' || reader.overview.phase === 'failed') && (
              <QuickRead overview={reader.overview} version={detail.currentVersion.versionNo} />
            )}

            <NotePaper
              title={reader.title}
              blocks={blocks}
              placements={placements}
              activeAnnotationId={activeId}
              focusOrdinal={reader.focusOrdinal}
              onSelection={(from, to, text) => quoteFrom(from, to, text)}
              onClearSelection={() => undefined}
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
            <p>可以点下方“问这篇笔记”，请伴星从你们的交流里整理内容。</p>
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
    } catch {
      setNoteLinkMessage('暂时没能读取相关手记，检查连接后再试。')
    } finally {
      setResolvingNoteLink(false)
    }
  }
}

function SelectionPanel({ title, version, noteVersionId, userId, quote, anchor, noteId }: {
  title: string
  version: number
  noteVersionId: string
  userId: string | undefined
  quote: string
  anchor: NoteAnnotationAnchorV1 | null
  noteId: string
}) {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const [asked, setAsked] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const notes = useNotes()
  const seen = useRef(notes.reader?.annotations.length ?? 0)
  const count = notes.reader?.annotations.length ?? 0
  const tooLongToSend = quote.length > COMPANION_SELECTION_MAX_CHARS

  // 她写完那一句就多出一条批注；批注数一变，这一格该让回正文。
  useEffect(() => {
    if (asked && count > seen.current) closeSheet()
  }, [asked, count])

  async function sendSelectedText(): Promise<void> {
    if (sending || tooLongToSend || !quote.trim()) return
    setSending(true)
    setSendError(null)
    try {
      const before = companionStore.get()
      if (!before.historyReady && before.capability !== 'off') {
        if (before.conversationId && before.stream === 'closed') await retryConversation()
        else if (!before.conversationId) await openConversation()
      }
      const state: CompanionState = await waitForConversationReady()
      if (!state.historyReady) {
        setSendError(state.capability === 'off'
          ? '这台服务端没有开启对话。原文仍留在这里。'
          : state.error ?? '对话还没接好，原文仍留在这里，可以稍后重试。')
        return
      }
      if (state.turn) {
        setSendError('伴星正在回复；等她说完后，再把这段原文一次发过去。')
        return
      }
      if (state.uploadingImage || state.transcribingVoice) {
        setSendError('对话里的图片或语音还在处理；等处理完后，再把这段原文一次发过去。')
        return
      }
      const sent = await sendTurn(
        '请用通俗易懂的话解释这段；如果举个具体例子会更清楚，也请举例。',
        {
          selection: { text: quote, sharing: 'user_selected' },
          context: { pageKind: 'note', sharing: 'page_registered', noteId, noteVersionId },
        },
      )
      if (!sent) {
        const latest = companionStore.get()
        setSendError(latest.composerError ?? (latest.turn
          ? '伴星正在回复；等她说完后，再把这段原文一次发过去。'
          : '这段原文没有发出去，内容还在这里，可以重试。'))
        return
      }
      closeSheet()
      setChatLayout('history', userId)
      goTab('chat')
    } catch {
      setSendError('这段原文没有发出去，内容还在这里，可以重试。')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="ask-reference selection-reference">
        <strong>《{title}》 · 第 {version} 版</strong>
        <p>{quote}</p>
      </div>
      <button className="selection-send" type="button" disabled={sending || tooLongToSend || !quote.trim()} onClick={() => void sendSelectedText()}>
        <Icon name="message-square-text" />
        <span>{sending ? '正在把这段原文发过去…' : '把整段原文发给伴星'}</span>
        {!sending && <Icon name="arrow-right" />}
      </button>
      {sendError && <p className="selection-send-error" role="alert">{sendError}</p>}
      {tooLongToSend && <p className="selection-send-error" role="status">这次选中的内容超过 20,000 字，请缩小范围后再发。</p>}
      {anchor ? (
        <>
          {!writing && (
            <div className="thread-quick">
              <button type="button" disabled={asked} onClick={() => { setAsked(true); void explainSelection(anchor) }}>圈成一段讲解</button>
              <button type="button" onClick={() => { push({ kind: 'explain', noteId }); void generateExplainer(anchor) }}>打开讲解页</button>
              <button type="button" onClick={() => setWriting(true)}>自己记一笔</button>
            </div>
          )}
          {asked && <p className="status-inline">她在整理这段讲解，完成后会落在原文旁边。</p>}
          {writing && (
            <>
              <textarea
                className="review-answer"
                rows={4}
                value={draft}
                placeholder="写你自己的话——这只是批注，不改笔记正文"
                onChange={(event) => setDraft(event.target.value)}
              />
              <button className="primary" type="button" disabled={!draft.trim()} onClick={() => {
                void saveAnnotation(anchor, draft.trim()).then(() => closeSheet())
              }}>留下这一笔</button>
            </>
          )}
        </>
      ) : (
        <p className="sheet-copy">这段原文仍可一次发给伴星；当前选区没法精确落回笔记，所以暂时不能在这里保存批注。</p>
      )}
    </>
  )
}

function waitForConversationReady(): Promise<CompanionState> {
  const current = companionStore.get()
  if (current.historyReady || current.capability === 'off' || (current.error && current.stream === 'closed')) {
    return Promise.resolve(current)
  }
  return new Promise((resolve) => {
    let settled = false
    let timeout: number | undefined
    let unsubscribe: () => void = () => {}
    const finish = (state: CompanionState) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      unsubscribe()
      resolve(state)
    }
    const check = () => {
      const state = companionStore.get()
      if (state.historyReady || state.capability === 'off' || (state.error && state.stream === 'closed')) finish(state)
    }
    unsubscribe = companionStore.subscribe(check)
    timeout = window.setTimeout(() => finish(companionStore.get()), 22_000)
    check()
  })
}

function quickLabel(phase: ReaderState['overview']['phase'], open: boolean): string {
  if (phase === 'failed') return '再试一次'
  if (phase === 'queued' || phase === 'running') return '正在整理'
  if (phase === 'ready') return open ? '收起要点' : '看要点'
  return '让她速看'
}

function QuickRead({ overview, version }: { overview: ReaderState['overview']; version: number }) {
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
      {points.length > 0 ? points.map((point, index) => (
        <div className="review-prompt" key={index}>
          <Icon name="lightbulb" />
          <span>
            {point.explanation}
            <button className="text-action" type="button" onClick={() => focusBlock(point.blockOrdinal)}>{point.quote}</button>
          </span>
        </div>
      )) : <p className="quick-body">{data.body}</p>}
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
