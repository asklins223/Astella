import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { finishTransition, type NavDirection } from './nav.ts'
import { clamp } from '../platform/geometry.ts'
import { focusDestination, transitionEntrySeed } from './navigation-visuals.ts'

/** 一级分区轻移，详情页按 push／pop 进退；离场副本只负责视觉，不承接事件或焦点。 */
export function Viewport({
  children,
  direction,
  transitionId,
  motionOff,
  scrollRestoreReady,
  transitionHost,
  viewKey,
  scrollPositions,
}: {
  children: ReactNode
  direction: NavDirection
  transitionId: number
  motionOff: boolean
  scrollRestoreReady: boolean
  transitionHost: RefObject<HTMLDivElement | null>
  viewKey: string
  scrollPositions: Map<string, { top: number; left: number }>
}) {
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scrollable = inner.current?.querySelector<HTMLElement>('.page-scroll')
    if (!scrollable) return
    const remember = () => scrollPositions.set(viewKey, { top: scrollable.scrollTop, left: scrollable.scrollLeft })
    scrollable.addEventListener('scroll', remember, { passive: true })
    return () => {
      // Navigation captures the outgoing page synchronously before React removes
      // its content. On unmount, children may already be gone and the browser can
      // clamp scrollTop to zero; saving here would overwrite the valid position.
      scrollable.removeEventListener('scroll', remember)
    }
  }, [scrollPositions, viewKey])
  useLayoutEffect(() => {
    if (!scrollRestoreReady) return
    const scrollable = inner.current?.querySelector<HTMLElement>('.page-scroll')
    const saved = scrollPositions.get(viewKey)
    if (!scrollable || !saved) return
    // A detail route can return before its note has loaded. Restoring against the
    // temporary loading card clamps scrollTop to zero, so wait for the real body.
    scrollable.scrollTop = saved.top
    scrollable.scrollLeft = saved.left
  }, [scrollPositions, scrollRestoreReady, viewKey])
  useLayoutEffect(() => {
    const node = inner.current
    const host = transitionHost.current
    if (!node || direction === 'none' || transitionId === 0) return
    const ghost = host?.querySelector<HTMLElement>(`[data-transition-id="${transitionId}"]`) ?? null
    let current = true
    const complete = () => {
      if (!current) return
      ghost?.remove()
      finishTransition(transitionId)
    }
    if (motionOff) {
      complete()
      return
    }
    const width = node.clientWidth || window.innerWidth
    const isTab = direction === 'tab-forward' || direction === 'tab-backward'
    const tabSign = direction === 'tab-forward' ? 1 : -1
    const seed = transitionEntrySeed(transitionId, viewKey)
    const from = seed?.x ?? (direction === 'push' ? width
      : direction === 'pop' ? -width * 0.2
        : tabSign * Math.min(48, width * 0.12))
    const startOpacity = seed ? Math.max(0.5, seed.opacity) : isTab ? 0.72 : 1
    const ghostStyle = ghost ? getComputedStyle(ghost) : null
    const currentTransform = ghostStyle?.transform ?? 'none'
    const parsedOpacity = ghostStyle ? Number.parseFloat(ghostStyle.opacity) : 1
    const currentOpacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1
    const matrix = new DOMMatrix(currentTransform === 'none' ? undefined : currentTransform)
    const exitX = direction === 'push' ? -width * 0.2
      : direction === 'pop' ? width
        : -tabSign * Math.min(48, width * 0.12)
    const distance = Math.max(Math.abs(from), Math.abs(exitX - matrix.e))
    const duration = isTab ? 240 : clamp(190 + distance / width * 150, 190, 350)
    const easing = 'cubic-bezier(.22,.9,.25,1)'
    const enter = node.animate(
      [
        { transform: `translate3d(${from}px,0,0)`, opacity: startOpacity },
        { transform: 'translate3d(0,0,0)', opacity: 1 },
      ],
      { duration, easing },
    )
    const leavingFrames: Keyframe[] = direction === 'pop'
      ? [
          { transform: `translate3d(${matrix.e}px,0,0)`, opacity: currentOpacity },
          { transform: `translate3d(${exitX}px,0,0)`, opacity: currentOpacity },
        ]
      : [
          { transform: `translate3d(${matrix.e}px,0,0)`, opacity: currentOpacity },
          { transform: `translate3d(${matrix.e + (exitX - matrix.e) * 0.68}px,0,0)`, opacity: 0, offset: 0.52 },
          { transform: `translate3d(${exitX}px,0,0)`, opacity: 0 },
        ]
    const leaving = ghost?.animate(leavingFrames, { duration, easing })
    void Promise.all([enter.finished, ...(leaving ? [leaving.finished] : [])])
      .then(complete)
      .catch(() => {})
    return () => {
      current = false
      enter.cancel()
      leaving?.cancel()
    }
  }, [direction, transitionId, motionOff, transitionHost, viewKey])
  useLayoutEffect(() => {
    if (scrollRestoreReady) return focusDestination(inner.current, direction, viewKey)
  }, [direction, scrollRestoreReady, transitionId, viewKey])
  return <div className="page-layer" ref={inner} data-view-key={viewKey}>
    {children}
    {!viewKey.startsWith('map:') && <div className="edge-back-hitbox" aria-hidden="true" />}
  </div>
}

