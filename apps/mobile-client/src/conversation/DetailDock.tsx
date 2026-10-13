import { goTab, pop, push, type Pushed } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { setDraft, setDraftContext, useCompanion } from '../state/companion.ts'
import { generateExplainer, useNotes } from '../state/notes.ts'

/**
 * 详情屏下面那一横。
 *
 * demo 的规则是：读长文时底部**只留一件事**——回到对话里问，
 * 其余动作在纸面上，不在 dock 里堆第二排按钮。
 */
export function DetailDock({ route }: { route: Pushed }) {
  const notes = useNotes()
  const companion = useCompanion()
  const title = notes.reader?.title ?? ''

  if (route.kind !== 'reader') {
    return (
      <div className="detail-dock glass">
        <button className="detail-ask" type="button" onClick={pop}>
          <Icon name="book-open" />
          <span>
            回正文
            <small>这一篇还停在原来那一格</small>
          </span>
        </button>
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
        onClick={() => {
          // 先保住用户已经写下的那句话；引用笔记只补上下文，不替人改正文或发送。
          if (!companion.draft.trim()) {
            setDraft(emptyReader
              ? `请根据我们的交流，帮我整理《${title || '这篇手记'}》。`
              : title ? `关于《${title}》：` : '')
          }
          setDraftContext({
            pageKind: 'note',
            sharing: 'page_registered',
            noteId: route.noteId,
            ...(reader?.detail?.currentVersionId ? { noteVersionId: reader.detail.currentVersionId } : {}),
          })
          goTab('chat')
          requestAnimationFrame(() => document.getElementById('chat-input')?.focus({ preventScroll: true }))
        }}
      >
        <Icon name="message-square-text" />
        <span>
          {emptyReader ? '请伴星整理这篇手记' : '问这篇笔记'}
          <small>{emptyReader ? '先生成正文，再由你确认' : '提问或修改，保留当前内容'}</small>
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
