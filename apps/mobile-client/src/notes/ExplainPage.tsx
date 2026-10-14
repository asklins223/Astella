import { useEffect, useRef, useState } from 'react'
import { Icon } from '../app/icons.tsx'
import { pop } from '../app/nav.ts'
import { ensureExplainerHtml, focusBlock, generateExplainer, useNotes } from '../state/notes.ts'
import { findQuoteOrdinal } from './reading.ts'
import { NoteActivityPending, NoteActivityUnavailable } from './NoteActivity.tsx'

/**
 * 动态讲解那一屏。
 *
 * 她讲的仍然是这一篇：上面是她备出来的那一页可动的讲解，下面把讲的次序摊开来，
 * 每一句都带着原文——听完能回到那一段自己再看一遍。
 */
export function ExplainPage({ noteId }: { noteId: string }) {
  const notes = useNotes()
  const reader = notes.reader?.noteId === noteId ? notes.reader : null
  const artifact = reader?.artifact
  const artifactId = artifact?.data?.artifactId
  const [frameFailed, setFrameFailed] = useState(false)
  const [frameAttempt, setFrameAttempt] = useState(0)

  useEffect(() => {
    if (reader?.detail && artifact?.phase === 'idle') void generateExplainer()
  }, [reader?.detail, artifact?.phase])

  useEffect(() => {
    let active = true
    setFrameFailed(false)
    if (artifact?.phase === 'ready' && artifactId) {
      void ensureExplainerHtml().then((html) => { if (active) setFrameFailed(!html) })
    }
    return () => { active = false }
  }, [artifact?.phase, artifactId, frameAttempt])

  if (!reader?.detail) {
    return (
      <section className="page-scroll explain-scroll" data-view-key={`explain:${noteId}`} aria-label="动态讲解">
        <div className="explain-empty-heading"><span><Icon name="lightbulb" /></span><p>伴星整理的一页</p><h1>动态讲解</h1></div>
        <NoteActivityUnavailable motif="lesson" label="正在接回这篇手记" loading={reader?.loading} error={reader?.error} />
      </section>
    )
  }

  const blocks = reader.detail.currentVersion.blocks

  return (
    <section className="page-scroll explain-scroll" data-view-key={`explain:${noteId}`} data-companion-note-id={noteId} data-companion-note-version={artifact?.data?.noteVersionId ?? reader.detail.currentVersionId} aria-label="动态讲解">
      <header className="explain-heading">
        <div className="explain-heading-mark"><Icon name="lightbulb" /></div>
        <div className="explain-heading-copy">
          <p>伴星为这一篇留下的讲解</p>
          <h1>{reader.title}</h1>
          <div className="explain-edition"><span>依据第 {artifact?.data?.noteVersionNumber ?? reader.detail.currentVersion.versionNo} 版</span><i />{artifact?.data?.outline.length ?? 0} 段讲解</div>
        </div>
      </header>
      {artifact && (artifact.phase === 'idle' || artifact.phase === 'queued' || artifact.phase === 'running') && <NoteActivityPending motif="lesson" phase={artifact.phase} label="准备讲解" detail="伴星会先梳理要点，再将它们做成可以互动的讲解。" />}
      {artifact?.phase === 'failed' && (
        <div className="explain-error" role="alert">
          <Icon name="circle-help" /><div><strong>讲解没有准备好</strong><p>{artifact.error || '这次没有生成完成，可以重新试一次。'}</p></div>
          <button type="button" onClick={() => void generateExplainer()}>重新讲解</button>
        </div>
      )}
      {artifact?.phase === 'ready' && !artifact.data && <div className="explain-error" role="alert"><Icon name="circle-help" /><div><strong>讲解内容没有取到</strong><p>生成已经结束，可以重新准备这一页。</p></div><button type="button" onClick={() => void generateExplainer()}>重新生成</button></div>}
      {artifact?.phase === 'ready' && artifact.data && (
        <article className="explain-lesson">
          <div className="explain-artifact-caption"><span><Icon name="lightbulb" />{artifact.data.subject}</span><small>可以边看边问</small></div>
          {artifact.data.title !== reader.title && <h2 className="explainer-title">{artifact.data.title}</h2>}
          {artifact.data.noteVersionNumber !== reader.detail.currentVersion.versionNo && <p className="state-note">讲解依据第 {artifact.data.noteVersionNumber} 版，当前正文是第 {reader.detail.currentVersion.versionNo} 版。原文入口只跳到仍能匹配的内容。</p>}
          {artifact.data.caution && <p className="compare-intro">{artifact.data.caution}</p>}
          {frameFailed || reader.artifactHtmlError ? <div className="explain-artifact-error" role="alert"><Icon name="circle-help" /><p>{reader.artifactHtmlError || '讲解已生成，但画面没有加载成功。下面的要点仍可阅读。'}</p><button type="button" onClick={() => setFrameAttempt((value) => value + 1)}>重新加载画面</button></div> : <ArtifactFrame key={artifactId} html={reader.artifactHtmlFor === artifactId ? reader.artifactHtml : null} />}
          <div className="explain-outline-heading"><span>她是这样讲的</span><small>{artifact.data.outline.length} 个段落 · 每段都能回原文</small></div>
          <div className="explain-outline">
          {artifact.data.outline.map((item) => {
            const ordinal = findQuoteOrdinal(blocks, item.quote)
            return (
              <article className="explain-beat" key={item.index}>
                <span className="explain-beat-number">{String(item.index).padStart(2, '0')}</span>
                <div className="explain-beat-copy">
                  <h2>{item.title}</h2>
                  <p>{item.narration}</p>
                  {ordinal === null
                    ? <small>这一句已经不在现在的正文里</small>
                    : <button className="text-action explainer-quote" type="button" onClick={() => { focusBlock(ordinal); pop() }}><span>{item.quote}</span><small><Icon name="arrow-right" />回到原文</small></button>}
                </div>
              </article>
            )
          })}
          </div>
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
  const [received, setReceived] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!html) return
    const target = frame.current?.contentWindow
    if (!target) return
    setReceived(false)
    setTimedOut(false)
    const post = () => target.postMessage({ kind: 'astella:artifact', nonce: nonce.current, html }, '*')
    post()
    // 沙箱页要先装好监听才听得见；确认收到之前每 120ms 递一次。
    const timer = setInterval(post, 120)
    const onMessage = (event: MessageEvent) => {
      if (event.source === target && event.data?.kind === 'astella:artifact:ready' && event.data.nonce === nonce.current) {
        setReceived(true)
        clearInterval(timer)
        clearTimeout(timeout)
      }
    }
    const timeout = window.setTimeout(() => { clearInterval(timer); setTimedOut(true) }, 12_000)
    window.addEventListener('message', onMessage)
    return () => {
      clearInterval(timer)
      clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
    }
  }, [html, attempt])

  if (!html) return <div className="artifact-load-pending" role="status" aria-live="polite"><span aria-hidden="true" /><p>讲解素材正在送到画框里…</p></div>
  return <div className="artifact-stage" aria-busy={!received && !timedOut}>
    {!received && <div className="artifact-opening state-note" role={timedOut ? 'alert' : 'status'}>{timedOut ? <><p>讲解画面没有响应，可以重新打开。</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重新打开</button></> : '正在打开讲解画面…'}</div>}
    <iframe className="artifact" ref={frame} src="/artifact-sandbox.html" sandbox="allow-scripts" title="动态讲解" loading="eager" />
  </div>
}
