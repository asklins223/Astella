import { useEffect, useMemo, useRef } from 'react'
import type { NoteAnnotationV1 } from '@astella/shared/note-annotation-contracts'
import type { NoteBlockProjectionV1 } from '@astella/shared/note-projection-contracts'
import { MobileImage } from '../ui/MobileImage.tsx'
import { noteLinkTarget } from '@astella/shared/note-markdown'
import { blockText, inlineRuns, piecesWithMarks, renderBlock, type BlockPoint, type MarkRange } from './reading.ts'
import { ReadableMath } from './ReadableMath.tsx'

interface Props {
  title: string
  blocks: readonly NoteBlockProjectionV1[]
  placements: Map<number, { start: number; end: number; annotation: NoteAnnotationV1 }[]>
  activeAnnotationId: string | null
  focusOrdinal: number | null
  onSelection: (from: BlockPoint, to: BlockPoint, text: string) => void
  onClearSelection: () => void
  onMarkClick: (annotation: NoteAnnotationV1) => void
  onNoteLink: (href: string, label: string, origin: HTMLAnchorElement) => void
}

/**
 * 笔记纸面。**只读**。
 *
 * 手机上不给任何人一个可以打字的正文框——正文由伴星改（她的改动走服务端的工具调用，
 * 前后要核对），人在这上面读、选择连续原文，再一次性带着原文去问伴星。
 *
 * 跨段选区靠 `data-s`/`data-e` 映射：每片文字都带着自己在块内字符流上的区间；
 * 选区落点直接从这两个数字读，不必从 DOM Range 猜回正文位置。
 */
