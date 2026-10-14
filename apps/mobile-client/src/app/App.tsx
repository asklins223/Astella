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
import { goTab, pop, push, registerTransitionCapture, top, useNav, type Tab } from './nav.ts'
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
import { Viewport } from './Viewport.tsx'
import { captureOutgoingPage, captureClickedFocus, captureFocusedTarget, clearNavigationVisuals } from './navigation-visuals.ts'
import { openContextCompanion } from '../conversation/context-companion.tsx'
import { CompanionSeat } from '../companion/CompanionSeat.tsx'

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
  const { handlers } = useEdgeBack(detail)
  const started = useRef(false)
  const previousScope = useRef<string | null>(null)
  const settle = useCallback(() => setSplashDone(true), [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void restoreSession()
  }, [])

  useLayoutEffect(() => {
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
      clearNavigationVisuals()
      goTab('chat')
    }
    if (session.status === 'ready') void openConversation()
  }, [session.status, session.me?.userId, session.me?.workspaceId])

  useLayoutEffect(() => registerTransitionCapture((id, direction, origin) => {
    captureOutgoingPage(transitionHost.current, id, direction, origin, scrollPositions.current, motion.off)
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
    ...(keyboard?.keyboard ? { height: `${Math.round(keyboard.height)}px` } : {}),
  } as React.CSSProperties

  return (
    <PhoneRootContext.Provider value={phoneRef.current}>
      <div
        ref={phoneRef}
        className={className}
        data-detail={String(detail)}
        data-screen={screenName(route, nav.tab)}
        data-utility={String(route?.kind === 'settings' || route?.kind === 'companion' || route?.kind === 'profile' || session.status === 'signed_out' || session.status === 'unavailable')}
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
              {route?.kind === 'settings' || route?.kind === 'profile' || route?.kind === 'companion'
                ? <UtilityHeader title={route.kind === 'settings' ? '使用设置' : route.kind === 'profile' ? '个人中心' : '伴星'} />
                : <TopBar detail={detail} chat={nav.tab === 'chat' && !route} tab={nav.tab} state={companionLine(companion, detail)} />}
              <div
                className="viewport"
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
                {route && route.kind !== 'settings' && route.kind !== 'companion' && route.kind !== 'profile' && <DetailDock route={route} />}
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

function TopBar({ detail, chat, tab, state }: { detail: boolean; chat: boolean; tab: Tab; state: string }) {
  const root = usePhoneRoot()
  const prefs = usePrefs()
  const session = useSession()
  const companion = useCompanion()
  const workspaceName = session.me?.workspaceName ?? '我的书房'
  const onProfile = !detail && tab === 'me'
  const turn = companion.turn && (!companion.turn.initiative || companion.turn.visible) ? companion.turn : null
  const activity = turn?.phase ?? 'idle'
  return (
    <header className={`topbar${!chat ? ' context-topbar' : ''}`}>
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
      ) : (
        <button
          className="context-launcher"
          type="button"
          data-activity={activity}
          data-live={turn ? 'true' : undefined}
          aria-haspopup="dialog"
          aria-label={`伴星，${state}。点按在${onProfile ? '个人中心' : detail ? '当前页面' : tab === 'notes' ? '手记架' : tab === 'hand' ? '手边' : '当前页面'}和她聊聊`}
          onClick={event => openContextCompanion(event.currentTarget, root)}
        >
          <CompanionSeat variant="compact" />
          <span><strong>伴星</strong><small><i aria-hidden="true" /><span>{turn ? state : detail ? '陪你读 · 点我' : onProfile ? '这里也能聊' : '在这里聊'}</span></small></span>
          <Icon name="chevron-down" />
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
  const root = usePhoneRoot()
  const companion = useCompanion()
  const state = companionLine(companion, true)
  const turn = companion.turn && (!companion.turn.initiative || companion.turn.visible) ? companion.turn : null
  return (
    <header className="utility-header">
      <button className="icon-button glass top-left" type="button" onClick={pop} aria-label="返回上一页">
        <Icon name="arrow-left" />
      </button>
      <span className="utility-header-title">{title}</span>
      <button
        className="utility-companion-trigger"
        type="button"
        data-activity={turn?.phase ?? 'idle'}
        data-live={turn ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-label={`伴星，${state}。在${title}页面和她聊聊`}
        onClick={event => openContextCompanion(event.currentTarget, root)}
      >
        <CompanionSeat variant="compact" />
        <span className="utility-companion-copy"><strong>{turn ? state : '问伴星'}</strong><small>{turn ? '点按查看进展' : '带着当前页面'}</small></span>
      </button>
    </header>
  )
}

function page(route: ReturnType<typeof top>, tab: Tab, userId: string | undefined) {
  if (route?.kind === 'reader') return <ReaderPage noteId={route.noteId} />
  if (route?.kind === 'versions') return <VersionsPage noteId={route.noteId} title={route.title} />
  if (route?.kind === 'map') return <MindMapPage noteId={route.noteId} />
  if (route?.kind === 'explain') return <ExplainPage noteId={route.noteId} />
  if (route?.kind === 'companion') return <CompanionCenterPage />
  if (route?.kind === 'profile') return <ProfilePage />
  if (route?.kind === 'settings') return <SettingsPage userId={userId} />
  if (tab === 'hand') return <HandPage />
  if (tab === 'notes') return <NotesPage />
  if (tab === 'me') return <ProfilePage />
  return <ChatPage />
}

function routeKey(route: ReturnType<typeof top>, tab: Tab, layout: string): string {
  if (!route) return tab === 'chat' ? `${tab}:${layout}` : tab
  return 'noteId' in route ? `${route.kind}:${route.noteId}` : route.kind
}

function screenName(route: ReturnType<typeof top>, tab: Tab): string {
  if (route?.kind === 'reader') return 'reader'
  if (route?.kind === 'versions') return 'history'
  if (route?.kind === 'map') return 'map'
  if (route?.kind === 'explain') return 'explain'
  if (route?.kind === 'settings') return 'settings'
  if (route?.kind === 'companion') return 'companion'
  if (route?.kind === 'profile') return 'profile'
  return tab === 'me' ? 'profile' : tab
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
        <button className="sheet-row" type="button" onClick={event => push({ kind: 'profile' }, event.currentTarget)}>
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
