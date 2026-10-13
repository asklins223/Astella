import { useState } from 'react'
import { goTab, push } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { ProposalCard } from '../conversation/ProposalCard.tsx'
import { dialogueText } from '../conversation/message-content.tsx'
import { companionLine } from '../conversation/status-line.ts'
import { interrupt, retryConversation, setDraft, useCompanion } from '../state/companion.ts'
import { useNotes } from '../state/notes.ts'

/** 只列出当前确实需要接手的工作；完整过程仍在唯一那条对话里。 */
export function HandPage() {
  const companion = useCompanion()
  const notes = useNotes()
  const [retrying, setRetrying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const pending = companion.proposals.filter((item) => item.status === 'pending')
  const latestEdit = companion.noteEdits.at(-1)
  const latestRun = companion.runs.reduce<(typeof companion.runs)[number] | undefined>(
    (latest, run) => !latest || run.generation > latest.generation ? run : latest,
    undefined,
  )
  const interrupted = latestRun && (latestRun.status === 'failed' || latestRun.status === 'cancelled')
    ? latestRun
    : undefined
  const interruptedMessage = interrupted?.userMessageId
    ? companion.messages.find((item) => item.id === interrupted.userMessageId)
    : undefined
  const interruptedText = interruptedMessage && interruptedMessage.blocks.every((block) => block.type === 'text')
    ? dialogueText(interruptedMessage.blocks).trim()
    : ''
  const connectionNeedsHelp = companion.capability !== 'off'
    && (companion.stream === 'retrying'
      || (companion.stream === 'closed' && Boolean(companion.conversationId || companion.error)))
  const restoring = companion.capability === 'unknown'
    || (companion.capability === 'on' && !companion.historyReady && !connectionNeedsHelp)
  const attentionCount = pending.length + Number(connectionNeedsHelp) + Number(Boolean(interrupted))
  const busy = Boolean(companion.turn || pending.length || connectionNeedsHelp || interrupted || restoring)

  async function reconnect() {
    if (retrying) return
    setRetrying(true)
    try {
      await retryConversation()
    } finally {
      setRetrying(false)
    }
  }

  async function stopCurrentTurn() {
    const turn = companion.turn
    if (!turn?.runId || stopping) return
    setStopping(true)
    try {
      await interrupt()
    } catch {
      // Keep the control retryable if the shared operation itself rejects.
    } finally {
      setStopping(false)
    }
  }

  function restoreInterruptedText() {
    if (!interruptedText) return
    setDraft(interruptedText)
    goTab('chat')
    requestAnimationFrame(() => document.getElementById('chat-input')?.focus({ preventScroll: true }))
  }

  return (
    <section className="page-scroll utility-scroll hand-scroll" aria-label="手边">
      <div className="utility-page hand-page">
        <header className="utility-title hand-title">
          <p className="utility-eyebrow">随时接上 · 书房进展</p>
          <div className="hand-title-row">
            <h1>手边</h1>
            <span className="hand-count"><strong>{attentionCount}</strong><span>件待接手</span></span>
          </div>
          <p className="utility-description">等你决定的事留在这里，完整交流仍在对话里。</p>
        </header>

        {restoring && (
          <div className="hand-restoring" role="status">
            <span className="hand-restoring-mark" aria-hidden="true"><i /></span>
            <span><strong>正在接回书房</strong><small>上次的交流和待办马上就到</small></span>
          </div>
        )}

        {connectionNeedsHelp && (
          <section className="hand-connection task-card" aria-label="对话连接状态">
            <div className="task-top"><Icon name="offline" />{companion.stream === 'retrying' ? '正在重新连接' : '对话没有接上'}</div>
            <p>{companion.error || '当前对话暂时断开了；你的记录和草稿仍然保留。'}</p>
            <div className="task-actions">
              <button type="button" disabled={retrying} onClick={() => void reconnect()}>
                {retrying ? '正在连接…' : '重新连接'}
              </button>
              <button type="button" onClick={() => goTab('chat')}>回到对话</button>
            </div>
          </section>
        )}

        {companion.turn && (
          <section className="hand-active task-card" aria-label="正在进行的对话">
            <div className="task-top"><i />{companionLine(companion)}</div>
            <h2>{companion.turn.statusLabel || '这一轮还在继续'}</h2>
            <p>{companion.turn.text || '伴星正在处理这条消息。切到手记不会中断这一轮。'}</p>
            <div className="task-actions">
              <button type="button" className="is-commit" onClick={() => goTab('chat')}>回到这一轮</button>
              {companion.turn.runId && (
                <button type="button" disabled={stopping} onClick={() => void stopCurrentTurn()}>
                  {stopping ? '正在停止…' : '停止这一轮'}
                </button>
              )}
            </div>
          </section>
        )}

        {pending.length > 0 && (
          <section className="hand-proposals" aria-label="等待你确认的修改">
            <h2 className="hand-section-title">等你确认</h2>
            {pending.map((card) => <ProposalCard key={card.proposalId} card={card} />)}
          </section>
        )}

        {latestEdit && (
          <section className="hand-result task-card" aria-label="最近保存的笔记修改">
            <div className="task-top"><Icon name="check" />已经保存</div>
            <h2>{notes.list.items.find((item) => item.id === latestEdit.noteId)?.title || '一篇已更新的笔记'}</h2>
            <p>{latestEdit.summary || '笔记有了新的版本。'}</p>
            <div className="task-actions">
              <button type="button" className="is-commit" onClick={() => push({ kind: 'reader', noteId: latestEdit.noteId, title: notes.list.items.find((item) => item.id === latestEdit.noteId)?.title || '' })}>
                打开笔记
              </button>
              <button type="button" onClick={() => goTab('chat')}>回到对话</button>
            </div>
          </section>
        )}

        {interrupted && (
          <section className="hand-recovery task-card" aria-label="最近一轮未完成">
            <div className="task-top"><Icon name="circle-help" />{interrupted.status === 'failed' ? '这一轮没有完成' : '这一轮已停止'}</div>
            {interruptedText && <p className="hand-recovery-quote">“{interruptedText}”</p>}
            <div className="task-actions">
              <button type="button" onClick={() => goTab('chat')}>看完整记录</button>
              {interruptedText && <button type="button" className="is-commit" onClick={restoreInterruptedText}>放回输入框</button>}
            </div>
          </section>
        )}

        {!busy && !latestEdit && (
          <div className="hand-empty">
            <HandEmptyIllustration />
            <div className="hand-empty-copy">
              <h2>{companion.capability === 'off' ? '手边暂时空着' : '现在没有待办'}</h2>
              <p>{companion.capability === 'off' ? '伴星对话暂未开放；已有手记仍可继续阅读。' : '有待确认的进展时，它会留在这里。'}</p>
            </div>
            <div className="hand-empty-actions">
              {companion.capability === 'off' ? (
                <button type="button" className="is-commit" onClick={() => goTab('notes')}>
                  <Icon name="book-open" />
                  <span>去读一本手记</span>
                  <Icon name="chevron-right" />
                </button>
              ) : (
                <>
                  <button type="button" className="is-commit" onClick={() => goTab('chat')}>
                    <Icon name="message-square-text" />
                    <span>去和伴星聊聊</span>
                    <Icon name="chevron-right" />
                  </button>
                  <button type="button" className="hand-notes-link" onClick={() => goTab('notes')}>
                    打开手记 <Icon name="arrow-right" />
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function HandEmptyIllustration() {
  return (
    <svg className="hand-empty-illustration" viewBox="0 0 180 140" aria-hidden="true">
      <ellipse cx="90" cy="122" rx="58" ry="8" fill="#dfe8f3" />
      <path d="M51 18h47l25 25v65a8 8 0 0 1-8 8H51a8 8 0 0 1-8-8V26a8 8 0 0 1 8-8Z" fill="#fff" stroke="#d4e1f0" strokeWidth="2" />
      <path d="M98 19v18a6 6 0 0 0 6 6h18" fill="#eef5fd" stroke="#d4e1f0" strokeWidth="2" />
      <path d="M59 61h28M59 71h22" stroke="#bacde3" strokeWidth="3" strokeLinecap="round" />
      <circle cx="99" cy="79" r="20" fill="#edf4fc" stroke="#d7e5f5" strokeWidth="2" />
      <path d="m90 79 6 6 12-14" fill="none" stroke="#4f7eaf" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M147 43c2 8 5 11 13 13-8 2-11 5-13 13-2-8-5-11-13-13 8-2 11-5 13-13Z" fill="#8eadd1" stroke="#4f6d90" strokeWidth="1.5" />
      <path d="M30 77c2 7 5 10 12 12-7 2-10 5-12 12-2-7-5-10-12-12 7-2 10-5 12-12Z" fill="#c4d6eb" stroke="#718bad" strokeWidth="1.5" />
    </svg>
  )
}
