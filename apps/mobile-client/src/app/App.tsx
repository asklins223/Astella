import { useMobileCompanionAwareness } from "../platform/companion-awareness.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AuthScreen } from '../auth/AuthScreen.tsx'
import { SessionRecoveryScreen } from '../auth/SessionRecoveryScreen.tsx'
import { ChatPage } from '../conversation/ChatPage.tsx'
import { ChatComposer } from '../conversation/ChatComposer.tsx'
import { DetailDock } from '../conversation/DetailDock.tsx'
import { companionLine } from '../conversation/status-line.ts'
import { NotesPage } from '../notes/NotesPage.tsx'
import { ReaderPage } from '../notes/ReaderPage.tsx'
import { VersionsPage } from '../notes/VersionsPage.tsx'
import { MindMapPage } from '../notes/MindMapPage.tsx'
import { ExplainPage } from '../notes/ExplainPage.tsx'
import { ProfilePage } from '../me/ProfilePage.tsx'
import { SettingsPage } from '../me/SettingsPage.tsx'
import { closeNote, openNote, resetNotesForWorkspace, useNotes } from '../state/notes.ts'
import { openConversation, resetConversation, useCompanion } from '../state/companion.ts'
import { resetCompanionAccount } from '../state/companion-account.ts'
import { restoreSession, useSession } from '../state/session.ts'
import { loadFor, setChatLayout, usePrefs } from '../state/prefs.ts'
import { useMotion } from '../platform/motion.ts'
import { Icon } from './icons.tsx'
import { NavigationTray } from './NavigationTray.tsx'
import { PhoneRootContext } from './phone-root.tsx'
import { Splash } from './Splash.tsx'
import { finishTransition, goTab, pop, push, registerTransitionCapture, top, useNav, type NavDirection, type Tab } from './nav.ts'
import { useEdgeBack } from './use-edge-back.ts'
import { useKeyboardViewport } from './use-keyboard-viewport.ts'
import { CompanionFlow } from '../companion/CompanionFlow.tsx'
import { Sheet } from '../ui/sheet.tsx'
import { closeSheet, openSheet, originOf, useSheet } from '../ui/sheet-store.ts'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'
import { usePhoneRoot } from './phone-root.tsx'
import { HandPage } from '../run/HandPage.tsx'
import { CompanionCenterPage } from '../companion/CompanionCenterPage.tsx'
import { CompanionModelStage } from '../companion/CompanionSeat.tsx'
import { clamp, frames } from '../platform/geometry.ts'

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

/**
 * 壳。三段结构与类名一律照 demo 的 `mobile-companion-layout.js`：
 * `header.topbar` → `div.viewport > section.page-scroll` → `div.bottom-area`（tray + home indicator）。
 * 对话那屏在 topbar 里给 `.dialogue-modes`（伴星／记录），其余屏给 `.identity`——
 * 她的半身像从顶上垂下来，名字签跟着状态换字。
 */
