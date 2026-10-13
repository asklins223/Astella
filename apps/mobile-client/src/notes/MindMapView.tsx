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
  const frame = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)

  const layout = useMemo(() => layoutMindMap(content, collapsed), [content, collapsed])
  const width = Math.max(1, layout.bounds.right - layout.bounds.left)
  const height = Math.max(1, layout.bounds.bottom - layout.bounds.top)

  const fit = useCallback(() => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    const scale = Math.min(1.15, (box.width - 28) / width, (box.height - 28) / height)
    // 要居中的是**内容框**，不是坐标原点：树以主题为中心向两侧长，bounds.left 是负数，
    // 只按原点平移会把整张图推出画框（390 宽实测只剩一角可见）。
    setView({
      scale,
      x: (box.width - width * scale) / 2 - layout.bounds.left * scale,
      y: (box.height - height * scale) / 2 - layout.bounds.top * scale,
      fitted: true,
    })
  }, [height, layout.bounds.bottom, layout.bounds.left, layout.bounds.right, layout.bounds.top, width])

  const zoomAt = useCallback((factor: number, point?: Point) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box) return
    const focus = point ?? { x: box.width / 2, y: box.height / 2 }
    setView((current) => {
      const scale = clamp(current.scale * factor)
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

  // 首帧与窗口尺寸变化后重新贴合。节点展开时也重新居中，避免新分支落到画框外。
  useEffect(() => {
    const node = frame.current
    if (!node) return
    const timer = window.setTimeout(fit, 0)
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [fit])

  return (
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
          const scale = clamp(currentGesture.scale * distance / currentGesture.distance)
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
      onWheel={(event) => {
        if (!event.ctrlKey && Math.abs(event.deltaY) < 24) return
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
            style={{ left: p.x - p.width / 2, top: p.y - p.height / 2, width: p.width, minHeight: p.height }}
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

      <div className="mindmap-tools glass">
        <button type="button" className="icon-btn" onClick={() => zoomAt(1.25)} aria-label="放大">＋</button>
        <button type="button" className="icon-btn" onClick={() => zoomAt(1 / 1.25)} aria-label="缩小">－</button>
        <button type="button" className="icon-btn" onClick={fit} aria-label="看全这一张图">全</button>
      </div>
      <p className="mindmap-hint">拖动平移 · 双指缩放 · 点节点看说明和分支操作</p>
    </div>
  )
}

function clamp(scale: number): number {
  return Math.max(0.32, Math.min(2.4, scale))
}
