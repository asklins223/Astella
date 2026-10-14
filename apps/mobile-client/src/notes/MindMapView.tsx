import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { layoutMindMap } from '@astella/shared/note-mind-map-layout'
import type { MindMapContentV1, MindMapNodeV1 } from '@astella/shared/note-mind-map-contracts'

interface Props {
  content: MindMapContentV1
  focusedId: string | null
  collapsed: ReadonlySet<string>
  onToggleBranch: (nodeId: string, collapsed: boolean) => void
  /** 第二个参数是那一枚节点本身：面板要从它长出来，就得知道它在哪。 */
  onFocus: (node: MindMapNodeV1 | null, nodeElement: HTMLElement | null) => void
}

type Point = { x: number; y: number }
type Gesture =
  | { kind: 'pan'; id: number; start: Point; origin: Point }
  | { kind: 'pinch'; ids: [number, number]; distance: number; scale: number; content: Point }

/**
 * 思维导图。
 *
 * 布局用公共层那一份（两端同一张图必须落在同一坐标），这里只管两件事：把树画成
 * 一块可拖可缩的纸，以及**点一个节点就在下面展开它那一格说明**。手机上不求一眼看全
 * 整棵树——看得清比看得全重要，所以默认按宽度贴合，其余靠拖动与缩放。
 */
