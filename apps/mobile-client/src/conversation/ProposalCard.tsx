import { useState } from 'react'
import { companionApi } from '../platform/api.ts'
import { decide, type ProposalCard as Card } from '../state/companion.ts'
import { Icon } from '../app/icons.tsx'

interface Review {
  before: string | null
  after: string | null
  summary: string | null
}

/**
 * 提议卡（guided 档）。
 *
 * 她要先给出"改哪一段、改成什么、影响是什么"，人点头才动手——所以这一格的重点不是
 * 按钮好看，而是**改动前后真的能核对**（demo 里那张"修改对照"同一条规矩）。
 * 指纹（payloadSha256）决定这卡还有效没有；内容变了服务端判 409，卡上就说"内容已经变了"，
 * 不替人猜。
 */
export function ProposalCard({ card }: { card: Card }) {
  const [review, setReview] = useState<Review | null>(null)
  const [pane, setPane] = useState<'before' | 'after'>('after')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const settled = card.status !== 'pending'

  const openReview = async () => {
    if (review) {
      setReview(null)
      return
    }
    setLoading(true)
    try {
      const snapshot = await companionApi.proposal(card.proposalId)
      const payload = (snapshot as unknown as { proposal?: { payload?: Record<string, unknown> } }).proposal?.payload ?? {}
      setReview({
        before: typeof payload.beforeMarkdown === 'string' ? payload.beforeMarkdown : null,
        after: typeof payload.markdown === 'string' ? payload.markdown : null,
        summary: typeof payload.summary === 'string' ? payload.summary : null,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '这一份说明取不到')
    } finally {
      setLoading(false)
    }
  }

  const shown = pane === 'after' ? review?.after : review?.before

  return (
    <section className="task-card proposal" data-status={card.status} aria-label={`伴星的提议：${card.title}`}>
      <div className="task-top">
        {settled ? <Icon name={card.status === 'succeeded' ? 'check' : 'circle-help'} /> : <i />}
        {STATUS_TEXT[card.status]}
      </div>
      <h3>{card.title}</h3>
      <p>{card.impactSummary || card.targetSummary || '她想动这一处。'}</p>
      {review && (review.before || review.after) && (
        <>
          <div className="compare-tabs" role="group" aria-label="改动对照">
            <span className="segmented-indicator" style={{ '--segment': pane === 'before' ? 0 : 1, '--segments': 2 } as React.CSSProperties} aria-hidden="true" />
            <button type="button" className={pane === 'before' ? 'active' : ''} aria-pressed={pane === 'before'} onClick={() => setPane('before')}>
              改之前
            </button>
            <button type="button" className={pane === 'after' ? 'active' : ''} aria-pressed={pane === 'after'} onClick={() => setPane('after')}>
              改之后
            </button>
          </div>
          <p className="change-label"><Icon name="check" />{pane === 'after' ? '这是她准备写进去的正文' : '这是现在正文里的那一段'}</p>
          <div className="compare-content"><p>{shown ?? '这一侧她没有给出文字。'}</p></div>
          {review.summary && <p className="status-inline">{review.summary}</p>}
        </>
      )}
      <div className="task-actions">
        <button type="button" disabled={loading} onClick={() => void openReview()}>{loading ? '正在取' : review ? '收起对照' : '看改动前后'}</button>
        {!settled && <button type="button" disabled={card.deciding} onClick={() => void decide(card.proposalId, 'reject')}>不用</button>}
        {!settled && (
          <button
            type="button"
            className="is-commit"
            disabled={card.deciding || !card.payloadSha256}
            onClick={() => void decide(card.proposalId, 'confirm')}
          >
            {card.deciding ? '正在办' : '就这么改'}
          </button>
        )}
      </div>
      {error && <p className="status-inline">{error}</p>}
      {!card.payloadSha256 && !settled && <p className="status-inline">正在核对这一份说明…</p>}
    </section>
  )
}

const STATUS_TEXT: Record<Card['status'], string> = {
  pending: '等你点头',
  rejected: '不用了',
  accepted: '已经应下',
  executing: '正在办',
  succeeded: '办好了',
  failed: '没办成',
  expired: '过期了',
}
