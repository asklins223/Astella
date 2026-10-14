import { useLayoutEffect, useMemo, useRef } from 'react'
import { CompanionSeat } from '../companion/CompanionSeat.tsx'
import { sendTurn, useCompanion } from '../state/companion.ts'
import { useSession } from '../state/session.ts'
import { setChatLayout } from '../state/prefs.ts'
import { push } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { dialogueText, DialogueMarkdown, FollowupSuggestions, followupPrompts } from './message-content.tsx'
import { companionLine, turnLine } from './status-line.ts'
import { RunProcess } from './RunProcess.tsx'
import { presentMessages } from './presentation.ts'

/**
 * 伴星那一屏。
 *
 * 概念是「她在，这一句正在说」：名字在顶上收小，她占整块中部，
 * 正在说的话落在**她自己那一侧**（气泡在她脚下，不压到正文区），
 * 想看全部就一句"看完整对话"——两种视图共用同一段交流。
 */
export function SceneChat() {
  const companion = useCompanion()
  const session = useSession()
  const latestAssistant = useMemo(
    () => presentMessages(companion.messages).reverse().find((entry) => entry.message.role === 'assistant')?.message ?? null,
    [companion.messages],
  )
  const latest = latestAssistant ? dialogueText(latestAssistant.blocks) : ''
  const latestMessage = companion.messages.at(-1)
  const prompts = latestMessage?.role === 'assistant'
    ? latestMessage.followUpPrompts?.length ? latestMessage.followUpPrompts : followupPrompts(latestMessage.blocks)
    : []

  const visibleTurn = companion.turn && (!companion.turn.initiative || companion.turn.visible) ? companion.turn : null
  const currentUtterance = visibleTurn && latestAssistant?.runId === visibleTurn.runId ? latest : ''
  const text = visibleTurn ? visibleTurn.text || currentUtterance : latest
  const speech = useRef<HTMLDivElement>(null)
  const staysAtLatest = useRef(true)
  const lastEntry = useRef<string | null>(null)
  const entryKey = visibleTurn
    ? `run:${visibleTurn.runId || visibleTurn.generation}`
    : latestAssistant?.id ?? null

  useLayoutEffect(() => {
    const node = speech.current
    if (!node) return
    const isNewEntry = entryKey !== lastEntry.current
    if (isNewEntry || staysAtLatest.current) node.scrollTop = node.scrollHeight
    staysAtLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
    lastEntry.current = entryKey
  }, [entryKey, text])
  const shownRunId = visibleTurn?.runId || latestAssistant?.runId
  const hasProcess = Boolean(shownRunId && companion.runProcesses[shownRunId]?.rows.length)
  const edit = shownRunId ? companion.noteEdits.find(item => item.runId === shownRunId) : null
  const pending = companion.proposals.filter((card) => card.status === 'pending').length

  return (
    <section className="page-scroll scene-scroll" data-view-key="chat:scene" aria-label="当前对话">
      <div className="companion-scene">
        <div className="scene-title">
          <div className="scene-title-main">
            <h1 className="scene-title-heading">伴星</h1>
            <button type="button" onClick={(event) => push({ kind: 'companion' }, event.currentTarget)} aria-label="进入伴星中心">
            <Icon name="chevron-right" />
            </button>
          </div>
          <span>{session.me?.isPersonal === false ? `${session.me?.workspaceName} · 只读` : '和你在同一个书房'}</span>
        </div>
        <CompanionSeat />
        <div className="scene-speech glass">
          <span className="bubble-speaker">
            伴星<i />
            <span>{companionLine(companion)}</span>
          </span>
          {(!visibleTurn || text || !hasProcess) && <div
            className="scene-reply"
            ref={speech}
            onScroll={(event) => {
              const node = event.currentTarget
              staysAtLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            }}
          >
            {companion.capability === 'off'
              ? '这台服务端没开对话，手记还是可以读。'
              : !companion.historyReady
                ? companion.error ? '对话暂时没接上，请在下方重新连接。' : '正在接上书房，连好后就能继续聊。'
                : text ? <DialogueMarkdown text={text} />
                  : visibleTurn ? <p role="status">{turnLine(visibleTurn)}</p>
                    : '我在。想聊什么，直接告诉我。'}
          </div>}
          {shownRunId && <RunProcess runId={shownRunId} mode="compact" />}
          {!visibleTurn && prompts.length > 0 && (
            <FollowupSuggestions prompts={prompts} onSend={(prompt) => { void sendTurn(prompt) }} disabled={!companion.historyReady} />
          )}
          {(text || visibleTurn || edit || pending > 0) && (
            <div className="bubble-links">
              {edit && (
                <button className="bubble-more" type="button" onClick={() => push({ kind: 'reader', noteId: edit.noteId, title: '' })}>
                  打开笔记
                </button>
              )}
              {pending > 0 && <button className="bubble-more" type="button" onClick={() => setChatLayout('history', session.me?.userId)}>有 {pending} 项等你确认</button>}
              <button className="bubble-more" type="button" onClick={() => setChatLayout('history', session.me?.userId)}>看完整对话</button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
