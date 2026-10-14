import { Icon } from '../app/icons.tsx'
import { pop } from '../app/nav.ts'
import type { TaskPhase } from '../state/notes.ts'

/** 任务阶段共用真实状态，讲解与脑图各自用自己的空间来表达等待。 */
export function NoteActivityPending({ phase, label, detail, motif }: { phase: TaskPhase; label: string; detail: string; motif: 'lesson' | 'map' }) {
  const map = motif === 'map'
  return (
    <section className={`note-activity-pending note-activity-pending--${motif}`} role="status" aria-live="polite">
      <div className="activity-illustration" aria-hidden="true">
        {map ? <>
          <span className="activity-orbit activity-orbit--one" /><span className="activity-orbit activity-orbit--two" />
          <i className="activity-node activity-node--root" /><i className="activity-node activity-node--left" /><i className="activity-node activity-node--right" />
        </> : <>
          <span className="activity-page activity-page--back" /><span className="activity-page activity-page--front" />
          <i className="activity-line activity-line--one" /><i className="activity-line activity-line--two" /><i className="activity-line activity-line--three" />
        </>}
      </div>
      <div className="activity-copy">
        <p className="activity-kicker"><span className="activity-wait-mark" aria-hidden="true" />{phase === 'queued' ? '正在排队' : phase === 'idle' ? '准备开始' : `正在${label}`}</p>
        <h2>{map ? '把这一篇的思路展开' : '把讲解页慢慢备好'}</h2>
        <p>{detail}</p>
        <small>准备完成后会出现在这里；现在可以回正文接着读。</small>
        <button type="button" className="activity-back" onClick={pop}>回正文继续读 <Icon name="arrow-right" /></button>
      </div>
    </section>
  )
}

export function NoteActivityUnavailable({ label, loading, error, motif }: { label: string; loading?: boolean; error?: string | null; motif: 'lesson' | 'map' }) {
  return (
    <section className={`note-activity-unavailable note-activity-unavailable--${motif}`}>
      <span className="unavailable-mark"><Icon name={motif === 'map' ? 'list-tree' : 'lightbulb'} /></span>
      <div>
        <h2>{label}</h2>
        <p role={error ? 'alert' : 'status'}>{loading ? '正在接回这篇手记…' : error || '这篇手记暂时没有打开。'}</p>
      </div>
      {!loading && <button type="button" className="activity-back" onClick={pop}>回到正文 <Icon name="arrow-right" /></button>}
    </section>
  )
}
