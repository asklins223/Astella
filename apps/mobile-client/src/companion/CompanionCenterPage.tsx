import { useMemo } from 'react'
import { goTab } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { dialogueText } from '../conversation/message-content.tsx'
import { companionLine } from '../conversation/status-line.ts'
import { setChatLayout } from '../state/prefs.ts'
import { useCompanion } from '../state/companion.ts'
import { useSession } from '../state/session.ts'
import { CompanionSeat } from './CompanionSeat.tsx'

/** 伴星中心接回唯一的实时会话；尚未接通的记忆、日记入口不伪装成可操作功能。 */
export function CompanionCenterPage() {
  const companion = useCompanion()
  const session = useSession()
  const line = companionLine(companion, true)
  const latest = useMemo(() => {
    const message = [...companion.messages].reverse().find((item) => item.role === 'assistant')
    return (companion.turn?.text || (message ? dialogueText(message.blocks) : '')).replace(/\s+/g, ' ').trim()
  }, [companion.messages, companion.turn?.text])

  function returnToConversation(layout: 'scene' | 'history') {
    setChatLayout(layout, session.me?.userId)
    goTab('chat')
  }

  return (
    <section className="page-scroll utility-scroll companion-center-scroll" aria-label="伴星中心">
      <div className="utility-page companion-center-page">
        <div className="companion-hero">
          <div className="buddy-introduction">
            <p className="utility-eyebrow">学习搭档 · ASTELLA</p>
            <h1>伴星<span>从上次接着聊</span></h1>
            <p>手机和电脑，共用同一条交流。</p>
            <span className="buddy-status glass"><i />{line}</span>
          </div>
          <span className="buddy-halo" aria-hidden="true" />
          <div className="companion-center-live"><CompanionSeat /></div>
        </div>

        <div className="companion-section-heading">
          <p className="group-label">当前交流</p>
          <span>手机 · 电脑</span>
        </div>
        <div className="companion-resume glass">
          <div className="companion-resume-meta">
            <span><i />{companion.turn ? '这一轮还在继续' : companion.historyReady ? '最近的交流' : '正在恢复交流'}</span>
            <small>同一条对话</small>
          </div>
          <p className="companion-preview">
            {latest || (companion.capability === 'off' ? '当前服务尚未开放伴星对话。' : '还没有新的回复，回去告诉她你想聊什么。')}
          </p>
          <div className="companion-resume-foot"><span>{session.me?.workspaceName ?? '当前书房'}</span><span>草稿会一起保留</span></div>
        </div>

        <button className="companion-center-primary" type="button" onClick={() => returnToConversation('scene')}>
          <Icon name="message-square-text" />
          <span><strong>回到伴星身边</strong><small>接着当前交流，草稿也会保留</small></span>
          <Icon name="chevron-right" />
        </button>
        <button className="companion-center-secondary" type="button" onClick={() => returnToConversation('history')}>
          <Icon name="book-open" />
          <span>翻开完整记录</span>
          <Icon name="arrow-right" />
        </button>
      </div>
    </section>
  )
}
