import { useEffect, useState } from 'react'
import type { MindMapNodeV1 } from '@astella/shared/note-mind-map-contracts'
import { Icon } from '../app/icons.tsx'
import { pop } from '../app/nav.ts'
import { localRect } from '../platform/geometry.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { closeSheet, openSheet } from '../ui/sheet-store.ts'
import { focusBlock, generateMindMap, useNotes } from '../state/notes.ts'
import { MindMapView } from './MindMapView.tsx'

/**
 * 思维导图那一屏。
 *
 * 摊开的是同一篇笔记的层次，不是另画一张画：点一个节点，从它那一枚长出小面板，
 * 里面是她的说明和**原文依据**——依据按下去就回到纸上原来那一格。
 */
export function MindMapPage({ noteId }: { noteId: string }) {
  const notes = useNotes()
  const root = usePhoneRoot()
  const reader = notes.reader
  const [focused, setFocused] = useState<MindMapNodeV1 | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const mindMap = reader?.mindMap

  // 进来就是要看这张图：没有的时候替她把任务发出去，而不是空着一屏等一次点击。
  useEffect(() => {
    if (mindMap?.phase === 'idle') void generateMindMap()
  }, [mindMap?.phase])

  useEffect(() => {
    setCollapsed(new Set())
    setFocused(null)
  }, [mindMap?.data?.mindMapId])

  if (!reader?.detail) {
    return (
      <section className="page-scroll reader-scroll" data-view-key={`map:${noteId}`} aria-label="思维导图">
        <article className="paper"><p className="state-note">这篇笔记还没取到，脑图也就没有底本。</p></article>
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
    <section className="page-scroll map-scroll" data-view-key={`map:${noteId}`} aria-label="思维导图">
      {mindMap && (mindMap.phase === 'idle' || mindMap.phase === 'queued' || mindMap.phase === 'running') && (
        <div className="task-card">
          <div className="task-top"><i />正在做</div>
          <h3>{reader.title}</h3>
          <p>{mindMap.phase === 'idle' ? '正在把这件事交给她：先把层次分出来，再给每一支找原文依据。' : '她在搭这一张图：先把层次分出来，再给每一支找原文依据。'}</p>
          <div className="progress">
            <i style={{ width: mindMap.phase === 'idle' ? '10%' : mindMap.phase === 'queued' ? '18%' : '64%' }} />
          </div>
        </div>
      )}
      {mindMap?.phase === 'failed' && (
        <div className="task-card error">
          <div className="task-top"><Icon name="circle-help" />这次没完成</div>
          <h3>{reader.title}</h3>
          <p>{mindMap.error}</p>
          <div className="task-actions"><button type="button" onClick={() => void generateMindMap()}>再画一次</button></div>
        </div>
      )}
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
  hasChildren,
  collapsed,
  onToggleBranch,
}: {
  node: MindMapNodeV1
  hasChildren: boolean
  collapsed: boolean
  onToggleBranch: (nodeId: string, collapsed: boolean) => void
}) {
  const [branchCollapsed, setBranchCollapsed] = useState(collapsed)

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
          {node.references.map((reference, index) => (
            <button
              key={index}
              className="sheet-row"
              type="button"
              onClick={() => {
                closeSheet()
                focusBlock(reference.blockOrdinal)
                pop()
              }}
            >
              <Icon name="quote" />
              <span>
                {reference.quote}
                <small>第 {reference.blockOrdinal + 1} 段 · 点开回到正文</small>
              </span>
              <Icon name="chevron-right" />
            </button>
          ))}
        </>
      ) : (
        <p className="sheet-copy">这一支她没有给出原文依据。可以先回到正文那一段，圈出来问她。</p>
      )}
    </>
  )
}
