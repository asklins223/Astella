import { Fragment, useMemo } from 'react'
import { goTab, push } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { loadOlder, sendTurn, setDraft, useCompanion, type CompanionState } from '../state/companion.ts'
import { useNotes } from '../state/notes.ts'
import { dialogueText, DialogueMarkdown, followupPrompts, MessageContent } from './message-content.tsx'
import { ProposalCard } from './ProposalCard.tsx'
import { turnLine } from './status-line.ts'
import { RunProcess } from './RunProcess.tsx'
import { presentMessages } from './presentation.ts'
import { useThreadScroll } from './use-thread-scroll.ts'

/** 顶部那三枚：把她真能做的事写成一句话，点了就落进输入框，不自动发出去。 */
const GENERAL_PROMPTS = ['帮我拆解一个难懂的概念', '把刚才的结论整理成笔记', '我读到哪儿才算懂了？']
const NOTE_PROMPTS = ['帮我把这篇笔记理一遍', '指出这篇笔记里最关键的关系', '我读到哪儿才算懂了？']

/**
 * 记录那一屏。
 *
 * 与伴星那一屏共用同一段交流：这里给正文完整空间，她的头像不再占位，
 * 每一次"她动过手"都留一张能点回去的卡（`.delivery`），而不是只留一句她说改好了。
 */
export function ThreadChat() {
  const companion = useCompanion()
  const notes = useNotes()
  const { scroller, content, following, jumpToLatest } = useThreadScroll(companion)

  const prompts = notes.reader?.noteId || companion.draftContext?.pageKind === 'note' ? NOTE_PROMPTS : GENERAL_PROMPTS
  const titleOf = useNoteTitle()
  const presentedMessages = presentMessages(companion.messages)
  const firstAssistantByRun = new Map<string, string>()
  for (const entry of presentedMessages) {
    const message = entry.message
    if (message.role === 'assistant' && message.runId && !firstAssistantByRun.has(message.runId)) firstAssistantByRun.set(message.runId, entry.key)
  }
  const lastRetryableMessageId = [...companion.messages].reverse().find((message) => {
    if (message.role !== 'user') return false
    const run = companion.runs.find((item) => item.userMessageId === message.id)
    return !run?.assistantMessageId && (run?.status === 'failed' || run?.status === 'cancelled')
  })?.id ?? null
  // 追问属于当前这条回复；发出下一条消息后，历史回复里的入口就该收起来。
  const latestMessage = companion.messages.at(-1)
  const latestAssistantId = latestMessage?.role === 'assistant'
    ? latestMessage.id
    : null
  const hasContextualFollowups = latestMessage?.role === 'assistant'
    && ((latestMessage.followUpPrompts?.length ?? 0) > 0 || followupPrompts(latestMessage.blocks).length > 0)
  const showQuickPrompts = companion.capability !== 'off'
    && Boolean(companion.conversationId)
    && companion.historyReady
    && companion.turn === null
    && companion.messages.length > 0
    && !hasContextualFollowups

  return (
    <>
    <section className="page-scroll" ref={scroller} data-view-key="chat:history" aria-label="和伴星的记录">
      <div ref={content} className="thread-record-content">
      <h1 className="visually-hidden">和伴星的记录</h1>
      {companion.capability === 'off' && (
        <div className="state-note">
          <strong>书房可以先读。</strong>这台服务端没开伴星对话，手记照常能读。
        </div>
      )}
      {companion.olderAvailable && (
        <button className="continue-line" type="button" disabled={companion.loadingHistory} onClick={() => void loadOlder()}>
          <Icon name="history" />
          <span>
            <small>{companion.loadingHistory ? '正在取' : '更早的记录'}</small>
            <strong>这一段之前聊过的</strong>
          </span>
          <Icon name="chevron-right" />
        </button>
      )}
      {companion.messages.length === 0 && !companion.turn ? (
        <Welcome ready={companion.historyReady} capability={companion.capability} error={Boolean(companion.error)} />
      ) : (
        <p className="date-line">同一份交流 · 手机与桌面</p>
      )}
      {presentedMessages.map(({ key, message }) => {
        const isFirstReply = Boolean(message.runId && firstAssistantByRun.get(message.runId) === key)
        const orphanedProcess = Boolean(message.runId && message.role === 'user' && !firstAssistantByRun.has(message.runId) && message.runId !== companion.turn?.runId)
        const receipt = isFirstReply ? companion.noteEdits.find(item => item.runId === message.runId) : null
        return (
        <Fragment key={key}>
        {isFirstReply && message.runId && <RunProcess runId={message.runId} />}
        <MessageRow
          key={key}
          message={message}
          outcome={companion.runs.find((run) => run.userMessageId === message.id && !run.assistantMessageId)?.status ?? null}
          canRestore={message.id === lastRetryableMessageId}
          showFollowups={message.id === latestAssistantId}
          followupsDisabled={companion.turn !== null && !companion.turn.initiative}
          onFollowup={(prompt) => { void sendTurn(prompt) }}
          delivery={receipt ? { noteId: receipt.noteId, title: titleOf(receipt.noteId), summary: receipt.summary, at: receipt.at } : null}
        />
        {orphanedProcess && message.runId && <RunProcess runId={message.runId} />}
        </Fragment>
      )})}
      {companion.turn && (!companion.turn.initiative || companion.turn.visible) && <>
        {!firstAssistantByRun.has(companion.turn.runId) && <RunProcess key={companion.turn.runId} runId={companion.turn.runId} />}
        {(companion.turn.text || !companion.runProcesses[companion.turn.runId]?.rows.length) && <LiveRow turn={companion.turn} />}
      </>}
      {companion.proposals.map((card) => (
        <ProposalCard key={card.proposalId} card={card} />
      ))}
      {showQuickPrompts && (
        <div className="thread-quick">
          {prompts.map((text) => (
            <button key={text} type="button" onClick={() => fillDraft(text)}>{text}</button>
          ))}
        </div>
      )}
      </div>
    </section>
    {!following && <button className="thread-latest" type="button" onClick={jumpToLatest}><Icon name="arrow-right" />回到最新</button>}
    </>
  )
}

