import { useCallback, useEffect, useRef, type PointerEvent, type MouseEvent } from 'react'
import { navStore, pop } from './nav.ts'

const EDGE_PX = 24
const DIRECTION_SLOP = 8
const THRESHOLD_RATIO = 0.32

interface Gesture {
  id: number
  element: HTMLElement
  fromX: number
  fromY: number
  baseX: number
  startedAt: number
  width: number
  locked: boolean
  distance: number
  samples: Array<{ x: number; time: number }>
}

/** Only a deliberate horizontal swipe takes the pointer from the page. */
export function useEdgeBack(active: boolean): { dragX: number; handlers: PointerHandlers } {
  const gesture = useRef<Gesture | null>(null)
  const suppressClickUntil = useRef(0)

  const reset = useCallback((immediate = false) => {
    const current = gesture.current
    gesture.current = null
    if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
    if (current) {
      if (immediate) current.element.style.transition = 'none'
      current.element.removeAttribute('data-dragging')
      current.element.style.transform = ''
      if (immediate) requestAnimationFrame(() => { current.element.style.transition = '' })
    }
  }, [])

  useEffect(() => {
    if (!active) reset(true)
    let transitionId = navStore.get().transitionId
    const unsubscribe = navStore.subscribe(() => {
      const nextId = navStore.get().transitionId
      if (nextId === transitionId) return
      transitionId = nextId
      if (gesture.current) reset(true)
    })
    const stop = () => { if (document.hidden) reset(true) }
    document.addEventListener('visibilitychange', stop)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', stop)
      const current = gesture.current
      if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
      gesture.current = null
    }
  }, [active, reset])

  if (!active) return { dragX: 0, handlers: {} }

  return {
    dragX: 0,
    handlers: {
      onPointerDown: (event) => {
        if (!event.isPrimary || event.button !== 0 || gesture.current) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const localX = event.clientX - bounds.left
        if (localX < 0 || localX > EDGE_PX) return
        const target = event.target instanceof Element ? event.target : null
        if (!target?.closest('.edge-back-hitbox')) return
        if (target?.closest('button, a, input, textarea, select, [contenteditable="true"], [role="slider"], [data-no-edge-back]')) return
        if (window.getSelection()?.isCollapsed === false) return
        const transform = getComputedStyle(event.currentTarget).transform
        const matrix = new DOMMatrix(transform === 'none' ? undefined : transform)
        gesture.current = {
          id: event.pointerId,
          element: event.currentTarget,
          fromX: event.clientX,
          fromY: event.clientY,
          baseX: matrix.e,
          startedAt: event.timeStamp,
          width: bounds.width,
          locked: false,
          distance: 0,
          samples: [{ x: event.clientX, time: event.timeStamp }],
        }
      },
      onPointerMove: (event) => {
        const current = gesture.current
        if (!current || current.id !== event.pointerId) return
        const dx = event.clientX - current.fromX
        const dy = Math.abs(event.clientY - current.fromY)
        if (!current.locked) {
          // Preserve vertical scrolling and touch-and-hold text selection.
          if (event.timeStamp - current.startedAt > 420 || window.getSelection()?.isCollapsed === false
            || dx < -DIRECTION_SLOP || (dy > DIRECTION_SLOP && dy > Math.abs(dx) * 0.8)) {
            reset()
            return
          }
          if (dx < DIRECTION_SLOP || dx < dy * 1.25) return
          current.locked = true
          current.element.setPointerCapture(event.pointerId)
        }
        event.preventDefault()
        const distance = Math.max(0, current.baseX + dx)
        current.distance = distance > current.width ? current.width + (distance - current.width) * 0.12 : distance
        current.samples.push({ x: event.clientX, time: event.timeStamp })
        current.samples = current.samples.filter(sample => event.timeStamp - sample.time <= 100)
        // Keep pointer tracking out of React's page render. A long note should
        // not rebuild its complete DOM on every move of the user's finger.
        current.element.setAttribute('data-dragging', '1')
        current.element.style.transform = `translate3d(${current.distance}px,0,0)`
      },
      onPointerUp: (event) => {
        const current = gesture.current
        if (!current || current.id !== event.pointerId) return
        if (!current.locked) { reset(); return }
        event.preventDefault()
        suppressClickUntil.current = event.timeStamp + 450
        const first = current.samples[0]
        const last = current.samples[current.samples.length - 1]
        const velocity = first && last && event.timeStamp - last.time < 120
          ? (last.x - first.x) / Math.max(1, last.time - first.time)
          : 0
        const commit = current.distance > current.width * THRESHOLD_RATIO
          || (current.distance > 48 && velocity > 0.5)
        if (commit) {
          // Capture the visible drag before removing the outer translation.
          pop()
          reset(true)
        } else reset()
      },
      onPointerCancel: () => reset(),
      onLostPointerCapture: () => { if (gesture.current?.locked) reset() },
      onClickCapture: (event) => {
        if (event.timeStamp > suppressClickUntil.current) return
        event.preventDefault()
        event.stopPropagation()
      },
    },
  }
}

interface PointerHandlers {
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  onPointerMove?: (event: PointerEvent<HTMLElement>) => void
  onPointerUp?: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel?: (event: PointerEvent<HTMLElement>) => void
  onLostPointerCapture?: (event: PointerEvent<HTMLElement>) => void
  onClickCapture?: (event: MouseEvent<HTMLElement>) => void
}
