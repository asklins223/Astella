import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CompanionPageContextV1, CompanionSelectionV1 } from '@astella/shared/companion-conversation-contracts'
import { Icon } from '../app/icons.tsx'
import { navStore, push } from '../app/nav.ts'
import { CompanionSeat } from '../companion/CompanionSeat.tsx'
import { companionStore, interrupt, notifyCompanionInput, retryConversation, sendTurn, useCompanion } from '../state/companion.ts'
import { notesStore } from '../state/notes.ts'
import { useSession } from '../state/session.ts'
import { openSheet, originOf, requestSheetClose } from '../ui/sheet-store.ts'
import { MessageContent } from './message-content.tsx'
import { RunProcess } from './RunProcess.tsx'
import { companionLine } from './status-line.ts'
import { presentMessages } from './presentation.ts'

export interface CompanionPageTarget {
  label: string
  context?: CompanionPageContextV1
  selection?: CompanionSelectionV1
}

const PAGE_LABELS: Record<string, string> = {
  chat: '当前交流', hand: '手边进展', notes: '手记架', me: '个人中心',
  settings: '使用设置', companion: '伴星中心', reader: '笔记正文',
  versions: '版本记录', map: '思维导图', explain: '这篇讲解',
}

/** Capture the actual visible object when opening, not a future page's context. */
export function currentCompanionTarget(): CompanionPageTarget {
  const nav = navStore.get()
  const route = nav.pushed.at(-1)
  const reader = notesStore.get().reader
  const label = PAGE_LABELS[route?.kind ?? nav.tab] ?? '当前页面'
  if (route && 'noteId' in route) {
    const current = reader?.noteId === route.noteId ? reader : null
    // Transition ghosts remain in the DOM for the exit animation. Never let an
    // invisible old page donate the note/version to the contextual question.
    const presented = document.querySelector<HTMLElement>('.viewport > .page-layer [data-companion-note-id][data-companion-note-version]')
    const version = presented?.dataset.companionNoteId === route.noteId
      ? presented.dataset.companionNoteVersion : current?.detail?.currentVersionId
    return { label: current?.title ? `${label} · ${current.title}` : label,
      context: { pageKind: 'note', sharing: 'page_registered', noteId: route.noteId,
        ...(version ? { noteVersionId: version } : {}) } }
  }
  return { label }
}

export function openContextCompanion(trigger: HTMLElement | null, root: HTMLElement | null, target = currentCompanionTarget()): void {
  openSheet({ kind: 'companion-chat', title: '和伴星聊聊', origin: originOf(trigger, root), trigger,
    children: <ContextCompanionPanel target={target} /> })
}

interface LocalExchange { draft: string; runIds: string[] }
const exchanges = new Map<string, LocalExchange>()