export function MindMapView({ content, focusedId, collapsed, onToggleBranch, onFocus }: Props) {
  const [view, setView] = useState({ x: 0, y: 0, scale: 1, fitted: false })
  const [mode, setMode] = useState<'diagram' | 'outline'>('diagram')
  const frame = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const fitScale = useRef(0.32)
  const measured = useRef<{ width: number; height: number; content: MindMapContentV1 } | null>(null)

  const layout = useMemo(() => layoutMindMap(content, collapsed), [content, collapsed])
  const width = Math.max(1, layout.bounds.right - layout.bounds.left)
  const height = Math.max(1, layout.bounds.bottom - layout.bounds.top)

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || box.width <= 28 || box.height <= 28) return
    const desiredScale = Math.min(1.15, (box.width - 28) / width, (box.height - 28) / height)
    // Keep the first view readable and tappable. A large map intentionally opens
    // around its subject; the reader can zoom out when they want the whole tree.
    const scale = Math.max(1, desiredScale)
    fitScale.current = scale
    const fits = desiredScale >= 1
    setView({
      scale,
      x: fits ? (box.width - width * scale) / 2 - layout.bounds.left * scale : box.width / 2,
      y: fits ? (box.height - height * scale) / 2 - layout.bounds.top * scale : box.height / 2,
      fitted: true,
    })
  }, [height, layout.bounds.bottom, layout.bounds.left, layout.bounds.right, layout.bounds.top, width])

  const zoomAt = useCallback((factor: number, point?: Point) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    const focus = point ?? { x: box.width / 2, y: box.height / 2 }
    setView((current) => {
      const scale = clamp(current.scale * factor, fitScale.current)
      const contentX = (focus.x - current.x) / current.scale
      const contentY = (focus.y - current.y) / current.scale
      return { ...current, x: focus.x - contentX * scale, y: focus.y - contentY * scale, scale }
    })
  }, [])

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = frame.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const beginPinch = (entries: Array<[number, Point]>) => {
    const pair = entries.slice(0, 2)
    if (pair.length < 2) return
    const [[firstId, first], [secondId, second]] = pair as [[number, Point], [number, Point]]
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y))
    gesture.current = {
      kind: 'pinch',
      ids: [firstId, secondId],
      distance,
      scale: view.scale,
      content: { x: (center.x - view.x) / view.scale, y: (center.y - view.y) / view.scale },
    }
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    const remaining = [...pointers.current.entries()]
    if (remaining.length >= 2) {
      beginPinch(remaining)
    } else if (remaining.length === 1) {
      const [id, point] = remaining[0]!
      gesture.current = { kind: 'pan', id, start: point, origin: { x: view.x, y: view.y } }
    } else {
      gesture.current = null
    }
  }

  const childrenOf = (id: string) => layout.children.get(id) ?? []

  // 重排分支时保留当前位置，只在首次打开或画框真的变大/变小时贴合。
  useEffect(() => {
    const node = frame.current
    if (!node) return
    const measure = () => {
      const size = node.getBoundingClientRect()
      const prior = measured.current
      const changed = !prior || prior.content !== content || Math.abs(prior.width - size.width) > 1 || Math.abs(prior.height - size.height) > 1
      measured.current = { width: size.width, height: size.height, content }
      if (changed) fit()
    }
    const timer = window.setTimeout(measure, 0)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [fit, mode, content])

  const outline = useMemo(() => {
    const result: Array<{ node: MindMapNodeV1; depth: number }> = []
    const visit = (id: string, depth: number) => {
      const node = content.nodes.find((item) => item.id === id)
      if (!node) return
      result.push({ node, depth })
      if (!collapsed.has(id)) for (const child of layout.children.get(id) ?? []) visit(child.id, depth + 1)
    }
    visit(content.rootId, 0)
    return result
  }, [content, collapsed, layout.children])

  return (
    <div className="mindmap-workspace">
      <div className="mindmap-view-switch" role="group" aria-label="导图显示方式">
        <button type="button" aria-pressed={mode === 'diagram'} onClick={() => setMode('diagram')}>导图</button>
        <button type="button" aria-pressed={mode === 'outline'} onClick={() => setMode('outline')}>阅读提纲</button>
      </div>
      {mode === 'outline' ? (
        <div className="mindmap-outline" aria-label="导图阅读提纲">
          {outline.map(({ node, depth }) => (
            <div className="mindmap-outline-row" key={node.id} style={{ marginLeft: Math.min(depth, 3) * 12 }}>
              <button type="button" data-focused={focusedId === node.id ? '1' : '0'} onClick={(event) => onFocus(node, event.currentTarget)}>
                <strong>{node.label}</strong>
                <small>{node.references.length ? `${node.references.length} 处原文依据 · 查看说明` : '查看说明'}</small>
              </button>
              {childrenOf(node.id).length > 0 && <button className="outline-branch-toggle" type="button" aria-label={`${collapsed.has(node.id) ? '展开' : '收起'}${node.label}的分支`} aria-expanded={!collapsed.has(node.id)} onClick={() => onToggleBranch(node.id, !collapsed.has(node.id))}>{collapsed.has(node.id) ? '＋' : '－'}</button>}
            </div>
          ))}
        </div>
      ) : <>
    <div
      className="mindmap"
      ref={frame}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        if (pointers.current.size === 0) suppressClick.current = false
        pointers.current.set(event.pointerId, localPoint(event))
        if (pointers.current.size === 1) {
          const point = localPoint(event)
          gesture.current = { kind: 'pan', id: event.pointerId, start: point, origin: { x: view.x, y: view.y } }
        } else {
          // 两指操作始终用于缩放，不会误点到下面的节点。
          suppressClick.current = true
          beginPinch([...pointers.current.entries()])
        }
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return
        const point = localPoint(event)
        pointers.current.set(event.pointerId, point)
        const currentGesture = gesture.current
        if (!currentGesture) return
        if (currentGesture.kind === 'pan' && currentGesture.id === event.pointerId) {
          const dx = point.x - currentGesture.start.x
          const dy = point.y - currentGesture.start.y
          if (Math.hypot(dx, dy) <= 6 && !suppressClick.current) return
          if (Math.hypot(dx, dy) > 6) {
            suppressClick.current = true
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer may have been cancelled */ }
            }
          }
          setView((current) => ({ ...current, x: currentGesture.origin.x + dx, y: currentGesture.origin.y + dy }))
        } else if (currentGesture.kind === 'pinch' && currentGesture.ids.every((id) => pointers.current.has(id))) {
          const first = pointers.current.get(currentGesture.ids[0])!
          const second = pointers.current.get(currentGesture.ids[1])!
          const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
          const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y))
          const scale = clamp(currentGesture.scale * distance / currentGesture.distance, fitScale.current)
          setView((current) => ({
            ...current,
            scale,
            x: center.x - currentGesture.content.x * scale,
            y: center.y - currentGesture.content.y * scale,
          }))
        }
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={(event) => {
        if (pointers.current.has(event.pointerId)) finishPointer(event)
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) {
          setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
          return
        }
        const point = localPoint(event)
        zoomAt(event.deltaY > 0 ? 0.9 : 1.1, point)
      }}
    >
      <div className="mindmap-canvas" style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}>
        <svg
          className="mindmap-links"
          viewBox={`${layout.bounds.left} ${layout.bounds.top} ${width} ${height}`}
          style={{ left: layout.bounds.left, top: layout.bounds.top, width, height }}
          aria-hidden="true"
        >
          {layout.positions.filter((p) => p.node.parentId).map((p) => {
            const parent = layout.positions.find((item) => item.node.id === p.node.parentId)
            if (!parent) return null
            const x1 = parent.x + (parent.side === 0 ? (p.side === 1 ? parent.width / 2 : -parent.width / 2) : parent.side * (parent.width / 2))
            const x2 = p.x - p.side * (p.width / 2)
            const mid = (x1 + x2) / 2
            return (
              <path
                key={p.node.id}
                className={`link branch-${((p.branch % 4) + 4) % 4}`}
                d={`M ${x1} ${parent.y} C ${mid} ${parent.y}, ${mid} ${p.y}, ${x2} ${p.y}`}
                fill="none"
              />
            )
          })}
        </svg>
        {layout.positions.map((p) => (
          <button
            key={p.node.id}
            className={`node node-${p.node.kind}`}
            data-focused={focusedId === p.node.id ? '1' : '0'}
            data-collapsed={collapsed.has(p.node.id) ? '1' : '0'}
            style={{ left: p.x - p.width / 2, top: p.y - p.height / 2, width: p.width, minHeight: Math.max(68, p.height) }}
            aria-label={`${p.node.label}${childrenOf(p.node.id).length ? '，有下级分支' : ''}${p.node.references.length ? `，${p.node.references.length} 处原文依据` : ''}`}
            onClick={(event) => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onFocus(focusedId === p.node.id ? null : p.node, event.currentTarget)
            }}
          >
            <span className="node-label">{p.node.label}</span>
            {p.node.references.length > 0 && <span className="node-marks">{p.node.references.length}</span>}
            {childrenOf(p.node.id).length > 0 && <span className="node-kids" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="mindmap-tools glass" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="icon-btn" onClick={() => zoomAt(1.25)} aria-label="放大">＋</button>
        <button type="button" className="icon-btn" onClick={() => zoomAt(1 / 1.25)} aria-label="缩小">－</button>
        <button type="button" className="icon-btn" onClick={fit} aria-label="回到主题节点">主题</button>
      </div>
      <p className="mindmap-hint">拖动平移 · 双指缩放 · 点节点看说明和分支操作</p>
    </div>
      </>}
    </div>
  )
}

function clamp(scale: number, fittedScale: number): number {
  return Math.max(Math.min(0.32, fittedScale), Math.min(2.4, scale))
}