export function App() {
  const session = useSession()
  const nav = useNav()
  const prefs = usePrefs()
  const motion = useMotion()
  const companion = useCompanion()
  const route = top()
  useMobileCompanionAwareness();
  const sheet = useSheet()
  const phoneRef = useRef<HTMLDivElement>(null)
  const transitionHost = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef(new Map<string, { top: number; left: number }>())
  const [splashDone, setSplashDone] = useState(false)
  const [size, setSize] = useState({ narrow: false, short: false })
  const detail = route !== null
  const keyboard = useKeyboardViewport()
  const { dragX, handlers } = useEdgeBack(detail)
  const started = useRef(false)
  const previousScope = useRef<string | null>(null)
  const settle = useCallback(() => setSplashDone(true), [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void restoreSession()
  }, [])

  useEffect(() => {
    loadFor(session.me?.userId)
  }, [session.me?.userId])

  useLayoutEffect(() => {
    const scope = session.me ? `${session.me.userId}:${session.me.workspaceId}` : null
    if (scope !== previousScope.current) {
      previousScope.current = scope
      // Clear tenant-bound data before a newly selected account or shelf can paint.
      resetConversation()
      resetNotesForWorkspace()
      resetCompanionAccount()
      scrollPositions.current.clear()
      focusReturns.clear()
      pendingFocusTargets.clear()
      focusReturnStack.length = 0
      pendingPopFocus = null
      goTab('chat')
    }
    if (session.status === 'ready') void openConversation()
  }, [session.status, session.me?.userId, session.me?.workspaceId])

  useLayoutEffect(() => registerTransitionCapture((id, direction, origin) => {
    captureOutgoingPage(transitionHost.current, id, direction, origin, scrollPositions.current)
  }))

  // 阅读态的生死跟着导航走：挂在屏的卸载清理上会在 StrictMode 的挂载—卸载—重挂载
  // 之间把刚取到的正文擦掉，症状是永远停在「正在取这一篇…」。
  const notes = useNotes()
  const readerNoteId = notes.reader?.noteId ?? null
  const readerRoute = route?.kind === 'reader' || route?.kind === 'map' || route?.kind === 'explain' || route?.kind === 'versions' ? route : null
  const scrollRestoreReady = !readerRoute || (notes.reader?.noteId === readerRoute.noteId && !notes.reader.loading)
  useEffect(() => {
    if (!readerRoute) {
      closeNote()
      return
    }
    if (readerNoteId === readerRoute.noteId) return
    void openNote(readerRoute.noteId, readerRoute.kind === 'reader' || readerRoute.kind === 'versions' ? readerRoute.title : '')
  }, [readerRoute, readerNoteId])

  useEffect(() => {
    const root = phoneRef.current
    if (!root) return
    const apply = () => {
      const rect = root.getBoundingClientRect()
      // demo 的 setSize：`.scene-title strong` 这类按设备宽算上限的地方要拿到真实像素。
      root.style.setProperty('--device-w', `${Math.round(rect.width)}px`)
      root.style.setProperty('--device-h', `${Math.round(rect.height)}px`)
      const next = { narrow: rect.width < 360, short: rect.height <= 720 }
      setSize((current) => (current.narrow === next.narrow && current.short === next.short ? current : next))
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    return () => observer.disconnect()
  }, [session.status])

  useEffect(() => {
    if (sheet) {
      closeSheet({ restoreFocus: false })
      // The destination is inert until the menu's exit commit completes. Focus it
      // on the next frame instead of trying to focus a page behind an open dialog.
      const frame = window.requestAnimationFrame(() => {
        const page = phoneRef.current?.querySelector<HTMLElement>('.viewport > .page-layer > .page-scroll')
        const heading = page?.querySelector<HTMLElement>('h1')
        if (heading) {
          heading.tabIndex = -1
          heading.focus({ preventScroll: true })
        }
      })
      return () => window.cancelAnimationFrame(frame)
    }
    // 换屏时面板一定跟着收：面板是从这一屏的某一枚长出来的，屏都变了它不该还挂着。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.tab, route])

  const className = [
    'app phone',
    motion.off ? 'motion-off' : '',
    size.narrow ? 'narrow' : '',
    size.short ? 'short' : '',
    keyboard?.keyboard ? 'keyboard-on' : '',
  ].filter(Boolean).join(' ')
  const style = {
    '--text-scale': String(prefs.textScale),
    '--keyboard': keyboard?.keyboard ? `${Math.round(Math.min(244, Math.max(200, (phoneRef.current?.clientHeight ?? 700) * 0.32)))}px` : '0px',
  } as React.CSSProperties

  return (
    <PhoneRootContext.Provider value={phoneRef.current}>
      <div
        ref={phoneRef}
        className={className}
        data-detail={String(detail)}
        data-screen={screenName(route, nav.tab)}
        data-utility={String(route?.kind === 'settings' || route?.kind === 'companion' || session.status === 'signed_out' || session.status === 'unavailable')}
        data-dialogue={prefs.chatLayout}
        data-ready={session.status}
        style={style}
        onClickCapture={captureClickedFocus}
        onPointerDownCapture={captureClickedFocus}
        onFocusCapture={captureFocusedTarget}
      >
        <CompanionFlow />
        {session.status === 'signed_out' ? <AuthScreen />
          : session.status === 'unknown' || session.status === 'restoring' || session.status === 'unavailable'
            ? <SessionRecoveryScreen status={session.status} error={session.error} onRetry={() => void restoreSession()} />
          : session.status === 'ready' ? (
            <>
              {route?.kind === 'settings'
                ? <UtilityHeader title="使用设置" />
                : <TopBar detail={detail} companionCenter={route?.kind === 'companion'} chat={nav.tab === 'chat' && !route} tab={nav.tab} state={companionLine(companion, detail)} />}
              <div
                className="viewport"
                style={{ transform: dragX ? `translate3d(${dragX}px,0,0)` : undefined }}
                data-dragging={dragX ? '1' : '0'}
                {...handlers}
              >
                <div ref={transitionHost} className="transition-layer" aria-hidden="true" />
                <Viewport
                  key={routeKey(route, nav.tab, prefs.chatLayout)}
                  viewKey={routeKey(route, nav.tab, prefs.chatLayout)}
                  scrollPositions={scrollPositions.current}
                  direction={nav.direction}
                  transitionId={nav.transitionId}
                  motionOff={motion.off}
                  scrollRestoreReady={scrollRestoreReady}
                  transitionHost={transitionHost}
                >
                  {page(route, nav.tab, session.me?.userId)}
                </Viewport>
              </div>
              <div className="bottom-area">
                {nav.tab === 'chat' && !route && <ChatComposer />}
                {route && route.kind !== 'settings' && route.kind !== 'companion' && <DetailDock route={route} />}
                {!route && <NavigationTray tab={nav.tab} />}
                <div className="home-indicator" aria-hidden="true"><span /></div>
              </div>
            </>
          ) : null}
        {sheet && <Sheet spec={sheet} onClose={closeSheet} />}
        <CompanionModelStage />
        {!splashDone && <Splash onDone={settle} />}
      </div>
    </PhoneRootContext.Provider>
  )
}

function TopBar({ detail, companionCenter, chat, tab, state }: { detail: boolean; companionCenter: boolean; chat: boolean; tab: Tab; state: string }) {
  const root = usePhoneRoot()
  const prefs = usePrefs()
  const session = useSession()
  const companion = useCompanion()
  const workspaceName = session.me?.workspaceName ?? '我的书房'
  const onProfile = !detail && tab === 'me'
  return (
    <header className="topbar">
      {!onProfile && (
        <button
          className="icon-button glass top-left"
          type="button"
          aria-label={detail ? '返回上一页' : '打开书房菜单'}
          onClick={(event) => detail ? pop() : openMainMenu(event.currentTarget, root, session.me?.displayName, session.me?.email)}
        >
          <Icon name={detail ? 'arrow-left' : 'menu'} />
        </button>
      )}
      {chat ? (
        <div className="dialogue-modes glass" role="group" aria-label="对话显示方式">
          <button type="button" data-mode="scene" aria-pressed={prefs.chatLayout === 'scene'} onClick={() => setChatLayout('scene', session.me?.userId)}>伴星</button>
          <button type="button" data-mode="history" aria-pressed={prefs.chatLayout === 'history'} onClick={() => setChatLayout('history', session.me?.userId)}>记录</button>
        </div>
      ) : onProfile ? (
        <span className="utility-header-title profile-header-title">个人中心</span>
      ) : companionCenter ? (
        <div className={`identity${companion.turn ? ' busy' : ''}`} aria-hidden="true">
          <span className="portrait">
            <img src="/assets/companion-static.png" alt="" />
          </span>
          <span className="identity-copy glass">
            <strong>伴星</strong>
            <i />
            <span>{state}</span>
          </span>
        </div>
      ) : (
        <button className={`identity${companion.turn ? ' busy' : ''}`} type="button" onClick={() => push({ kind: 'companion' })} aria-label="进入伴星中心">
          <span className="portrait">
            <img src="/assets/companion-static.png" alt="" />
          </span>
          <span className="identity-copy glass">
            <strong>伴星</strong>
            <i />
            <span>{state}</span>
          </span>
        </button>
      )}
      <button
        className="space-button glass"
        type="button"
        aria-label={`当前书房：${workspaceName}。切换书房`}
        onClick={(event) => openSheet({
          kind: 'spaces',
          title: '切换书房',
          variant: 'glass',
          origin: originOf(event.currentTarget, root),
          trigger: event.currentTarget,
          children: <WorkspaceSwitcher />,
        })}
      >
        <span className="space-name">{compactWorkspaceName(workspaceName)}</span>
        <Icon name="chevron-down" />
      </button>
    </header>
  )
}

function UtilityHeader({ title }: { title: string }) {
  return (
    <header className="utility-header">
      <button className="icon-button glass top-left" type="button" onClick={pop} aria-label="返回上一页">
        <Icon name="arrow-left" />
      </button>
      <span className="utility-header-title">{title}</span>
      <span className="header-end" aria-hidden="true" />
    </header>
  )
}

/** 一级分区轻移，详情页按 push／pop 进退；离场副本只负责视觉，不承接事件或焦点。 */
function Viewport({
  children,
  direction,
  transitionId,
  motionOff,
  scrollRestoreReady,
  transitionHost,
  viewKey,
  scrollPositions,
}: {
  children: React.ReactNode
  direction: NavDirection
  transitionId: number
  motionOff: boolean
  scrollRestoreReady: boolean
  transitionHost: React.RefObject<HTMLDivElement | null>
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
    const complete = () => {
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
    const from = direction === 'push' ? width
      : direction === 'pop' ? -width * 0.24
        : tabSign * width * 0.16
    const duration = isTab ? 360 : 470
    const easing = 'linear'
    const enter = node.animate(
      frames((progress) => ({
        transform: `translate3d(${from * (1 - progress)}px,0,0)`,
        opacity: isTab ? 0.42 + 0.58 * clamp(progress, 0, 1) : 1,
      })),
      { duration, easing },
    )
    const exitX = direction === 'push' ? -width * 0.24
      : direction === 'pop' ? width
        : -tabSign * width * 0.16
    const ghostStyle = ghost ? getComputedStyle(ghost) : null
    const currentTransform = ghostStyle?.transform ?? 'none'
    const parsedOpacity = ghostStyle ? Number.parseFloat(ghostStyle.opacity) : 1
    const currentOpacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1
    const matrix = new DOMMatrix(currentTransform === 'none' ? undefined : currentTransform)
    const leavingFrames: Keyframe[] = direction === 'pop'
      // 返回时离开的详情页继续可读，跟随手势方向完整滑走。
      ? frames((progress) => ({
          transform: `translate3d(${matrix.e + (exitX - matrix.e) * progress}px,0,0)`,
          opacity: currentOpacity,
        }))
      // 分区切换与进入详情时，旧内容在前段交接完就退场，避免新旧正文叠成水印。
      : frames((progress, linearProgress) => ({
          transform: `translate3d(${matrix.e + (exitX - matrix.e) * progress}px,0,0)`,
          opacity: currentOpacity * (1 - clamp(linearProgress * 3, 0, 1)),
        }))
    const leaving = ghost?.animate(leavingFrames, { duration, easing })
    void Promise.all([enter.finished, ...(leaving ? [leaving.finished] : [])])
      .then(complete)
      .catch(() => {})
    return () => {
      if (enter.playState !== 'finished') enter.cancel()
      if (leaving && leaving.playState !== 'finished') leaving.cancel()
    }
  }, [direction, transitionId, motionOff, transitionHost])
  useLayoutEffect(() => {
    if (!scrollRestoreReady) return
    const page = inner.current?.querySelector<HTMLElement>('.page-scroll')
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
      const tabbar = inner.current?.closest<HTMLElement>('.phone')?.querySelector<HTMLElement>('.tabbar')
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
      const currentPage = inner.current?.querySelector<HTMLElement>('.page-scroll')
      if (!currentPage) return
      const element = target ? resolveFocusTarget(currentPage, target) : null
      const fallback = currentPage.querySelector<HTMLElement>('h1')
      if (!element && fallback) fallback.tabIndex = -1
      if (focusReturns.get(viewKey) === target) focusReturns.delete(viewKey)
      if (pendingPopFocus === queuedReturn) pendingPopFocus = null
      ;(element ?? fallback)?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [direction, scrollRestoreReady, transitionId, viewKey])
  return <div className="page-layer" ref={inner} data-view-key={viewKey}>{children}</div>
}

function page(route: ReturnType<typeof top>, tab: Tab, userId: string | undefined) {
  if (route?.kind === 'reader') return <ReaderPage noteId={route.noteId} />
  if (route?.kind === 'versions') return <VersionsPage noteId={route.noteId} title={route.title} />
  if (route?.kind === 'map') return <MindMapPage noteId={route.noteId} />
  if (route?.kind === 'explain') return <ExplainPage noteId={route.noteId} />
  if (route?.kind === 'companion') return <CompanionCenterPage />
  if (route?.kind === 'settings') return <SettingsPage userId={userId} />
  if (tab === 'hand') return <HandPage />
  if (tab === 'notes') return <NotesPage />
  if (tab === 'me') return <ProfilePage />
  return <ChatPage />
}

function routeKey(route: ReturnType<typeof top>, tab: Tab, layout: string): string {
  if (!route) return `${tab}:${layout}`
  return 'noteId' in route ? `${route.kind}:${route.noteId}` : route.kind
}

function screenName(route: ReturnType<typeof top>, tab: Tab): string {
  if (route?.kind === 'reader') return 'reader'
  if (route?.kind === 'versions') return 'history'
  if (route?.kind === 'map') return 'map'
  if (route?.kind === 'explain') return 'explain'
  if (route?.kind === 'settings') return 'settings'
  if (route?.kind === 'companion') return 'companion'
  return tab === 'me' ? 'profile' : tab
}

function captureOutgoingPage(
  host: HTMLDivElement | null,
  transitionId: number,
  direction: NavDirection,
  origin: HTMLElement | null | undefined,
  scrollPositions: Map<string, { top: number; left: number }>,
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
  }
  if (viewKey) pendingFocusTargets.delete(viewKey)
  if (viewKey && focusReturns.has(viewKey)) {
    if (focusReturns.size > 32) focusReturns.delete(focusReturns.keys().next().value!)
  }
  host.replaceChildren()
  const pageLayer = source.parentElement
  if (!pageLayer) return
  const layerStyle = getComputedStyle(pageLayer)
  const frame = document.createElement('div')
  frame.className = 'route-ghost-frame'
  frame.dataset.transitionId = String(transitionId)
  Object.assign(frame.style, {
    transform: layerStyle.transform,
    opacity: layerStyle.opacity,
    width: `${viewport.clientWidth}px`,
    height: `${viewport.clientHeight}px`,
  })
  const copy = source.cloneNode(true) as HTMLElement
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  copy.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
  copy.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => element.setAttribute('tabindex', '-1'))
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')]
  const clones = [copy, ...copy.querySelectorAll<HTMLElement>('*')]
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
  frame.append(copy)
  host.append(frame)
}

function sameViewFamily(from: string, to: string): boolean {
  // A tab's presentation setting may change while a detail page is open; the
  // return target is still valid as long as navigation returns to the same tab.
  const family = (key: string) => key.includes(':') ? key.slice(0, key.indexOf(':')) : key
  return family(from) === family(to)
}

function captureClickedFocus(event: React.SyntheticEvent<HTMLDivElement>): void {
  const page = phoneRootPage(event.currentTarget)
  const viewKey = page?.parentElement?.dataset.viewKey
  if (!page || !viewKey) return
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('button, a, input, textarea, select, [tabindex]')
    : null
  if (target && page.contains(target)) pendingFocusTargets.set(viewKey, describeFocusTarget(target, page))
  else pendingFocusTargets.delete(viewKey)
}

function captureFocusedTarget(event: React.FocusEvent<HTMLDivElement>): void {
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

function openMainMenu(trigger: HTMLElement, root: HTMLElement | null, displayName?: string, email?: string): void {
  openSheet({
    kind: 'menu',
    title: '书房菜单',
    variant: 'glass',
    origin: originOf(trigger, root),
    trigger,
    children: (
      <div className="main-menu-list">
        <button className="sheet-row" type="button" onClick={() => goTab('me')}>
          <Icon name="user-round" />
          <span>{displayName?.trim() || '个人中心'}<small>{email || '账号资料、空间与退出登录'}</small></span>
          <Icon name="chevron-right" />
        </button>
        <button className="sheet-row" type="button" onClick={() => push({ kind: 'settings' })}>
          <Icon name="settings-2" />
          <span>使用设置<small>字号、对话显示与阅读习惯</small></span>
          <Icon name="chevron-right" />
        </button>
      </div>
    ),
  })
}

function compactWorkspaceName(name: string): string {
  return Array.from(name.trim()).length > 8 ? '当前书房' : name
}
