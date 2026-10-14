import type { FocusEvent, SyntheticEvent } from 'react'
import type { NavDirection } from './nav.ts'

interface FocusTarget {
  id: string | null
  key: string | null
  label: string | null
  tag: string
  path: number[]
}

const focusReturns = new Map<string, FocusTarget>()
const pendingFocusTargets = new Map<string, FocusTarget>()
const focusReturnStack: Array<{ viewKey: string; target: FocusTarget }> = []
let pendingPopFocus: { viewKey: string; target: FocusTarget } | null = null
let entrySeed: { transitionId: number; viewKey: string; x: number; opacity: number } | null = null

export function clearNavigationVisuals(): void {
  focusReturns.clear()
  pendingFocusTargets.clear()
  focusReturnStack.length = 0
  pendingPopFocus = null
  entrySeed = null
}

/** A quick reversal continues the previous page from where it is still visible. */
export function transitionEntrySeed(transitionId: number, viewKey: string): { x: number; opacity: number } | null {
  return entrySeed?.transitionId === transitionId && entrySeed.viewKey === viewKey ? entrySeed : null
}

export function captureOutgoingPage(
  host: HTMLDivElement | null,
  transitionId: number,
  direction: NavDirection,
  origin: HTMLElement | null | undefined,
  scrollPositions: Map<string, { top: number; left: number }>,
  motionOff = false,
): void {
  const viewport = host?.parentElement
  const source = origin?.closest<HTMLElement>('.page-scroll')
    ?? viewport?.querySelector<HTMLElement>(':scope > .page-layer > .page-scroll')
  if (!host || !viewport || !source) return
  const viewKey = source.parentElement?.dataset.viewKey
  // Commit the outgoing position synchronously, before route state changes can
  // resize/unmount the page or a new note's loading card can clamp the scroller.
  if (viewKey) scrollPositions.set(viewKey, { top: source.scrollTop, left: source.scrollLeft })
  const active = document.activeElement
  const clickedTarget = origin && source.contains(origin)
    ? describeFocusTarget(origin, source)
    : viewKey ? pendingFocusTargets.get(viewKey) : undefined
  if (viewKey && clickedTarget) {
    focusReturns.set(viewKey, clickedTarget)
  } else if (viewKey && active instanceof HTMLElement && source.contains(active)) {
    focusReturns.set(viewKey, describeFocusTarget(active, source))
  }
  const savedTarget = viewKey ? focusReturns.get(viewKey) : undefined
  if (viewKey && direction === 'push' && savedTarget) {
    focusReturnStack.push({ viewKey, target: savedTarget })
    if (focusReturnStack.length > 32) focusReturnStack.shift()
  } else if (direction === 'pop') {
    pendingPopFocus = focusReturnStack.pop() ?? null
  } else if (direction === 'tab-forward' || direction === 'tab-backward') {
    focusReturnStack.length = 0
    pendingPopFocus = null
  }
  if (viewKey) pendingFocusTargets.delete(viewKey)
  if (viewKey && focusReturns.has(viewKey)) {
    if (focusReturns.size > 32) focusReturns.delete(focusReturns.keys().next().value!)
  }
  entrySeed = null
  const previous = host.querySelector<HTMLElement>('.route-ghost-frame')
  if (previous?.dataset.viewKey && !motionOff) {
    const style = getComputedStyle(previous)
    const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform)
    entrySeed = { transitionId, viewKey: previous.dataset.viewKey, x: matrix.e, opacity: Number.parseFloat(style.opacity) || 0 }
  }
  host.replaceChildren()
  host.dataset.direction = direction
  if (motionOff) return
  const pageLayer = source.parentElement
  if (!pageLayer) return
  const layerStyle = getComputedStyle(pageLayer)
  const viewportStyle = getComputedStyle(viewport)
  const outer = new DOMMatrix(viewportStyle.transform === 'none' ? undefined : viewportStyle.transform)
  const inner = new DOMMatrix(layerStyle.transform === 'none' ? undefined : layerStyle.transform)
  const frame = document.createElement('div')
  frame.className = 'route-ghost-frame'
  frame.dataset.transitionId = String(transitionId)
  frame.dataset.viewKey = viewKey ?? ''
  Object.assign(frame.style, {
    transform: `translate3d(${outer.e + inner.e}px,${outer.f + inner.f}px,0)`,
    opacity: layerStyle.opacity,
    width: `${viewport.clientWidth}px`,
    height: `${viewport.clientHeight}px`,
  })
  const copy = source.cloneNode(true) as HTMLElement
  copy.setAttribute('aria-hidden', 'true')
  copy.removeAttribute('id')
  copy.inert = true
  copy.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  copy.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => element.setAttribute('tabindex', '-1'))
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
  const clones = [copy, ...copy.querySelectorAll<HTMLElement>('*')]
  // A detached clone has no scroll range. Attach it before restoring the paper
  // and nested response/table scrollers, or the browser silently clamps to zero.
  frame.append(copy)
  host.append(frame)
  for (let index = 0; index < Math.min(originals.length, clones.length); index += 1) {
    const original = originals[index]!
    const clone = clones[index]!
    clone.scrollTop = original.scrollTop
    clone.scrollLeft = original.scrollLeft
    if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      clone.value = original.value
      clone.checked = original.checked
    } else if (original instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
      clone.value = original.value
    } else if (original instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      clone.value = original.value
    } else if (original instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement) {
      try { clone.getContext('2d')?.drawImage(original, 0, 0) } catch { /* WebGL canvas is kept out of the page snapshot. */ }
    }
  }
}

