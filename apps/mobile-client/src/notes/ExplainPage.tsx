import { useEffect, useRef } from 'react'
import { Icon } from '../app/icons.tsx'
import { ensureExplainerHtml, focusBlock, generateExplainer, useNotes } from '../state/notes.ts'
import { findQuoteOrdinal } from './reading.ts'

/**
 * 动态讲解那一屏。
 *
 * 她讲的仍然是这一篇：上面是她备出来的那一页可动的讲解，下面把讲的次序摊开来，
 * 每一句都带着原文——听完能回到那一段自己再看一遍。
 */
export function ExplainPage({ noteId }: { noteId: string }) {
  const notes = useNotes()
  const reader = notes.reader
  const artifact = reader?.artifact

  useEffect(() => {
    if (artifact?.phase === 'idle') void generateExplainer()
  }, [artifact?.phase])

  useEffect(() => {
    if (artifact?.phase === 'ready' && artifact.data) void ensureExplainerHtml()
  }, [artifact?.phase, artifact?.data])

  if (!reader?.detail) {
    return (
      <section className="page-scroll reader-scroll" data-view-key={`explain:${noteId}`} aria-label="动态讲解">
        <article className="paper"><p className="state-note">这一篇还没取到，讲解也就没有底本。</p></article>
      </section>
    )
  }

  const blocks = reader.detail.currentVersion.blocks

  return (
    <section className="page-scroll reader-scroll" data-view-key={`explain:${noteId}`} aria-label="动态讲解">
      {(artifact && (artifact.phase === 'idle' || artifact.phase === 'queued' || artifact.phase === 'running')) && (
        <div className="task-card">
          <div className="task-top"><i />正在做</div>
          <h3>{reader.title}</h3>
          <p>{artifact.phase === 'idle' ? '正在把这件事交给她：定讲哪几句，再给每一句配动画。' : '她在备这一页讲解：先定讲哪几句，再给每一句配动画。'}</p>
          <div className="progress">
            <i style={{ width: artifact.phase === 'idle' ? '10%' : artifact.phase === 'queued' ? '18%' : '64%' }} />
          </div>
        </div>
      )}
      {artifact?.phase === 'failed' && (
        <div className="task-card error">
          <div className="task-top"><Icon name="circle-help" />这次没完成</div>
          <h3>{reader.title}</h3>
          <p>{artifact.error}</p>
          <div className="task-actions"><button type="button" onClick={() => void generateExplainer()}>再讲一次</button></div>
        </div>
      )}
      {artifact?.phase === 'ready' && artifact.data && (
        <article className="paper">
          <div className="paper-meta"><Icon name="lightbulb" />动态讲解 · {artifact.data.subject}</div>
          <h1>{artifact.data.title}</h1>
          {artifact.data.caution && <p className="compare-intro">{artifact.data.caution}</p>}
          <ArtifactFrame html={reader.artifactHtml} />
          <div className="list-label"><span>讲的次序</span><span>每一句可回原文</span></div>
          {artifact.data.outline.map((item) => {
            const ordinal = findQuoteOrdinal(blocks, item.quote)
            return (
              <div className="history-line" key={item.index}>
                <i aria-hidden="true" />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.narration}</p>
                  {ordinal === null
                    ? <small>这一句已经不在现在的正文里</small>
                    : <button className="text-action" type="button" onClick={() => focusBlock(ordinal)}>{item.quote}</button>}
                </div>
              </div>
            )
          })}
          <p className="note-end">讲解与浏览不会自动记作掌握。</p>
        </article>
      )}
    </section>
  )
}

/**
 * 讲解的画框。
 *
 * 成品 HTML 用带凭据的 fetch 取回来，再交给**同源的一页沙箱**（`public/artifact-sandbox.html`）：
 * iframe 只给 `allow-scripts`，不给 `allow-same-origin`，那一格跑在透明分界之外，
 * 读不到应用的存储与令牌；它自带 CSP，`default-src 'none'` 断掉一切外部取数。
 * 用 srcdoc 反而不行——那会继承本应用的策略，只能把整站的脚本权限放开。
 */
function ArtifactFrame({ html }: { html: string | null }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const nonce = useRef(crypto.randomUUID())

  useEffect(() => {
    if (!html) return
    const target = frame.current?.contentWindow
    if (!target) return
    let stop = false
    const post = () => target.postMessage({ kind: 'astella:artifact', nonce: nonce.current, html }, '*')
    post()
    // 沙箱页要先装好监听才听得见；确认收到之前每 120ms 递一次。
    const timer = setInterval(post, 120)
    const onMessage = (event: MessageEvent) => {
      if (event.data?.kind === 'astella:artifact:ready' && event.data.nonce === nonce.current) {
        stop = true
        clearInterval(timer)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      stop = true
      clearInterval(timer)
      window.removeEventListener('message', onMessage)
    }
  }, [html])

  if (!html) return <p className="state-note">讲解那一页正在就位。</p>
  return <iframe className="artifact" ref={frame} src="/artifact-sandbox.html" sandbox="allow-scripts" title="动态讲解" loading="lazy" />
}
