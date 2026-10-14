import { pop, push, type Pushed } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { openContextCompanion } from './context-companion.tsx'
import { generateExplainer, useNotes } from '../state/notes.ts'

/**
 * 详情屏下面那一横。
 *
 * demo 的规则是：读长文时底部**只留一件事**——回到对话里问，
 * 其余动作在纸面上，不在 dock 里堆第二排按钮。
 */
export function DetailDock({ route }: { route: Pushed }) {
  const notes = useNotes()
  const root = usePhoneRoot()
  const title = notes.reader?.title ?? ''

  if (route.kind !== 'reader') {
    return (
      <div className="detail-dock glass">
        <button className="detail-ask" type="button" onClick={event => openContextCompanion(event.currentTarget, root)}>
          <Icon name="message-square-text" />
          <span>
            和伴星聊聊这里
            <small>带着当前内容，原页仍保留</small>
          </span>
        </button>
        <button className="icon-button" type="button" onClick={pop} aria-label="回到原来的页面"><Icon name="arrow-left" /></button>
      </div>
    )
  }

  const reader = notes.reader?.noteId === route.noteId ? notes.reader : null
  const emptyReader = Boolean(reader?.detail && reader.detail.currentVersion.blocks.length === 0)

  return (
    <div className="detail-dock glass">
      <button
        className="detail-ask"
        type="button"
        onClick={event => {
          openContextCompanion(event.currentTarget, root, { label: title || '这篇手记', context: {
            pageKind: 'note',
            sharing: 'page_registered',
            noteId: route.noteId,
            ...(reader?.detail?.currentVersionId ? { noteVersionId: reader.detail.currentVersionId } : {}),
          } })
        }}
      >
        <Icon name="message-square-text" />
        <span>
          {emptyReader ? '一起整理这篇手记' : '边读边和伴星聊'}
          <small>{emptyReader ? '告诉她你想留下什么' : '原文在身后，解释与修改在这里'} </small>
        </span>
      </button>
      {!emptyReader && <button
        className="icon-button"
        type="button"
        aria-label="让她讲一段"
        onClick={() => {
          push({ kind: 'explain', noteId: route.noteId })
          void generateExplainer()
        }}
      >
        <Icon name="lightbulb" />
      </button>}
    </div>
  )
}