/** The paper stays in place; this panel uses the same inbox with an isolated draft. */
function ContextCompanionPanel({ target }: { target: CompanionPageTarget }) {
  const companion = useCompanion()
  const session = useSession()
  const contextIdentity = target.context?.pageKind === 'note'
    ? `${target.context.noteId}:${target.context.noteVersionId ?? 'latest'}`
    : target.label
  const key = `${session.me?.userId}:${session.me?.workspaceId}:${contextIdentity}:${target.selection?.text ?? ''}`
  const [exchange, setExchange] = useState<LocalExchange>(() => exchanges.get(key) ?? { draft: '', runIds: [] })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [following, setFollowing] = useState(true)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const save = (next: LocalExchange) => { exchanges.set(key, next); if (mounted.current) setExchange(next) }
  const active = companion.turn && (submitting || exchange.runIds.includes(companion.turn.runId)) ? companion.turn : null
  const messages = presentMessages(companion.messages.filter(message => Boolean(message.runId && exchange.runIds.includes(message.runId))))
  const seen = new Set<string>()
  const ready = companion.historyReady && companion.capability !== 'off'
  const blocked = Boolean(companion.turn && !companion.turn.initiative) || companion.uploadingImage || companion.transcribingVoice
  const canSend = ready && !blocked && !submitting && Boolean(exchange.draft.trim())

  const jumpToLatest = () => { pinned.current = true; setFollowing(true); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight }
  useLayoutEffect(() => {
    const node = scroller.current
    const body = content.current
    if (!node || !body) return
    const observer = new ResizeObserver(() => { if (pinned.current) node.scrollTop = node.scrollHeight })
    observer.observe(body)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (pinned.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [companion.messages, companion.turn, companion.runProcesses, exchange.runIds])
  useLayoutEffect(() => {
    if (!field.current) return
    field.current.style.height = 'auto'
    field.current.style.height = `${Math.min(112, Math.max(48, field.current.scrollHeight))}px`
  }, [exchange.draft])

  async function submit() {
    if (!canSend) return
    const question = exchange.draft.trim()
    const conversationId = companion.conversationId
    const existing = new Set(companion.messages.map(message => message.id))
    setSubmitting(true)
    setError(null)
    notifyCompanionInput()
    try {
      const sent = await sendTurn(question, { composer: 'isolated', context: target.context, selection: target.selection })
      const state = companionStore.get()
      if (state.conversationId !== conversationId) return
      if (!sent) {
        if (mounted.current) setError(state.composerError ?? '这句没有发出去，问题仍留在这里。')
        return
      }
      const user = [...state.messages].reverse().find(message => message.role === 'user' && !existing.has(message.id))
      const runId = user?.runId || state.turn?.runId
      const current = exchanges.get(key) ?? exchange
      save({ draft: current.draft.trim() === question ? '' : current.draft,
        runIds: runId ? [...new Set([...current.runIds, runId])] : current.runIds })
    } catch {
      if (mounted.current) setError('这句没有发出去，问题仍留在这里，可以再试。')
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }

  return (
    <div className="context-companion" data-has-messages={Boolean(messages.length || active) || undefined}>
      <div className="context-companion-presence">
        <CompanionSeat variant="panel" />
        <div><strong>伴星在这里</strong><span role="status">{companionLine(companion, true)}</span></div>
        <button type="button" className="context-profile" onClick={() => push({ kind: 'companion' })} aria-label="打开伴星档案"><Icon name="user-round" /></button>
      </div>
      <div className="context-companion-reference">
        <Icon name={target.context ? 'book-open' : 'message-square-text'} />
        <span>{target.label}</span>
        <small>{target.selection ? '带着选中的原文' : target.context ? '带着这篇笔记' : '接着同一条交流'}</small>
      </div>
      {target.selection && <div className="context-selected-text">
        <button type="button" aria-expanded={quoteOpen} onClick={() => setQuoteOpen(value => !value)}>选中的原文<small>{target.selection.text.length} 字</small><Icon name="chevron-down" /></button>
        <p hidden={!quoteOpen}>{target.selection.text}</p>
      </div>}
      <div className="context-conversation" ref={scroller} aria-label="当前内容旁的交流" onScroll={event => {
        const node = event.currentTarget
        const next = node.scrollHeight - node.scrollTop - node.clientHeight < 48
        pinned.current = next
        setFollowing(next)
      }}>
        <div ref={content}>
          {!messages.length && !active && <div className="context-conversation-empty">
            <strong>{target.selection ? '这段的哪一点想再问问？' : target.context ? '边读边问，原文还在。' : '说说你现在想做什么。'}</strong>
            <p>{target.context ? '解释、比较或修改都可以。收起后仍停在这一篇。' : '不用离开当前页面，完整交流也会留在记录里。'}</p>
          </div>}
          {messages.map(({ key, message }) => {
            const showProcess = message.role === 'assistant' && Boolean(message.runId && !seen.has(message.runId))
            if (showProcess && message.runId) seen.add(message.runId)
            return <div key={key} className={`context-message${message.role === 'user' ? ' mine' : ''}`}>
              {showProcess && message.runId && <RunProcess runId={message.runId} />}
              <small>{message.role === 'user' ? '你' : '伴星'}</small>
              <MessageContent blocks={message.blocks} followUpPrompts={message.followUpPrompts} showFollowups={message.id === messages.at(-1)?.message.id && !active}
                onFollowup={draft => { save({ ...exchange, draft }); field.current?.focus({ preventScroll: true }) }} />
            </div>
          })}
          {active && <div className="context-message live">
            {!seen.has(active.runId) && active.runId && <RunProcess runId={active.runId} />}
            {active.text ? <MessageContent blocks={[{ type: 'text', text: active.text }]} /> : !companion.runProcesses[active.runId]?.rows.length && <p role="status">正在接过你的问题…</p>}
          </div>}
        </div>
      </div>
      {!following && <button className="context-latest" type="button" onClick={jumpToLatest}>回到最新<Icon name="arrow-right" /></button>}
      {!ready && <div className="context-feedback" role="status"><span>{companion.capability === 'off' ? '这台服务端没有开启伴星交流。' : companion.error || '正在接回交流…'}</span>
        {companion.capability !== 'off' && <button type="button" onClick={() => void retryConversation()}>重新连接</button>}</div>}
      {blocked && !active && <p className="context-feedback">伴星正在处理另一轮，你可以先写问题；等她结束后再发。</p>}
      {error && <p className="context-feedback" role="alert">{error}</p>}
      <form className="context-composer" onSubmit={event => { event.preventDefault(); if (canSend) void submit() }}>
        <label className="visually-hidden" htmlFor="context-question">想问伴星的话</label>
        <textarea id="context-question" ref={field} rows={1} value={exchange.draft} placeholder={target.selection ? '想问这段的哪一点？' : target.context ? '问问这篇笔记…' : '想对伴星说什么…'}
          enterKeyHint="send"
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 || !canSend) return
            event.preventDefault()
            void submit()
          }}
          onChange={event => { notifyCompanionInput(); save({ ...exchange, draft: event.target.value }); setError(null) }} />
        {active ? <button type="button" className="context-stop" disabled={!active.runId} onClick={() => void interrupt()} aria-label="停止当前回复"><Icon name="x" /></button>
          : <button type="submit" disabled={!canSend} aria-label="发送这条问题"><Icon name="send" /></button>}
      </form>
      <button className="context-return" type="button" onClick={() => requestSheetClose()}>{target.context ? '收起，继续读' : '收起，回到当前页面'}<Icon name="chevron-down" /></button>
    </div>
  )
}
