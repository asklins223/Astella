import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dialogueText, MessageContent } from '../src/conversation/message-content.tsx'

describe('回答与查阅材料的阅读关系', () => {
  const blocks = [
    { type: 'text', text: '**能量没变少**，只是更难做功。' },
    { type: 'quote', label: '热力学手记', text: '原文里还包含下一章的长表格。' },
  ]

  it('当前话语不把查阅的原文拼成伴星对白', () => {
    expect(dialogueText(blocks)).toBe('**能量没变少**，只是更难做功。')
  })

  it('记录保留原文并独立展开，正文使用真实 Markdown 排版', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, { blocks }))
    expect(html).toContain('<strong>能量没变少</strong>')
    expect(html).toContain('<summary>查阅的材料 · 热力学手记</summary>')
    expect(html).toContain('原文里还包含下一章的长表格。')
  })

  it('模型文字不能通过 HTML 或链接注入可执行内容', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, { blocks: [
      { type: 'text', text: '<script>alert(1)</script>\n\n[危险链接](javascript:alert(2))\n\n**可读正文**' },
    ] }))
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('<strong>可读正文</strong>')
  })

  it('私有图片不通过裸 img URL 读取，记录会显示带鉴权读取状态', () => {
    const html = renderToStaticMarkup(createElement(MessageContent, { blocks: [
      { type: 'image', url: '/api/uploads/11111111-1111-4111-8111-111111111111/companion/22222222-2222-4222-8222-222222222222.png', label: '白板.png' },
    ] }))
    expect(html).toContain('正在打开图片…')
    expect(html).not.toContain('src="/api/uploads/')
    expect(html).toContain('白板.png')
  })
})
