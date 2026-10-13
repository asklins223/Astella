import { noteAnchorBlockRangeV1, noteAnchorMatchesV1 } from '@astella/shared/note-annotation-contracts'
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import { noteBlockRenderedTextV1, parseInlineMarkdown, parseMarkdownTable } from '@astella/shared/note-doc-schema'
import { noteEquationLabels, noteEquationValue, noteImageHtmlAttrs } from '@astella/shared/note-markdown'
import type { NoteBlockProjectionV1 } from '@astella/shared/note-projection-contracts'

/**
 * 笔记的阅读模型。
 *
 * 一条硬约束：**批注偏移量按真实文本节点算**（`noteBlockRenderedTextV1` 就是那份
 * 文字流），所以这里不能自己再拼一遍正文——多算一个空格、少算一个换行，标出来的
 * 高亮就会整体错位一格。做法是把块拆成"扁平字符流 + 每段自己的行内标记"，
 * 高亮只在字符流上切，切完仍按原标记排版。
 */

export interface FlatRun {
  text: string
  mark: 'plain' | 'strong' | 'em' | 'strike' | 'code' | 'math' | 'link'
  href?: string
  mathValue?: string
  display?: boolean
}

export interface BlockRender {
  kind: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'image' | 'table'
  runs: FlatRun[]
  items?: FlatRun[][]
  ordered?: boolean
  caption?: string
  src?: string
  alt?: string
  body?: string
  rows?: readonly (readonly string[])[]
}

const LIST_MARK = /^(\s*)([-*+]|\d+[.)])\s+/
const QUOTE_MARK = /^\s*>\s?/

export function inlineRuns(value: string): FlatRun[] {
  const segments = parseInlineMarkdown(value)
  const equations = segments.flatMap((segment) => segment.kind === 'math' && segment.display ? [segment.value] : [])
  const labels = noteEquationLabels(equations)
  let equationNumber = 0
  return segments.map((segment): FlatRun => {
    switch (segment.kind) {
      case 'strong':
        return { text: segment.text, mark: 'strong' }
      case 'em':
        return { text: segment.text, mark: 'em' }
      case 'strike':
        return { text: segment.text, mark: 'strike' }
      case 'code':
        return { text: segment.text, mark: 'code' }
      case 'math':
        // 保留原始定界符：存的、批注偏移算的都是 TeX 源，只有排版那一步另算。
        return {
          text: segment.text,
          mark: 'math',
          mathValue: noteEquationValue(segment.value, labels, segment.display ? ++equationNumber : undefined),
          display: segment.display,
        }
      case 'link':
        return { text: segment.text, mark: 'link', href: segment.href }
      case 'image':
        // 图片不占字符：给它算一个字符，后面每一格偏移都会错。
        return { text: '', mark: 'plain' }
      default:
        return { text: segment.text, mark: 'plain' }
    }
  }).filter((run) => run.text.length > 0)
}

export function blockText(block: NoteBlockProjectionV1): string {
  return noteBlockRenderedTextV1(block.type, block.content)
}