export function NotePaper({
  title,
  blocks,
  placements,
  activeAnnotationId,
  focusOrdinal,
  onSelection,
  onClearSelection,
  onMarkClick,
  onNoteLink,
}: Props) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusOrdinal === null) return
    const node = root.current?.querySelector<HTMLElement>(`[data-ordinal="${focusOrdinal}"]`)
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node?.classList.add('selected')
    const timer = setTimeout(() => node?.classList.remove('selected'), 1400)
    return () => clearTimeout(timer)
  }, [focusOrdinal])

  const rendered = useMemo(() => {
    const firstContentIndex = blocks.findIndex((block) => blockText(block).trim().length > 0)
    const firstContent = blocks[firstContentIndex]
    // Some imports preserve the document title as the first body heading. The
    // paper already gives the title a single prominent place above the version
    // and reading controls; repeating it as the first section adds noise.
    const repeatedTitleIndex = firstContent?.type === 'heading'
      && blockText(firstContent).trim() === title.trim()
      ? firstContentIndex
      : -1
    return blocks
      .map((block, index) => ({ block, index, model: renderBlock(block) }))
      .filter(({ index }) => index !== repeatedTitleIndex)
  }, [blocks, title])

  return (
    <div
      className="paper-blocks"
      ref={root}
      onPointerUp={() => readSelection(root.current, onSelection, onClearSelection)}
      onKeyUp={(event) => {
        if (event.shiftKey || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          readSelection(root.current, onSelection, onClearSelection)
        }
      }}
    >
      {rendered.map(({ block, model }) => {
        const ranges = placements.get(block.ordinal) ?? []
        const pieces = piecesWithMarks(model.runs, ranges)
        const attrs = { 'data-ordinal': block.ordinal }
        if (model.kind === 'code') {
          const codePieces = piecesWithMarks([{ text: block.content, mark: 'plain' }], ranges)
          return (
            <section key={block.ordinal} className="note-block" {...attrs}>
              <pre><code>{codePieces.map((piece, pieceIndex) => (
                <Marked
                  key={pieceIndex}
                  piece={piece}
                  ranges={ranges}
                  start={pieceStart(piece, pieceIndex, codePieces)}
                  end={pieceEnd(piece, pieceIndex, codePieces)}
                  activeAnnotationId={activeAnnotationId}
                  onMarkClick={onMarkClick}
                  onNoteLink={onNoteLink}
                />
              ))}</code></pre>
            </section>
          )
        }
        if (model.kind === 'image') {
          return (
            <section key={block.ordinal} className="note-block" {...attrs}>
              <figure className="image-preview">
                <MobileImage url={model.src ?? ''} alt={model.alt ?? ''} label={model.alt ?? '笔记里的图片'} />
                {model.alt && <figcaption className="image-caption">{model.alt}</figcaption>}
              </figure>
            </section>
          )
        }
        if (model.kind === 'table' && model.rows) {
          let tableOffset = 0
          const rows = model.rows.map((row) => row.map((cell) => {
            const runs = inlineRuns(cell)
            const start = tableOffset
            tableOffset += runsLength(runs)
            const localRanges = rangesWithin(ranges, start, tableOffset)
            return { pieces: piecesWithMarks(runs, localRanges), start }
          }))
          return (
            <section key={block.ordinal} className="note-block" {...attrs}>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {rows.map((row, rowIndex) => {
                      const Cell = rowIndex === 0 ? 'th' : 'td'
                      return (
                        <tr key={rowIndex}>
                          {row.map(({ pieces: cellPieces, start }, cellIndex) => (
                            <Cell key={cellIndex}>
                              {cellPieces.map((piece, pieceIndex) => (
                                <Marked
                                  key={pieceIndex}
                                  piece={piece}
                                  ranges={ranges}
                                  start={start + pieceStart(piece, pieceIndex, cellPieces)}
                                  end={start + pieceEnd(piece, pieceIndex, cellPieces)}
                                  activeAnnotationId={activeAnnotationId}
                                  onMarkClick={onMarkClick}
                                  onNoteLink={onNoteLink}
                                />
                              ))}
                            </Cell>
                          ))}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )
        }
        if (model.kind === 'list') {
          const List = model.ordered ? 'ol' : 'ul'
          let listOffset = 0
          const items = (model.items ?? []).map((runs) => {
            const start = listOffset
            listOffset += runsLength(runs)
            const localRanges = rangesWithin(ranges, start, listOffset)
            return { pieces: piecesWithMarks(runs, localRanges), start }
          })
          return (
            <section key={block.ordinal} className="note-block" {...attrs}>
              <List>{items.map(({ pieces: itemPieces, start }, itemIndex) => (
                <li key={itemIndex}>
                  {itemPieces.map((piece, pieceIndex) => (
                  <Marked
                    key={pieceIndex}
                    piece={piece}
                    ranges={ranges}
                    start={start + pieceStart(piece, pieceIndex, itemPieces)}
                    end={start + pieceEnd(piece, pieceIndex, itemPieces)}
                    activeAnnotationId={activeAnnotationId}
                    onMarkClick={onMarkClick}
                    onNoteLink={onNoteLink}
                  />
                  ))}
                </li>
              ))}</List>
            </section>
          )
        }
        const Tag = model.kind === 'heading' ? 'h2' : model.kind === 'quote' ? 'blockquote' : 'p'
        return (
          <section key={block.ordinal} className="note-block" {...attrs}>
            <Tag>
              {/* 整块被批注时（锚点跨块，块内切不出范围）给一个块级记号，而不是悄悄什么都不画 */}
              {ranges.length > 0 && model.kind !== 'paragraph' && model.kind !== 'heading' && (
                <span className="block-mark" data-count={ranges.length} aria-hidden="true" />
              )}
              {pieces.map((piece, index) => (
                <Marked
                  key={index}
                  piece={piece}
                  ranges={ranges}
                  start={pieceStart(piece, index, pieces)}
                  end={pieceEnd(piece, index, pieces)}
                  activeAnnotationId={activeAnnotationId}
                  onMarkClick={onMarkClick}
                  onNoteLink={onNoteLink}
                />
              ))}
            </Tag>
          </section>
        )
      })}
    </div>
  )
}

// piecesWithMarks 已按批注边界切过，所以片段的起止就是它在字符流上的位置；
// 这里累加一遍而不是再算一次，避免两处口径不一致。
function pieceStart(piece: { text: string }, index: number, pieces: { text: string }[]): number {
  return pieces.slice(0, index).reduce((sum, item) => sum + Array.from(item.text).length, 0)
}

function pieceEnd(piece: { text: string }, index: number, pieces: { text: string }[]): number {
  return pieceStart(piece, index, pieces) + Array.from(piece.text).length
}

function runsLength(runs: readonly { text: string }[]): number {
  return runs.reduce((length, run) => length + Array.from(run.text).length, 0)
}

/** Clip block-wide annotation ranges to one list item or table cell. */
function rangesWithin(ranges: readonly MarkRange[], start: number, end: number): MarkRange[] {
  return ranges.flatMap((range) => {
    const clippedStart = Math.max(start, range.start)
    const clippedEnd = Math.min(end, range.end)
    if (clippedEnd <= clippedStart) return []
    return [{ ...range, start: clippedStart - start, end: clippedEnd - start }]
  })
}

interface MarkedProps {
  piece: { text: string; mark: string; href?: string; mathValue?: string; display?: boolean; annotationIds: string[] }
  ranges: { start: number; end: number; annotation: NoteAnnotationV1 }[]
  start?: number
  end?: number
  activeAnnotationId: string | null
  onMarkClick: (annotation: NoteAnnotationV1) => void
  onNoteLink: (href: string, label: string, origin: HTMLAnchorElement) => void
}

function Marked({ piece, ranges, start, end, activeAnnotationId, onMarkClick, onNoteLink }: MarkedProps) {
  let content: React.ReactNode = piece.text
  if (piece.mark === 'strong') content = <strong>{content}</strong>
  else if (piece.mark === 'em') content = <em>{content}</em>
  else if (piece.mark === 'strike') content = <s>{content}</s>
  else if (piece.mark === 'code') content = <code>{content}</code>
  else if (piece.mark === 'math') {
    content = <ReadableMath source={piece.text} value={piece.mathValue ?? piece.text} display={piece.display ?? false} />
  }
  else if (piece.mark === 'link') {
    const target = noteLinkTarget(piece.href ?? '')
    content = target
      ? <a
          href={piece.href}
          data-focus-key={`note-link:${piece.href}`}
          onClick={(event) => { event.preventDefault(); onNoteLink(piece.href ?? '', piece.text, event.currentTarget) }}
        >{content}</a>
      : <a href={piece.href} target="_blank" rel="noreferrer noopener">{content}</a>
  }

  const hit = ranges.filter((range) => start !== undefined && end !== undefined && range.start <= start && range.end >= end)
  const sourceRange = start !== undefined && end !== undefined ? { 'data-s': start, 'data-e': end } : {}
  if (hit.length === 0) return <span {...sourceRange}>{content}</span>
  const primary = hit.find((range) => range.annotation.annotationId === activeAnnotationId) ?? hit[0]!
  const isActive = primary.annotation.annotationId === activeAnnotationId
  return (
    <mark
      className={`mark${isActive ? ' is-active' : ''}`}
      data-count={hit.length}
      data-s={start}
      data-e={end}
      onClick={() => onMarkClick(primary.annotation)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onMarkClick(primary.annotation)
        }
      }}
      tabIndex={0}
      role="button"
      aria-current={isActive ? 'true' : undefined}
      aria-label={`批注：${primary.annotation.anchor.excerpt.slice(0, 24)}`}
    >
      {content}
    </mark>
  )
}

/** 把浏览器选区落到"块序号 + 块内偏移"上。落不准就当没有选区，不猜。 */
function readSelection(
  root: HTMLElement | null,
  onSelection: Props['onSelection'],
  onClear: () => void,
): void {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) {
    onClear()
    return
  }
  const text = selection.toString()
  if (!text.trim()) {
    onClear()
    return
  }
  const from = pointOf(selection.anchorNode, selection.anchorOffset, root)
  const to = pointOf(selection.focusNode, selection.focusOffset, root)
  if (!from || !to || (from.ordinal === to.ordinal && from.offset === to.offset)) {
    onClear()
    return
  }
  const [first, second] = compare(from, to) <= 0 ? [from, to] : [to, from]
  onSelection(first, second, text)
}

