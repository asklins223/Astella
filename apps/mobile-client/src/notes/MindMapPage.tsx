import { useEffect, useState } from 'react'
import type { MindMapNodeV1 } from '@astella/shared/note-mind-map-contracts'
import { Icon } from '../app/icons.tsx'
import { pop } from '../app/nav.ts'
import { localRect } from '../platform/geometry.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { closeSheet, openSheet } from '../ui/sheet-store.ts'
import { focusBlock, generateMindMap, useNotes } from '../state/notes.ts'
import { MindMapView } from './MindMapView.tsx'
import { NoteActivityPending, NoteActivityUnavailable } from './NoteActivity.tsx'
import { useSheet } from '../ui/sheet-store.ts'
import { blockText, findQuoteOrdinal } from './reading.ts'

/**
 * 思维导图那一屏。
 *
 * 摊开的是同一篇笔记的层次，不是另画一张画：点一个节点，从它那一枚长出小面板，
 * 里面是她的说明和**原文依据**——依据按下去就回到纸上原来那一格。
 */
export function MindMapPage({ noteId }: { noteId: string }) {
  const notes = useNotes()
  const root = usePhoneRoot()
  const reader = notes.reader?.noteId === noteId ? notes.reader : null
  const sheet = useSheet()
  const [focused, setFocused] = useState<MindMapNodeV1 | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const mindMap = reader?.mindMap

  // 进来就是要看这张图：没有的时候替她把任务发出去，而不是空着一屏等一次点击。
  useEffect(() => {
    if (reader?.detail && mindMap?.phase === 'idle') void generateMindMap()
  }, [reader?.detail, mindMap?.phase])

  useEffect(() => {
    setCollapsed(new Set())
    setFocused(null)
  }, [mindMap?.data?.mindMapId])

  useEffect(() => {
    if (sheet?.kind !== 'node') setFocused(null)
  }, [sheet?.kind])

  if (!reader?.detail) {
    return (
      <section className="page-scroll map-scroll" data-view-key={`map:${noteId}`} aria-label="思维导图">
        <div className="map-heading map-heading--unavailable"><div className="map-heading-mark"><Icon name="list-tree" /></div><div><p>把笔记摊成一张图</p><h1>思维导图</h1></div></div>
        <NoteActivityUnavailable motif="map" label="正在接回这篇手记" loading={reader?.loading} error={reader?.error} />
      </section>
    )
  }

  const openNode = (node: MindMapNodeV1 | null, element: HTMLElement | null) => {
    setFocused(node)
    if (!node) {
      closeSheet()
      return
    }
    const origin = element && root ? localRect(element.getBoundingClientRect(), root.getBoundingClientRect()) : { x: (root?.clientWidth ?? 0) / 2 - 40, y: 120, width: 80, height: 44 }
    const content = mindMap?.data?.content
    const hasChildren = content?.nodes.some((item) => item.parentId === node.id) ?? false
    const isCollapsed = collapsed.has(node.id)
    openSheet({
      kind: 'node',
      title: node.label,
      variant: 'glass',
      origin,
      trigger: element,
      children: <NodeCard
        node={node}
        noteId={noteId}
        sourceVersionId={mindMap?.data?.noteVersionId ?? null}
        hasChildren={hasChildren}
        collapsed={isCollapsed}
        onToggleBranch={(nodeId, nextCollapsed) => setCollapsed((current) => {
          const next = new Set(current)
          if (nextCollapsed) next.add(nodeId)
          else next.delete(nodeId)
          return next
        })}
      />,
    })
  }

  return (
    <section className="page-scroll map-scroll" data-view-key={`map:${noteId}`} data-companion-note-id={noteId} data-companion-note-version={mindMap?.data?.noteVersionId ?? reader.detail.currentVersionId} aria-label="思维导图">
      <header className="map-heading">
        <div className="map-heading-mark"><Icon name="list-tree" /></div>
        <div>
          <p>一篇手记 · 思路星图</p>
          <h1>{reader.title}</h1>
          <span>从第 {mindMap?.data?.noteVersionNumber ?? reader.detail.currentVersion.versionNo} 版正文整理</span>
        </div>
      </header>
      {mindMap && (mindMap.phase === 'idle' || mindMap.phase === 'queued' || mindMap.phase === 'running') && <NoteActivityPending motif="map" phase={mindMap.phase} label="整理层次" detail="伴星会把这一篇的层次分开，并为每一支保留原文依据。" />}
      {mindMap?.phase === 'failed' && (
        <div className="mindmap-error" role="alert">
          <span className="mindmap-error-mark"><Icon name="list-tree" /></span>
          <div><strong>星枝暂时没有接上</strong><p>{mindMap.error || '这张图没有生成完成，可以重新整理。'}</p></div>
          <button type="button" onClick={() => void generateMindMap()}>重新整理</button>
        </div>
      )}
      {mindMap?.phase === 'ready' && !mindMap.data && <div className="mindmap-error" role="alert"><span className="mindmap-error-mark"><Icon name="list-tree" /></span><div><strong>导图内容没有取到</strong><p>生成已经结束，可以重新整理这一张图。</p></div><button type="button" onClick={() => void generateMindMap()}>重新生成</button></div>}
      {mindMap?.phase === 'ready' && mindMap.data && (
        <>
          {mindMap.forVersion !== reader.detail.currentVersion.versionNo && (
            <p className="change-label"><Icon name="circle-help" />这张图是她读第 {mindMap.data.noteVersionNumber} 版时画的，正文已经到第 {reader.detail.currentVersion.versionNo} 版。</p>
          )}
          <MindMapView
            content={mindMap.data.content}
            focusedId={focused?.id ?? null}
            collapsed={collapsed}
            onToggleBranch={(nodeId, nextCollapsed) => setCollapsed((current) => {
              const next = new Set(current)
              if (nextCollapsed) next.add(nodeId)
              else next.delete(nodeId)
              return next
            })}
            onFocus={openNode}
          />
        </>
      )}
    </section>
  )
}

