import { describe, it, expect } from 'vitest'
import { anchorFromSelection, findQuoteOrdinal, piecesWithMarks, placementsForNote, renderBlock, blockText } from '../src/notes/reading.ts'
import type { NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import type { NoteBlockProjectionV1 } from '@astella/shared/note-projection-contracts'

const blocks: NoteBlockProjectionV1[] = [
  { ordinal: 0, type: 'heading', content: '复利的三个前提' },
  { ordinal: 1, type: 'paragraph', content: '本金**不变**，收益率可测，时间足够长。' },
  { ordinal: 2, type: 'paragraph', content: '第三条最容易被忽略。' },
]

const versionId = '11111111-1111-4111-8111-111111111111'

function annotation(anchor: NoteAnnotationV1['anchor'], id = 'a1'): NoteAnnotationV1 {
  return {
    annotationId: id,
    noteId: '22222222-2222-4222-8222-222222222222',
    anchor,
    explanation: '这一句要连着第一段看',
    sourceMessageId: null,
    generationJobId: null,
    revision: 1,
    versionState: 'current',
    createdAt: '2026-10-12T00:00:00+08:00',
    updatedAt: '2026-10-12T00:00:00+08:00',
  }
}

describe('选区到锚点', () => {
  it('块内选区能自己核对通过（服务端 noteAnchorMatchesV1 同一判据）', () => {
    const anchor = anchorFromSelection(blocks, { ordinal: 1, offset: 3 }, { ordinal: 1, offset: 6 }, versionId)
    expect(anchor).not.toBeNull()
    expect(anchor?.excerpt).toBe(blockText(blocks[1]!).slice(3, 6))
    expect(anchor?.startBlockOrdinal).toBe(1)
    expect(anchor?.endBlockOrdinal).toBe(1)
  })

  it('跨块选区按全文字符流拼原句，中间隔两行', () => {
    const anchor = anchorFromSelection(
      blocks,
      { ordinal: 1, offset: 0 },
      { ordinal: 2, offset: 2 },
      versionId,
    )
    expect(anchor).not.toBeNull()
    expect(anchor?.excerpt).toBe(`${blockText(blocks[1]!)}\n\n${blockText(blocks[2]!).slice(0, 2)}`)
  })

  it('起点等于终点时不给锚点，而不是造一条空的', () => {
    expect(anchorFromSelection(blocks, { ordinal: 1, offset: 4 }, { ordinal: 1, offset: 4 }, versionId)).toBeNull()
  })
})

describe('批注落位', () => {
  it('锚点核对得过就给出块内范围', () => {
    const anchor = anchorFromSelection(blocks, { ordinal: 1, offset: 3 }, { ordinal: 1, offset: 9 }, versionId)!
    const placements = placementsForNote(blocks, [annotation(anchor)])
    expect(placements.get(1)?.[0]?.start).toBe(3)
    expect(placements.get(1)?.[0]?.end).toBe(9)
  })

  it('锚点对不上正文时一条都不画', () => {
    const stale = annotation({
      noteVersionId: versionId,
      startBlockOrdinal: 1,
      startOffset: 0,
      endBlockOrdinal: 1,
      endOffset: 4,
      excerpt: '完全不同的字',
      prefix: '',
      suffix: '',
    })
    expect(placementsForNote(blocks, [stale]).size).toBe(0)
  })

  it('加粗的内部也算进字符流，标记不改变偏移', () => {
    // 正文是「本金**不变**，…」：`不变` 两个字在渲染文本里仍占两格，定界符不算字符。
    expect(blockText(blocks[1]!)).toBe('本金不变，收益率可测，时间足够长。')
    const anchor = anchorFromSelection(blocks, { ordinal: 1, offset: 2 }, { ordinal: 1, offset: 4 }, versionId)!
    expect(anchor.excerpt).toBe('不变')
    const pieces = piecesWithMarks(renderBlock(blocks[1]!).runs, [{ start: 2, end: 4, annotation: staleFreeAnnotation(anchor) }])
    const covered = pieces.filter((piece) => piece.annotationIds.length > 0)
    expect(covered.map((piece) => piece.text).join('')).toBe('不变')
    // 被覆盖的那一片仍然是 strong：高亮不能把行内标记吃掉
    expect(covered.some((piece) => piece.mark === 'strong')).toBe(true)
  })
})

function staleFreeAnnotation(anchor: NoteAnnotationV1['anchor']): NoteAnnotationV1 {
  return annotation(anchor)
}

describe('原文回跳', () => {
  it('整块相等优先，其次按包含找', () => {
    expect(findQuoteOrdinal(blocks, '第三条最容易被忽略。')).toBe(2)
    expect(findQuoteOrdinal(blocks, '收益率可测')).toBe(1)
  })

  it('找不到就返回 null，让屏上说"这句不在正文里"', () => {
    expect(findQuoteOrdinal(blocks, '这句早就被改掉了')).toBeNull()
  })
})

describe('渲染出来的字就是锚点认的字', () => {
  // 投影里 heading 的 content 带着 '# '（真实数据：6a54e231… 的第 0 块）。
  // 锚点用 noteBlockRenderedTextV1（树化后的纯文本），屏上要同一份字，否则高亮错位。
  const heading: NoteBlockProjectionV1 = { ordinal: 9, type: 'heading', content: '# 唐朝由盛转衰的转折：安史之乱及其前后' }

  it('去记号后再逐字对上 blockText', () => {
    const shown = renderBlock(heading).runs.map((run) => run.text).join('')
    expect(shown).toBe('唐朝由盛转衰的转折：安史之乱及其前后')
    expect(shown).toBe(blockText(heading))
  })

  it('HTML 标题写法也一样', () => {
    const html: NoteBlockProjectionV1 = { ordinal: 10, type: 'heading', content: '<h2>第一段</h2>' }
    expect(renderBlock(html).runs.map((run) => run.text).join('')).toBe('第一段')
  })
})
