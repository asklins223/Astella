import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clamp, frames, panelPlacement, rectTransform, transformOf, type Rect } from '../platform/geometry.ts'
import { useMotion } from '../platform/motion.ts'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { Icon } from '../app/icons.tsx'
import { registerSheetDismiss } from './sheet-store.ts'

export interface SheetSpec {
  kind: string
  title: string
  /** 玻璃只给短操作面板；长内容与提问面板用纸面（demo 里 menu/spaces/attach 用玻璃）。 */
  variant?: 'glass' | 'paper'
  origin: Rect
  /** Control that opened the panel; focus returns here after its spring closes. */
  trigger?: HTMLElement | null
  children: ReactNode
}

/**
 * 上下文面板。
 *
 * 概念是 demo 定下的那一条：**面板从触发它的那一枚长出来，收起时再退回去**，
 * 底下的内容与阅读位置一动不动（遮罩只是压暗，不锁住页面）。所以这里没有居中弹窗。
 */
export function Sheet({ spec, onClose }: { spec: SheetSpec; onClose: () => void }) {
  const root = usePhoneRoot()
  const box = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const [layout, setLayout] = useState<Rect | null>(null)
  const [closing, setClosing] = useState(false)
  const motion = useMotion()

  useLayoutEffect(() => {
    if (!root) return
    const background = [...root.querySelectorAll<HTMLElement>(':scope > .topbar, :scope > .viewport, :scope > .bottom-area')]
    const previous = background.map((element) => element.inert)
    background.forEach((element) => { element.inert = true })
    return () => background.forEach((element, index) => { element.inert = previous[index] ?? false })
  }, [root])

  const finishClose = useCallback(() => {
    onClose()
    const target = spec.trigger
    if (!target) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (target.isConnected) target.focus({ preventScroll: true })
    }))
  }, [onClose, spec.trigger])

  useLayoutEffect(() => {
    const node = box.current
    if (!node || !root) return
    const size = { width: root.clientWidth, height: root.clientHeight }
    const head = node.querySelector<HTMLElement>('.sheet-head')
    const content = node.querySelector<HTMLElement>('.sheet-content')
    const shell = getComputedStyle(node)
    const px = (value: string) => Number.parseFloat(value) || 0
    const frame = px(shell.paddingTop) + px(shell.paddingBottom) + px(shell.borderTopWidth) + px(shell.borderBottomWidth)
    // `.sheet-content` is itself a scroll container; `node.scrollHeight` only
    // sees its flex viewport and undercounts long selections and action rows.
    const natural = (head?.offsetHeight ?? 0) + (content?.scrollHeight ?? 0) + frame
    const cap = spec.kind === 'ask' || spec.kind === 'selection' ? size.height * 0.76 : size.height - 76
    setLayout(panelPlacement(spec.kind, spec.origin, size, Math.min(natural, cap)))
  }, [spec, root])

  // 长出来那一下：从触发处的框变换走到最终框；关掉时走反方向的收缩。
  useLayoutEffect(() => {
    const node = box.current
    if (!node || !layout || !root || motion.off) return
    const target = { ...layout, height: node.offsetHeight }
    const start = rectTransform(spec.origin, target)
    const animation = node.animate(
      frames((p, t) => ({
        transform: transformOf({
          x: start.x * (1 - p),
          y: start.y * (1 - p),
          sx: 1 + (start.sx - 1) * (1 - p),
          sy: 1 + (start.sy - 1) * (1 - p),
        }),
        opacity: 0.12 + 0.88 * clamp(t, 0, 1),
      })),
      { duration: 460, easing: 'linear', fill: 'both' },
    )
    return () => {
      if (animation.playState !== 'finished') animation.cancel()
    }
  }, [layout, motion.off, root, spec.origin])

  useLayoutEffect(() => {
    const node = box.current
    if (!layout || closing || !node) return
    const active = document.activeElement
    if (active instanceof HTMLElement && node.contains(active)) return
    closeButton.current?.focus({ preventScroll: true })
  }, [closing, layout])

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    const node = box.current
    if (!node || !layout || !root || motion.off) {
      finishClose()
      return
    }
    closingRef.current = true
    setClosing(true)
    const computed = getComputedStyle(node)
    const matrix = new DOMMatrix(computed.transform === 'none' ? undefined : computed.transform)
    const parsedOpacity = Number.parseFloat(computed.opacity)
    const opacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1
    const destination = rectTransform(spec.origin, { ...layout, height: node.offsetHeight })
    const animation = node.animate(
      frames((progress) => ({
        transform: transformOf({
          x: matrix.e + (destination.x - matrix.e) * progress,
          y: matrix.f + (destination.y - matrix.f) * progress,
          sx: matrix.a + (destination.sx - matrix.a) * progress,
          sy: matrix.d + (destination.sy - matrix.d) * progress,
        }),
        opacity: opacity * (1 - clamp(progress * 1.3, 0, 1)),
      })),
      { duration: 340, easing: 'linear', fill: 'both' },
    )
    void animation.finished.then(finishClose).catch(() => {})
  }, [finishClose, layout, motion.off, root, spec.origin])

  useEffect(() => registerSheetDismiss(requestClose), [requestClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const containTabFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const node = box.current
    if (!node) return
    const controls = [...node.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
    if (controls.length === 0) {
      event.preventDefault()
      node.focus({ preventScroll: true })
      return
    }
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || !node.contains(active))) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && (active === last || !node.contains(active))) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }

  return (
    <div className={`modal-host${closing ? ' is-closing' : ''}`} role="presentation" inert={closing}>
      <div className="scrim" onClick={requestClose} aria-hidden="true" />
      <section
        ref={box}
        className={`sheet ${spec.variant === 'glass' ? 'glass' : 'paper-panel'}`}
        data-panel={spec.kind}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        tabIndex={-1}
        onKeyDown={containTabFocus}
        style={layout ? {
          left: `${layout.x}px`,
          top: `${layout.y}px`,
          width: `${layout.width}px`,
          height: `${layout.height}px`,
        } : { visibility: 'hidden' }}
      >
        <div className="sheet-page">
          <div className="sheet-head">
            <h2 id="sheet-title">{spec.title}</h2>
            <button ref={closeButton} className="icon-button" type="button" onClick={requestClose} aria-label="关闭面板">
              <Icon name="x" />
            </button>
          </div>
          <div className="sheet-content">{spec.children}</div>
        </div>
      </section>
    </div>
  )
}
