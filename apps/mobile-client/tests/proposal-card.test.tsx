import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalCard } from '../src/conversation/ProposalCard.tsx'
import type { ProposalCard as Card } from '../src/state/companion.ts'

/**
 * 提议卡是 guided 档唯一能"先给你看"的那一步，形状不许漂：
 * 要有改动前后可核对的入口、有不成交的退路，**指纹没到手之前确认键必须是禁用的**
 * —— 服务端不许按没核对过的内容确认，客户端先断了这条退路。
 */
function card(patch: Partial<Card>): Card {
  return {
    proposalId: '11111111-1111-4111-8111-111111111111',
    title: '把第二段改成表格',
    targetSummary: '《唐朝由盛转衰的转折》· 第 1 版',
    impactSummary: '正文第二段换排版，其余不动',
    payloadSha256: '',
    status: 'pending',
    deciding: false,
    runId: null,
    ...patch,
  }
}

describe('提议卡（真实事件够不到时的形状守卫）', () => {
  it('等你点头时三枚键都在，指纹未到手就先禁用「就这么改」', () => {
    const html = renderToStaticMarkup(<ProposalCard card={card({})} />)
    expect(html).toContain('看改动前后')
    expect(html).toContain('不用')
    expect(html).toContain('就这么改')
    expect(html).toContain('把第二段改成表格')
    const confirm = /<button[^>]*class="is-commit"[^>]*/.exec(html)
    expect(confirm?.[0]).toMatch(/disabled/)
  })

  it('指纹到手后才允许按确认', () => {
    const html = renderToStaticMarkup(<ProposalCard card={card({ payloadSha256: 'a'.repeat(64) })} />)
    const confirm = /<button[^>]*class="is-commit"[^>]*/.exec(html)
    expect(confirm?.[0]).not.toMatch(/disabled/)
  })

  it('办完之后三枚键都收起来，只留状态那一行', () => {
    const html = renderToStaticMarkup(<ProposalCard card={card({ status: 'succeeded', payloadSha256: 'a'.repeat(64) })} />)
    expect(html).toContain('办好了')
    expect(html).not.toContain('就这么改')
  })

  it('对照入口在卡上：改前/改后两段只在点了「看改动前后」之后出现', () => {
    const html = renderToStaticMarkup(<ProposalCard card={card({ payloadSha256: 'a'.repeat(64) })} />)
    expect(html).toContain('看改动前后')
    // 没点开就不该有两段正文：对照是要真去取改动前后的内容，不是先把内容摆出来
    expect(html).not.toContain('改之前')
    expect(html).not.toContain('改之后')
  })
})