function NodeCard({
  node,
  noteId,
  sourceVersionId,
  hasChildren,
  collapsed,
  onToggleBranch,
}: {
  node: MindMapNodeV1
  noteId: string
  sourceVersionId: string | null
  hasChildren: boolean
  collapsed: boolean
  onToggleBranch: (nodeId: string, collapsed: boolean) => void
}) {
  const [branchCollapsed, setBranchCollapsed] = useState(collapsed)
  const activeReader = useNotes().reader
  const detail = activeReader?.noteId === noteId ? activeReader.detail : null

  useEffect(() => setBranchCollapsed(collapsed), [collapsed, node.id])

  return (
    <>
      {node.explanation && <p className="sheet-copy">{node.explanation}</p>}
      {hasChildren && (
        <button
          className="node-branch-toggle"
          type="button"
          aria-expanded={!branchCollapsed}
          onClick={() => {
            const next = !branchCollapsed
            setBranchCollapsed(next)
            onToggleBranch(node.id, next)
          }}
        >
          {branchCollapsed ? '展开这一支' : '收起这一支'}
        </button>
      )}
      {node.references.length > 0 ? (
        <>
          <div className="list-label"><span>原文依据</span><span>{node.references.length} 处</span></div>
          {node.references.map((reference, index) => {
            const blocks = detail?.currentVersion.blocks ?? []
            const original = blocks.find((block) => block.ordinal === reference.blockOrdinal)
            const ordinal = detail?.currentVersionId === sourceVersionId && original && blockText(original).includes(reference.quote)
              ? reference.blockOrdinal : findQuoteOrdinal(blocks, reference.quote)
            return (
            <button
              key={index}
              className="sheet-row"
              type="button"
              disabled={ordinal === null}
              onClick={() => {
                if (ordinal === null) return
                closeSheet()
                focusBlock(ordinal)
                pop()
              }}
            >
              <Icon name="quote" />
              <span>
                {reference.quote}
                <small>{ordinal === null ? '正文已变化，这句原文暂时无法定位' : `第 ${ordinal + 1} 段 · 回到正文`}</small>
              </span>
              <Icon name="chevron-right" />
            </button>
            )
          })}
        </>
      ) : (
        <p className="sheet-copy">这一支她没有给出原文依据。可以先回到正文那一段，圈出来问她。</p>
      )}
    </>
  )
}