/** 提示词落进输入框，发不发由人再说一次——不替谁按下发送。 */
function fillDraft(text: string): void {
  setDraft(text)
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  input?.focus({ preventScroll: true })
  input?.setSelectionRange(text.length, text.length)
}

function Welcome({ ready, capability, error }: { ready: boolean; capability: CompanionState['capability']; error: boolean }) {
  if (!ready) {
    const unavailable = capability === 'off'
    return (
      <div className="welcome">
        <h1>{unavailable ? '书房可以先读' : error ? '还没接上书房' : '正在接上书房'}</h1>
        <p>{unavailable ? '这台服务端没有开启伴星对话，手记仍然可以正常阅读。' : error ? '对话连接没有完成，请在下方重新连接。' : '正在恢复同一份交流，接好后就可以继续。'}</p>
        {!unavailable && <p className="welcome-hint">连接完成前，草稿会留在输入框，不会提前发送。</p>}
      </div>
    )
  }
  return (
    <div className="welcome">
      <h1>今天想弄懂什么？</h1>
      <p>
        说一句想法，或从手记里挑一篇来问。
        <br />
        想留下时，再叫她整理成笔记。
      </p>
      <div className="welcome-actions">
        <button type="button" onClick={() => goTab('notes')}>
          <Icon name="book-open" />
          挑一篇来问
        </button>
        <button type="button" onClick={() => document.getElementById('chat-input')?.focus()}>
          <Icon name="message-square-text" />
          先说一句
        </button>
      </div>
      <p className="welcome-hint">正文在手机上只读；要改，跟她说。</p>
    </div>
  )
}

function MessageRow({ message, delivery, outcome, canRestore, showFollowups, followupsDisabled, onFollowup }: {
  message: CompanionState['messages'][number]
  delivery: { noteId: string; title: string; summary: string; at: string } | null
  outcome: string | null
  canRestore: boolean
  showFollowups: boolean
  followupsDisabled: boolean
  onFollowup: (prompt: string) => void
}) {
  const text = dialogueText(message.blocks)
  if (message.role === 'user') {
    const state = messageOutcome(outcome)
    const retryable = Boolean(state?.retry && canRestore && text.trim() && message.blocks.every((block) => block.type === 'text'))
    return (
      <article className="message mine" data-message-id={message.id}>
        {message.blocks.some((block) => block.type === 'image') && <MessageContent blocks={message.blocks.filter((block) => block.type === 'image')} />}
        <div className="user-bubble">{text}</div>
        {state && (
          <div className="message-outcome" role="status">
            <span>{state.label}</span>
            {retryable && <button type="button" onClick={() => fillDraft(text)}>把这句放回输入框</button>}
          </div>
        )}
      </article>
    )
  }
  if (message.role === 'system') return <p className="status-inline">{text}</p>
  return (
    <article className="message" data-message-id={message.id}>
      <div className="message-meta">
        <span>伴星</span>
        <span>{clock(message.createdAt)}</span>
      </div>
      <MessageContent blocks={message.blocks} followUpPrompts={message.followUpPrompts} onFollowup={onFollowup} showFollowups={showFollowups} followupsDisabled={followupsDisabled} />
      {delivery && (
        <button className="delivery" type="button" onClick={() => push({ kind: 'reader', noteId: delivery.noteId, title: delivery.title })}>
          <span className="delivery-cover"><Icon name="book-open" /></span>
          <span>
            <small>已更新 · 原来的笔记</small>
            <strong>{delivery.title || '她改的那一篇'}</strong>
            <em>{delivery.summary || '改动已保存'} · {clock(delivery.at)}<i className="artifact-id">{delivery.noteId.slice(0, 8)}</i></em>
          </span>
          <Icon name="chevron-right" />
        </button>
      )}
    </article>
  )
}

function LiveRow({ turn }: { turn: NonNullable<CompanionState['turn']> }) {
  return (
    <article className="message" data-phase={turn.phase}>
      <div className="message-meta">
        <span>伴星</span>
        <span role="status">{turnLine(turn)}</span>
      </div>
      {turn.text ? <DialogueMarkdown text={turn.text} /> : !turn.thinkingText && <p className="line-think" aria-hidden="true"><i /><i /><i /></p>}
      {turn.gapped && <p className="status-inline">这一段中间缺了一截，正在整段重读。</p>}
    </article>
  )
}

function useNoteTitle(): (id: string) => string {
  const notes = useNotes()
  return useMemo(() => {
    const byId = new Map(notes.list.items.map((item) => [item.id, item.title]))
    return (id: string) => byId.get(id) ?? ''
  }, [notes.list.items])
}

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function messageOutcome(status: string | null): { label: string; retry: boolean } | null {
  if (status === 'failed') return { label: '这一轮没完成', retry: true }
  if (status === 'cancelled') return { label: '这一轮已停止', retry: true }
  if (status === 'superseded') return { label: '已由后续消息接续', retry: false }
  return null
}
