import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_TAG_OPENERS,
  artifactDocumentContentSecurityPolicy,
  classifyFramePolicySubject,
  isAllowedSubFrameNavigation,
  rejectAllContentSecurityPolicy,
  assembleArtifactDocument
} from '../artifact-surface'
import { ARTIFACT_TEMPLATE_PLACEHOLDER } from '../artifact-template'

const ID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const ARTIFACT_URL = `ailearn-app://artifact/${ID}`

describe('产物文档的 CSP（D4 §3.3）', () => {
  it('逐条与设计件一致：只有内联脚本／样式，没有任何外部源，没有 unsafe-eval', () => {
    expect(artifactDocumentContentSecurityPolicy()).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "connect-src 'none'",
        "worker-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
      ].join('; ')
    )
  })

  it('负对照：策略里不许出现任何外部源或 eval（这几条任何一条被加回来都要红）', () => {
    const policy = artifactDocumentContentSecurityPolicy()
    expect(policy).not.toMatch(/'unsafe-eval'/)
    expect(policy).not.toMatch(/https?:/)
    expect(policy).not.toMatch(/\*/)
    expect(policy).toContain("connect-src 'none'")
  })
})

describe('哪一类响应该套哪份策略（D4 §3.4）', () => {
  it('三路分流：主页面／产物／其余', () => {
    expect(classifyFramePolicySubject({ url: 'ailearn-app://bundle/index.html', rendererDevOrigin: null }))
      .toBe('renderer')
    expect(classifyFramePolicySubject({ url: ARTIFACT_URL, rendererDevOrigin: null }))
      .toBe('artifact')
    expect(classifyFramePolicySubject({
      url: 'http://localhost:5173/index.html',
      rendererDevOrigin: 'http://localhost:5173'
    })).toBe('renderer')
    // 负对照：别的 origin 一律收紧——主策略对一帧不可信内容太宽。
    expect(classifyFramePolicySubject({ url: 'https://example.com/x', rendererDevOrigin: null }))
      .toBe('other')
    expect(classifyFramePolicySubject({ url: 'ailearn-app://evil/index.html', rendererDevOrigin: null }))
      .toBe('other')
    expect(classifyFramePolicySubject({ url: 'not a url', rendererDevOrigin: null })).toBe('other')
    expect(rejectAllContentSecurityPolicy()).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'"
    )
  })
})

describe('子 frame 的导航（D4 §4.4）', () => {
  const initial = { frameUrl: 'about:blank', initiatedBySelf: false }

  it('放行的只有一种：宿主发起、frame 还在首次加载、目标是产物 origin', () => {
    expect(isAllowedSubFrameNavigation({ target: ARTIFACT_URL, ...initial })).toBe(true)
  })

  it('负对照：产物自己发起的导航一律拒——包括导航到主页面 origin 那一发', () => {
    // `location.href='ailearn-app://bundle/index.html'`：那是带 preload 桥的文档。
    expect(isAllowedSubFrameNavigation({
      target: 'ailearn-app://bundle/index.html',
      frameUrl: ARTIFACT_URL,
      initiatedBySelf: true
    })).toBe(false)
    // 自己导航到另一个产物 id 也拒（导航能力整个不给）。
    expect(isAllowedSubFrameNavigation({
      target: `ailearn-app://artifact/11111111-2222-4333-8444-555555555555`,
      frameUrl: ARTIFACT_URL,
      initiatedBySelf: true
    })).toBe(false)
    // 外链、表单目标、window.open 的目标都不是产物 origin。
    expect(isAllowedSubFrameNavigation({ target: 'https://example.com', ...initial })).toBe(false)
  })

  it('负对照：已经加载完之后，连"再加载一次产物"都不放行', () => {
    expect(isAllowedSubFrameNavigation({
      target: ARTIFACT_URL,
      frameUrl: ARTIFACT_URL,
      initiatedBySelf: false
    })).toBe(false)
  })
})

describe('产物文档的组装与配额（D4 §6）', () => {
  it('模板 + 内容拼成一份完整文档，内容原样落进落点（脚本要能执行）', () => {
    const content = '<h1>机会成本</h1><script>window.__artifact={stepCount:2,render(){}}</script>'
    const assembled = assembleArtifactDocument({ artifactId: ID, content })
    expect(assembled.ok).toBe(true)
    if (!assembled.ok) return
    expect(assembled.document).toContain(content)
    expect(assembled.document).not.toContain(ARTIFACT_TEMPLATE_PLACEHOLDER)
    expect(assembled.document.startsWith('<!doctype html>')).toBe(true)
    // 播放器还在（产物没把我们的模板挤掉）。
    expect(assembled.document).toContain('ailearn:artifact-frame')
  })

  it('超字节整份拒绝，不做截断后半篇', () => {
    const tooBig = 'x'.repeat(ARTIFACT_MAX_BYTES + 1)
    const result = assembleArtifactDocument({ artifactId: ID, content: tooBig })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_many_bytes')
  })

  it('标签起始符超量整份拒绝', () => {
    const manyTags = '<i></i>'.repeat(Math.ceil(ARTIFACT_MAX_TAG_OPENERS / 2) + 1)
    const result = assembleArtifactDocument({ artifactId: ID, content: manyTags })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_many_tags')
  })

  it('正对照：紧贴上限的产物仍然放行（配额不许把正常尺寸的东西挡在外面）', () => {
    const justUnder = 'y'.repeat(ARTIFACT_MAX_BYTES)
    const result = assembleArtifactDocument({ artifactId: ID, content: justUnder })
    expect(result.ok).toBe(true)
  })
})
