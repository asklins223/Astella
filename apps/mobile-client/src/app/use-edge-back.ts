import { useCallback, useEffect, useRef, useState } from 'react'
import { pop } from './nav.ts'

/**
 * 左沿右滑退回上一层。
 *
 * 位移**跟手**：手指走多少，上层纸面就走多少（阻尼只在超过边界后加），
 * 松手不到阈值就弹回去——半途停住会让"我在哪一层"这件事说不清。
 * 只在有得退的时候接管，退无可退时那一道手势什么也不做（不去抢横向滚动）。
 */
const EDGE_PX = 22
const THRESHOLD_RATIO = 0.38

export function useEdgeBack(active: boolean): { dragX: number; handlers: PointerHandlers } {
  const [dragX, setDragX] = useState(0)
  const gesture = useRef<{ id: number; fromX: number; fromY: number; started: boolean } | null>(null)
  const width = useRef(0)

  const release = useCallback(() => {
    const value = dragX
    setDragX(0)
    gesture.current = null
    if (active && width.current > 0 && value > width.current * THRESHOLD_RATIO) pop()
  }, [active, dragX])

  if (!active) {
    return { dragX: 0, handlers: {} }
  }

  return {
    dragX,
    handlers: {
      onPointerDown: (event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const localX = event.clientX - bounds.left
        if (localX < 0 || localX > EDGE_PX) return
        width.current = bounds.width
        gesture.current = { id: event.pointerId, fromX: event.clientX, fromY: event.clientY, started: true }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event) => {
        const grab = gesture.current
        if (!grab || grab.id !== event.pointerId) return
        if (Math.abs(event.clientY - grab.fromY) > 42) {
          gesture.current = null
          setDragX(0)
          return
        }
        setDragX(Math.max(0, event.clientX - grab.fromX))
      },
      onPointerUp: release,
      onPointerCancel: () => {
        gesture.current = null
        setDragX(0)
      },
    },
  }
}

interface PointerHandlers {
  onPointerDown?: (event: React.PointerEvent) => void
  onPointerMove?: (event: React.PointerEvent) => void
  onPointerUp?: (event: React.PointerEvent) => void
  onPointerCancel?: (event: React.PointerEvent) => void
}