function sameViewFamily(from: string, to: string): boolean {
  // A tab's presentation setting may change while a detail page is open; the
  // return target is still valid as long as navigation returns to the same tab.
  const family = (key: string) => key.includes(':') ? key.slice(0, key.indexOf(':')) : key
  return family(from) === family(to)
}

export function captureClickedFocus(event: SyntheticEvent<HTMLDivElement>): void {
  const page = phoneRootPage(event.currentTarget)
  const viewKey = page?.parentElement?.dataset.viewKey
  if (!page || !viewKey) return
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('button, a, input, textarea, select, [tabindex]')
    : null
  if (target && page.contains(target)) pendingFocusTargets.set(viewKey, describeFocusTarget(target, page))
  else pendingFocusTargets.delete(viewKey)
}

export function captureFocusedTarget(event: FocusEvent<HTMLDivElement>): void {
  const page = phoneRootPage(event.currentTarget)
  const viewKey = page?.parentElement?.dataset.viewKey
  const target = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>('button, a, input, textarea, select, [tabindex]')
    : null
  if (!page || !viewKey || !target || !page.contains(target)) return
  pendingFocusTargets.set(viewKey, describeFocusTarget(target, page))
}

function phoneRootPage(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('.viewport > .page-layer > .page-scroll')
}

function describeFocusTarget(active: HTMLElement, page: HTMLElement): FocusTarget {
  const path: number[] = []
  let current = active
  while (current !== page) {
    const parent = current.parentElement
    if (!parent) break
    path.unshift(Array.prototype.indexOf.call(parent.children, current) as number)
    current = parent
  }
  return {
    id: active.id || null,
    key: active.dataset.focusKey ?? null,
    label: active.getAttribute('aria-label'),
    tag: active.tagName,
    path,
  }
}

function resolveFocusTarget(page: HTMLElement, target: FocusTarget): HTMLElement | null {
  if (target.id) {
    const element = document.getElementById(target.id)
    if (element instanceof HTMLElement && page.contains(element)) return element
  }
  if (target.key) {
    const element = [...page.querySelectorAll<HTMLElement>('[data-focus-key]')]
      .find((item) => item.dataset.focusKey === target.key)
    if (element) return element
  }
  if (target.label) {
    const element = [...page.querySelectorAll<HTMLElement>('[aria-label]')]
      .find((item) => item.tagName === target.tag && item.getAttribute('aria-label') === target.label)
    if (element) return element
  }
  let current: HTMLElement = page
  for (const index of target.path) {
    const child = current.children[index]
    if (!(child instanceof HTMLElement)) return page.querySelector<HTMLElement>('h1')
    current = child
  }
  return current.tagName === target.tag ? current : page.querySelector<HTMLElement>('h1')
}


export function focusDestination(inner: HTMLElement | null, direction: NavDirection, viewKey: string): (() => void) | undefined {
    const page = inner?.querySelector<HTMLElement>('.page-scroll')
    if (!page) return
    if (direction === 'push') {
      focusReturns.delete(viewKey)
      const heading = page.querySelector<HTMLElement>('h1')
      if (heading) {
        heading.tabIndex = -1
        heading.focus({ preventScroll: true })
      }
      return
    }
    const tabChange = direction === 'tab-forward' || direction === 'tab-backward'
    const queuedReturn = pendingPopFocus
    const queuedMatches = Boolean(queuedReturn && sameViewFamily(queuedReturn.viewKey, viewKey))
    const returning = direction === 'pop' || queuedMatches
    if (!returning && !tabChange) return
    if (tabChange) {
      const tabbar = inner?.closest<HTMLElement>('.phone')?.querySelector<HTMLElement>('.tabbar')
      const active = document.activeElement
      // A tab selected from the persistent navigation should keep keyboard focus there.
      // Content shortcuts are removed with the old page, so move those users to the new heading.
      if (active instanceof HTMLElement && tabbar?.contains(active)) return
    }
    const target = focusReturns.get(viewKey)
      ?? (queuedMatches ? queuedReturn?.target : undefined)
    // Wait until the page has completed its commit and descendants' layout effects.
    // Keep the saved target until the frame runs: StrictMode replays layout effects in
    // development, and deleting it during the first setup would make the replay lose it.
    const frame = window.requestAnimationFrame(() => {
      const currentPage = inner?.querySelector<HTMLElement>('.page-scroll')
      if (!currentPage) return
      const element = target ? resolveFocusTarget(currentPage, target) : null
      const fallback = currentPage.querySelector<HTMLElement>('h1')
      if (!element && fallback) fallback.tabIndex = -1
      if (focusReturns.get(viewKey) === target) focusReturns.delete(viewKey)
      if (pendingPopFocus === queuedReturn) pendingPopFocus = null
      ;(element ?? fallback)?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
}
