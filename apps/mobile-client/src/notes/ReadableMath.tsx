import { useEffect, useState } from 'react'
import 'katex/dist/katex.min.css'

const mathCache = new Map<string, string | null>()

async function renderMath(value: string, display: boolean): Promise<string | null> {
  if (value.length > 10_000) return null
  const key = `${display}:${value}`
  if (mathCache.has(key)) return mathCache.get(key) ?? null
  let html: string | null = null
  try {
    // Keep the typesetting engine out of the initial mobile bundle. The first
    // formula asks for it; subsequent formulas share the browser's module cache.
    const { renderToString } = await import('katex')
    html = renderToString(value, {
      displayMode: display,
      output: 'html',
      trust: false,
      throwOnError: true,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 20,
    })
  } catch {
    // Keep unsupported or malformed source readable rather than hiding it.
  }
  mathCache.set(key, html)
  if (mathCache.size > 128) mathCache.delete(mathCache.keys().next().value!)
  return html
}

/** Bounded KaTeX output with the original source kept for fallback and anchor offsets. */
export function ReadableMath({ source, value, display }: { source: string; value: string; display: boolean }) {
  const key = `${display}:${value}`
  const [result, setResult] = useState<{ key: string; html: string | null } | null>(null)

  useEffect(() => {
    let current = true
    void renderMath(value, display).then((html) => {
      if (current) setResult({ key, html })
    })
    return () => { current = false }
  }, [display, key, value])

  const html = result?.key === key ? result.html : undefined
  if (html === undefined) {
    return <span className="note-math-pending" aria-label="正在排版公式">{source}</span>
  }
  if (!html) {
    return <span className="note-math-error" title="公式语法暂时无法排版，保留原文供核对">{source}</span>
  }
  return (
    <span className="note-math" data-display={display || undefined} role="math" aria-label={value}>
      <span className="note-math-source" aria-hidden="true">{source}</span>
      <span className="note-math-rendered" data-note-decoration="true" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
    </span>
  )
}