function pointOf(node: Node | null, offset: number, root: HTMLElement): BlockPoint | null {
  if (!node) return null
  const holder = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  if (!holder || !root.contains(holder)) return null
  // KaTeX's visible glyphs differ from the source characters used by anchors;
  // selecting it still opens the quote sheet, but cannot be saved as a precise annotation.
  if (holder.closest('[data-note-decoration="true"]')) return null
  const mark = holder.closest<HTMLElement>('[data-s]')
  const block = holder.closest<HTMLElement>('[data-ordinal]')
  if (!block) return null
  const ordinal = Number(block.dataset.ordinal)
  if (!Number.isInteger(ordinal)) return null
  if (!mark) return null
  const base = Number(mark.dataset.s)
  const end = Number(mark.dataset.e)
  const localOffset = textOffsetWithin(mark, node, offset)
  if (!Number.isInteger(base) || !Number.isInteger(end) || localOffset === null) return null
  return { ordinal, offset: Math.min(end, base + localOffset) }
}

function textOffsetWithin(mark: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = document.createRange()
    range.selectNodeContents(mark)
    range.setEnd(node, offset)
    const content = range.cloneContents()
    content.querySelectorAll('[data-note-decoration="true"]').forEach((decoration) => decoration.remove())
    return Array.from(content.textContent ?? '').length
  } catch {
    return null
  }
}

function compare(a: BlockPoint, b: BlockPoint): number {
  return a.ordinal === b.ordinal ? a.offset - b.offset : a.ordinal - b.ordinal
}
