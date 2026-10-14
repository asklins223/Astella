import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { clamp, panelPlacement, transformOf, type Rect } from '../platform/geometry.ts'
import { useMotion } from '../platform/motion.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { Icon } from '../app/icons.tsx'
import { isCurrentSheet, registerSheetDismiss } from './sheet-store.ts'

export interface SheetSpec {
  kind: string
  title: string
  /** Short actions use glass; sustained reading and questions use paper. */
  variant?: 'glass' | 'paper'
  origin: Rect
  trigger?: HTMLElement | null
  children: ReactNode
  /** Assigned by the store so a replaced panel owns fresh motion and focus. */
  instanceId?: number
}

const EXPANDED = new Set(['ask', 'companion-chat', 'note-picker', 'consent', 'selection', 'annotation'])
const EASE_OUT = 'cubic-bezier(.22,.9,.25,1)'

/** Replacing a sheet cancels its old animation and close callback immediately. */
export function Sheet(props: { spec: SheetSpec; onClose: () => void }) {
  return <SheetSurface key={props.spec.instanceId ?? props.spec.kind} {...props} />
}

function SheetSurface({ spec, onClose }: { spec: SheetSpec; onClose: () => void }) {
  const root = usePhoneRoot()
  const box = useRef<HTMLElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const panelAnimation = useRef<Animation | null>(null)
  const scrimAnimation = useRef<Animation | null>(null)
  const mounted = useRef(true)
  const closingRef = useRef(false)
  const drag = useRef<{ id: number; element: HTMLElement; fromX: number; fromY: number; baseX: number; baseY: number; sx: number; sy: number; dy: number; locked: boolean; samples: Array<{ y: number; time: number }> } | null>(null)
  const [layout, setLayout] = useState<Rect | null>(null)
  const [closing, setClosing] = useState(false)
  const motion = useMotion()
  const titleId = useId()
  const expanded = EXPANDED.has(spec.kind)

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      panelAnimation.current?.cancel()
      scrimAnimation.current?.cancel()
      const current = drag.current
      drag.current = null
      if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
    }
  }, [])

  useLayoutEffect(() => {
    if (!root) return
    const background = [...root.querySelectorAll<HTMLElement>(
      ':scope > .topbar, :scope > .utility-header, :scope > .viewport, :scope > .bottom-area',
    )]
    const previous = background.map(element => element.inert)
    background.forEach(element => { element.inert = true })
    return () => background.forEach((element, index) => { element.inert = previous[index] ?? false })
  }, [root])

  const finishClose = useCallback(() => {
    if (mounted.current && isCurrentSheet(spec)) onClose()
  }, [onClose, spec])

  useLayoutEffect(() => {
    const node = box.current
    if (!node || !root) return
    const head = node.querySelector<HTMLElement>('.sheet-head')
    const content = node.querySelector<HTMLElement>('.sheet-content')
    const inner = node.querySelector<HTMLElement>('.sheet-content-inner')
    const px = (value: string) => Number.parseFloat(value) || 0
    const measure = () => {
      const rect = root.getBoundingClientRect()
      const visual = window.visualViewport
      const visibleBottom = visual ? Math.min(rect.bottom, visual.height + visual.offsetTop) : rect.bottom
      const size = { width: root.clientWidth, height: Math.max(0, visibleBottom - rect.top) }
      const shell = getComputedStyle(node)
      const body = content ? getComputedStyle(content) : null
      const frame = px(shell.paddingTop) + px(shell.paddingBottom) + px(shell.borderTopWidth) + px(shell.borderBottomWidth)
      const bodyPadding = body ? px(body.paddingTop) + px(body.paddingBottom) : 0
      // The intrinsic body can expand when a tool step opens and shrink on fold.
      const natural = (head?.offsetHeight ?? 0) + (inner?.offsetHeight ?? 0) + frame + bodyPadding
      const hasExchange = Boolean(node.querySelector('[data-has-messages="true"]'))
      const conversationRatio = root.classList.contains('keyboard-on') || size.height < 500 ? 0.9 : hasExchange ? 0.76 : 0.60
      const cap = spec.kind === 'companion-chat' ? size.height * conversationRatio
        : spec.kind === 'ask' || spec.kind === 'selection' ? size.height * 0.82 : size.height - 60
      const next = panelPlacement(spec.kind, spec.origin, size, spec.kind === 'companion-chat' ? Math.max(0, cap) : Math.min(natural, Math.max(0, cap)))
      setLayout(previous => previous && Object.keys(next).every(key => previous[key as keyof Rect] === next[key as keyof Rect]) ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (inner) observer.observe(inner)
    if (head) observer.observe(head)
    observer.observe(root)
    const exchangeObserver = new MutationObserver(measure)
    if (spec.kind === 'companion-chat' && inner) exchangeObserver.observe(inner, { attributes: true, attributeFilter: ['data-has-messages'], subtree: true })
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    return () => {
      observer.disconnect()
      exchangeObserver.disconnect()
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  }, [spec, root])

  const placed = layout !== null
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !layout || motion.off) return
    const originX = clamp(spec.origin.x + spec.origin.width / 2 - layout.x, 0, layout.width)
    const originY = clamp(spec.origin.y + spec.origin.height / 2 - layout.y, 0, layout.height)
    node.style.transformOrigin = expanded ? '50% 100%' : `${originX}px ${originY}px`
    // Grow close to the trigger without stretching text from a tiny icon into
    // a full document. Reading panels arrive from their lower edge instead.
    const fromY = expanded ? 28 : clamp((spec.origin.y + spec.origin.height / 2 - layout.y - layout.height / 2) * 0.08, -16, 16)
    const animation = node.animate([
      { transform: `translate3d(0,${fromY}px,0) scale(${expanded ? 0.985 : 0.94})`, opacity: 0 },
      { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
    ], { duration: expanded ? 300 : 230, easing: EASE_OUT, fill: 'both' })
    panelAnimation.current = animation
    animation.onfinish = () => {
      if (panelAnimation.current !== animation) return
      animation.cancel()
      panelAnimation.current = null
    }
    if (scrim.current) {
      scrimAnimation.current?.cancel()
      scrimAnimation.current = scrim.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' })
    }
    return () => animation.cancel()
    // The first placement starts entrance; growing content does not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, motion.off, expanded, spec])

  useLayoutEffect(() => {
    if (!motion.off) return
    panelAnimation.current?.cancel()
    scrimAnimation.current?.cancel()
    if (box.current) box.current.style.transform = ''
    if (closingRef.current) finishClose()
  }, [motion.off, finishClose])

  useLayoutEffect(() => {
    const node = box.current
    if (!layout || closing || !node) return
    const active = document.activeElement
    if (active instanceof HTMLElement && node.contains(active)) return
    closeButton.current?.focus({ preventScroll: true })
  }, [closing, layout])

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    const node = box.current
    if (!node || !layout || motion.off) { finishClose(); return }
    const computed = getComputedStyle(node)
    const matrix = new DOMMatrix(computed.transform === 'none' ? undefined : computed.transform)
    const opacity = Number.parseFloat(computed.opacity) || 0
    panelAnimation.current?.cancel()
    const animation = node.animate([
      { transform: transformOf({ x: matrix.e, y: matrix.f, sx: matrix.a, sy: matrix.d }), opacity },
      { transform: transformOf({ x: matrix.e, y: matrix.f + (expanded ? 26 : 8), sx: matrix.a * 0.98, sy: matrix.d * 0.98 }), opacity: 0 },
    ], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' })
    panelAnimation.current = animation
    if (scrim.current) {
      const scrimOpacity = Number.parseFloat(getComputedStyle(scrim.current).opacity) || 0
      scrimAnimation.current?.cancel()
      scrimAnimation.current = scrim.current.animate([{ opacity: scrimOpacity }, { opacity: 0 }], { duration: 170, fill: 'both' })
    }
    void animation.finished.then(finishClose).catch(() => {})
  }, [finishClose, layout, motion.off, expanded])

  useLayoutEffect(() => registerSheetDismiss(requestClose), [requestClose])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const returnDrag = () => {
    const current = drag.current
    drag.current = null
    if (current?.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
    if (!current?.locked) return
    const node = box.current
    if (!node || closingRef.current) return
    const transform = getComputedStyle(node).transform
    node.style.transform = ''
    panelAnimation.current?.cancel()
    if (motion.off) return
    const animation = node.animate([{ transform }, { transform: 'translate3d(0,0,0) scale(1)' }], { duration: 180, easing: EASE_OUT })
    panelAnimation.current = animation
  }
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!expanded || !event.isPrimary || event.button !== 0 || closingRef.current
      || (event.target instanceof Element && event.target.closest('button, input, textarea, a'))) return
    drag.current = { id: event.pointerId, element: event.currentTarget, fromX: event.clientX, fromY: event.clientY, baseX: 0, baseY: 0, sx: 1, sy: 1, dy: 0, locked: false, samples: [{ y: event.clientY, time: event.timeStamp }] }
  }
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    const node = box.current
    if (!current || current.id !== event.pointerId || !node) return
    const dy = event.clientY - current.fromY
    if (!current.locked) {
      if (Math.abs(event.clientX - current.fromX) > Math.abs(dy) || dy < -8) { drag.current = null; return }
      if (dy < 8) return
      current.locked = true
      current.element.setPointerCapture(event.pointerId)
      const transform = getComputedStyle(node).transform
      const matrix = new DOMMatrix(transform === 'none' ? undefined : transform)
      current.baseX = matrix.e
      current.baseY = matrix.f
      current.sx = matrix.a
      current.sy = matrix.d
      panelAnimation.current?.cancel()
    }
    event.preventDefault()
    current.dy = Math.max(0, dy)
    current.samples.push({ y: event.clientY, time: event.timeStamp })
    current.samples = current.samples.filter(sample => event.timeStamp - sample.time <= 100)
    node.style.transform = transformOf({ x: current.baseX, y: current.baseY + current.dy, sx: current.sx, sy: current.sy })
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const first = current.samples[0]
    const last = current.samples[current.samples.length - 1]
    const velocity = first && last && event.timeStamp - last.time < 120 ? (last.y - first.y) / Math.max(1, last.time - first.time) : 0
    if (current.locked && (current.dy > Math.min(100, (layout?.height ?? 400) * 0.25) || (current.dy > 40 && velocity > 0.5))) {
      drag.current = null
      if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id)
      requestClose()
    } else returnDrag()
  }

  const containTabFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const node = box.current
    if (!node) return
    const controls = [...node.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'))
    const first = controls[0]
    const last = controls[controls.length - 1]
    const active = document.activeElement
    if (!first || !last) { event.preventDefault(); node.focus({ preventScroll: true }); return }
    if (event.shiftKey && (active === first || !node.contains(active))) { event.preventDefault(); last.focus({ preventScroll: true }) }
    else if (!event.shiftKey && (active === last || !node.contains(active))) { event.preventDefault(); first.focus({ preventScroll: true }) }
  }

  return (
    <div className={`modal-host${closing ? ' is-closing' : ''}`} role="presentation" inert={closing}>
      <div ref={scrim} className="scrim" onClick={requestClose} aria-hidden="true" />
      <section ref={box} className={`sheet ${spec.variant === 'glass' ? 'glass' : 'paper-panel'}`} data-panel={spec.kind} data-expanded={expanded} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={containTabFocus}
        style={layout ? { left: `${layout.x}px`, top: `${layout.y}px`, width: `${layout.width}px`, height: `${layout.height}px` } : { visibility: 'hidden' }}>
        <div className="sheet-page">
          <div className="sheet-head" data-draggable={expanded} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={returnDrag} onLostPointerCapture={() => { if (drag.current?.locked) returnDrag() }}>
            {expanded && <span className="sheet-grip" aria-hidden="true" />}
            <h2 id={titleId}>{spec.title}</h2>
            <button ref={closeButton} className="icon-button" type="button" onClick={requestClose} aria-label="关闭面板"><Icon name="x" /></button>
          </div>
          <div className="sheet-content"><div className="sheet-content-inner">{spec.children}</div></div>
        </div>
      </section>
    </div>
  )
}