export function renderBlock(block: NoteBlockProjectionV1): BlockRender {
  const content = block.content
  switch (block.type) {
    case 'heading': {
      // 投影里的 heading 内容带着 markdown 记号（'# 唐朝…'）。锚点那一侧
      // `noteBlockRenderedTextV1` 走的是树化之后的纯文本，所以这里也必须去记号——
      // 留着 `#` 会让整段文字比锚点多两个字符，批注高亮从此错位。
      const heading = content.replace(/^\s*<h[1-6]\b[^>]*>/i, '').replace(/<\/h[1-6]>\s*$/i, '').replace(/^\s*#{1,6}\s+/, '')
      return { kind: 'heading', runs: inlineRuns(heading) }
    }
    case 'code':
      return { kind: 'code', runs: [{ text: content, mark: 'plain' }], body: content }
    case 'quote':
      return { kind: 'quote', runs: inlineRuns(content.replace(QUOTE_MARK, '')) }
    case 'list': {
      const lines = content.split('\n').filter((line) => line.trim() !== '')
      const ordered = LIST_MARK.test(lines[0] ?? '') && /^\s*\d/.test(lines[0] ?? '')
      return {
        kind: 'list',
        ordered,
        runs: [],
        items: lines.map((line) => inlineRuns(line.replace(LIST_MARK, ''))),
      }
    }
    case 'image': {
      const htmlImage = noteImageHtmlAttrs(content)
      const image = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(content)
      const htmlSrc = typeof htmlImage?.src === 'string' ? htmlImage.src : undefined
      const htmlAlt = typeof htmlImage?.alt === 'string' ? htmlImage.alt : undefined
      return { kind: 'image', runs: [], src: htmlSrc ?? image?.[2], alt: htmlAlt ?? image?.[1] ?? '' }
    }
    default: {
      const rows = parseMarkdownTable(content)
      // The shared grammar keeps the Markdown separator row so callers can
      // recognize alignment syntax. It is not note text and must not appear as
      // a literal row of dashes in the reading view.
      if (rows) return { kind: 'table', runs: [], rows: rows.filter((_, index) => index !== 1) }
      return { kind: 'paragraph', runs: inlineRuns(content) }
    }
  }
}

export interface MarkRange {
  start: number
  end: number
  annotation: NoteAnnotationV1
}

/**
 * 整篇的批注落位：先在**全文**上核对锚点，再逐块算范围。
 *
 * 只核对单块会把跨段的批注判成"对不上"；核对全文而范围按块切，才与桌面端
 * `note-annotation-placement.ts` 那条一致。对不上就一条都不画——画一条错位的高亮
 * 比不画更糟，用户会以为是笔记变了。
 */
export function placementsForNote(
  blocks: readonly NoteBlockProjectionV1[],
  annotations: readonly NoteAnnotationV1[],
): Map<number, MarkRange[]> {
  const placements = new Map<number, MarkRange[]>()
  for (const annotation of annotations) {
    if (!noteAnchorMatchesV1(blocks, annotation.anchor)) continue
    for (const block of blocks) {
      const range = noteAnchorBlockRangeV1(block, annotation.anchor)
      if (!range) continue
      const list = placements.get(block.ordinal) ?? []
      list.push({ start: range[0], end: range[1], annotation })
      placements.set(block.ordinal, list)
    }
  }
  return placements
}

export interface TextPiece {
  text: string
  mark: FlatRun['mark']
  href?: string
  mathValue?: string
  display?: boolean
  annotationIds: string[]
}

/**
 * 一行文字切成"带同样标记、按批注边界分段"的碎片。
 *
 * 高亮不能靠 `<span>` 套 `<span>`：行内标记与批注交叠时会画出嵌套很深的结构，
 * 字号与行距一抖动，偏移就变了。改成先在字符流上求出所有边界，再逐段发碎片。
 */
export function piecesWithMarks(runs: readonly FlatRun[], ranges: readonly MarkRange[]): TextPiece[] {
  if (runs.length === 0) return []
  const flat: { char: string; mark: FlatRun['mark']; href?: string; mathValue?: string; display?: boolean }[] = []
  const mathAtoms: Array<{ start: number; end: number }> = []
  for (const run of runs) {
    const start = flat.length
    for (const char of Array.from(run.text)) {
      flat.push({ char, mark: run.mark, href: run.href, mathValue: run.mathValue, display: run.display })
    }
    if (run.mark === 'math' && flat.length > start) mathAtoms.push({ start, end: flat.length })
  }
  const boundaries = new Set<number>([0, flat.length])
  for (const atom of mathAtoms) {
    boundaries.add(atom.start)
    boundaries.add(atom.end)
  }
  const snapMathBoundary = (offset: number, edge: 'start' | 'end') => {
    const atom = mathAtoms.find((item) => offset > item.start && offset < item.end)
    return atom ? edge === 'start' ? atom.start : atom.end : offset
  }
  for (const range of ranges) {
    const start = Math.max(0, Math.min(flat.length, range.start))
    const end = Math.max(0, Math.min(flat.length, range.end))
    boundaries.add(snapMathBoundary(start, 'start'))
    boundaries.add(snapMathBoundary(end, 'end'))
  }
  const offsets = [...boundaries].sort((a, b) => a - b)
  const pieces: TextPiece[] = []
  for (let index = 0; index < offsets.length - 1; index++) {
    const start = offsets[index]!
    const end = offsets[index + 1]!
    if (end <= start) continue
    const math = flat[start]!.mark === 'math'
    const ids = ranges
      .filter((range) => math ? range.start < end && range.end > start : range.start <= start && range.end >= end)
      .map((range) => range.annotation.annotationId)
    let buffer = ''
    let mark = flat[start]!.mark
    let href = flat[start]!.href
    let mathValue = flat[start]!.mathValue
    let display = flat[start]!.display
    for (let cursor = start; cursor < end; cursor++) {
      const cell = flat[cursor]!
      if (buffer && (cell.mark !== mark || cell.href !== href || cell.mathValue !== mathValue || cell.display !== display)) {
        pieces.push({ text: buffer, mark, href, mathValue, display, annotationIds: ids })
        buffer = ''
        mark = cell.mark
        href = cell.href
        mathValue = cell.mathValue
        display = cell.display
      }
      buffer += cell.char
    }
    if (buffer) pieces.push({ text: buffer, mark, href, mathValue, display, annotationIds: ids })
  }
  return pieces
}

export interface BlockPoint {
  ordinal: number
  offset: number
}

/**
 * 一句原文回到它那一块。
 *
 * 讲解大纲与脑图节点带的是**引用文本**（合同里就无块序号那一列，脑图有、大纲没有），
 * 所以"点一下就跳到原文"必须自己找：先按整块相等找，再按包含找。
 * 找不到就返回 null——屏上说"这句不在现在的正文里"，比跳到随便一块上诚实。
 */
export function findQuoteOrdinal(blocks: readonly NoteBlockProjectionV1[], quote: string): number | null {
  const wanted = quote.trim()
  if (!wanted) return null
  for (const block of blocks) {
    if (blockText(block).trim() === wanted) return block.ordinal
  }
  for (const block of blocks) {
    if (blockText(block).includes(wanted)) return block.ordinal
  }
  return null
}

/**
 * 纸面上选中的一截 → 批注锚点。
 *
 * 锚点存的是"块序号 + 块内字符偏移 + 原句 + 前后文"，其中**原句与前后文要按全文那份
 * 字符流**拼（跨块用 `\n\n` 相接），拼错了服务端会判 `note_anchor_mismatch`。
 * 所以这里先拼，再自己用同一个判据核一遍：核不过就不给这个入口，而不是让服务端报错。
 */
export function anchorFromSelection(
  blocks: readonly NoteBlockProjectionV1[],
  from: BlockPoint,
  to: BlockPoint,
  noteVersionId: string,
): NoteAnnotationAnchorV1 | null {
  const byOrdinal = new Map(blocks.map((block) => [block.ordinal, block]))
  const startBlock = byOrdinal.get(from.ordinal)
  const endBlock = byOrdinal.get(to.ordinal)
  if (!startBlock || !endBlock || from.ordinal > to.ordinal) return null

  const span = blocks.filter((block) => block.ordinal >= from.ordinal && block.ordinal <= to.ordinal)
  const stream = span.map((block) => blockText(block)).join('\n\n')
  // span 从起点块开始数，所以起点就是块内偏移；终点要把前面每一块（含分隔的两行）都算进去。
  const startInStream = from.offset
  const endBase = span.slice(0, span.length - 1).reduce((sum, block) => sum + blockText(block).length + 2, 0)
  const endInStream = endBase + to.offset
  if (endInStream <= startInStream) return null

  const excerpt = stream.slice(startInStream, endInStream)
  const anchor: NoteAnnotationAnchorV1 = {
    noteVersionId,
    startBlockOrdinal: startBlock.ordinal,
    startOffset: from.offset,
    endBlockOrdinal: endBlock.ordinal,
    endOffset: to.offset,
    excerpt,
    prefix: stream.slice(Math.max(0, startInStream - 24), startInStream),
    suffix: stream.slice(endInStream, endInStream + 24),
  }
  return noteAnchorMatchesV1(blocks, anchor) ? anchor : null
}
