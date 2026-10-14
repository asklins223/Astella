import { useEffect, useRef } from 'react'
import { handleUnauthorized, useSession } from '../state/session.ts'
import { useCompanion } from '../state/companion.ts'
import { useNotes } from '../state/notes.ts'
import { useNav } from '../app/nav.ts'
import { ApiError, requestJson } from './api-client.ts'
import type { CompanionAwarenessObservationV1, CompanionAwarenessContextV1 } from '@astella/shared/companion-initiative-contracts'
import { createCompanionQuietPresenceTracker } from '@astella/shared/companion-awareness-idle'

const TAB_IDENTITY_KEY = 'astella.mobile.companion-awareness.tab.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface TabAwarenessSession {
  appLaunchId: string
  deviceSessionId: string
  startedUsers: Set<string>
  startingUsers: Set<string>
}

// The browser tab is one launch, including document reloads and development HMR.
// Keep the runtime lock through HMR even when browser storage is unavailable.
const runtime = globalThis as typeof globalThis & { __astellaMobileAwarenessTab?: TabAwarenessSession }
function tabSession(): TabAwarenessSession {
  if (runtime.__astellaMobileAwarenessTab) return runtime.__astellaMobileAwarenessTab
  let identity: Pick<TabAwarenessSession, 'appLaunchId' | 'deviceSessionId'> | null = null
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(TAB_IDENTITY_KEY) ?? 'null')
    if (saved && typeof saved === 'object') {
      const value = saved as { appLaunchId?: unknown; deviceSessionId?: unknown }
      if (typeof value.appLaunchId === 'string' && UUID.test(value.appLaunchId)
        && typeof value.deviceSessionId === 'string' && value.deviceSessionId.startsWith('browser:')
        && value.deviceSessionId.length <= 200) {
        identity = { appLaunchId: value.appLaunchId, deviceSessionId: value.deviceSessionId }
      }
    }
  } catch { /* A storage restriction still permits observations for this document. */ }
  identity ??= { appLaunchId: crypto.randomUUID(), deviceSessionId: `browser:${crypto.randomUUID()}` }
  try { sessionStorage.setItem(TAB_IDENTITY_KEY, JSON.stringify(identity)) } catch { /* Keep the runtime identity. */ }
  const value = { ...identity, startedUsers: new Set<string>(), startingUsers: new Set<string>() }
  runtime.__astellaMobileAwarenessTab = value
  return value
}

const launch = tabSession()
const startupKey = (userId: string) => `${TAB_IDENTITY_KEY}.started:${launch.appLaunchId}:${userId}`
function hasStarted(userId: string): boolean {
  if (launch.startedUsers.has(userId)) return true
  try {
    if (sessionStorage.getItem(startupKey(userId)) === '1') {
      launch.startedUsers.add(userId)
      return true
    }
  } catch { /* The runtime marker is sufficient while this document stays open. */ }
  return false
}
function markStarted(userId: string): void {
  launch.startedUsers.add(userId)
  try { sessionStorage.setItem(startupKey(userId), '1') } catch { /* Preserve the successful runtime marker. */ }
}

// Observations retain their real browser host; this is not a native cold launch.
const launchWallClock = Date.now(), launchMonotonic = performance.now()
export function useMobileCompanionAwareness() {
  const session = useSession(), companion = useCompanion(), notes = useNotes(), nav = useNav()
  const current = useRef({ session, companion, notes, nav }); current.current = { session, companion, notes, nav }
  const route = nav.pushed.at(-1)
  const pageKey = route ? `${route.kind}:${'noteId' in route ? route.noteId : ''}` : nav.tab
  const needsNote = Boolean(route && ['reader', 'map', 'explain'].includes(route.kind))
  const pageReady = !needsNote || Boolean(notes.reader?.detail && !notes.reader.loading)
  const pageRevision = needsNote ? notes.reader?.detail?.currentVersionId ?? null : null
  const publishRef = useRef<((topic: CompanionAwarenessObservationV1['topic']) => void) | null>(null)
  const activityRef = useRef<(() => void) | null>(null)
  const priorPageKey = useRef(pageKey)
  useEffect(() => {
    if (session.status !== 'ready' || !session.me || !companion.conversationId || !companion.historyReady) return
    const scope = { userId: session.me.userId, workspaceId: session.me.workspaceId, conversationId: companion.conversationId }
    let closed = false, typingUntil = 0, lastAt = performance.now(), lastInputAt = -Infinity
    const quietPresence = createCompanionQuietPresenceTracker(lastAt)
    let quietEpisodeVersion = 0, quietObservationId: string | null = null, lastActivityObservationAt = -Infinity
    let pending = Promise.resolve()
    const isCurrent = () => !closed
      && current.current.session.status === 'ready'
      && current.current.session.me?.userId === scope.userId
      && current.current.session.me?.workspaceId === scope.workspaceId
      && current.current.companion.conversationId === scope.conversationId
      && current.current.companion.historyReady
    const context = (): CompanionAwarenessContextV1 => {
      const { companion: c, notes: n, nav: v } = current.current
      const r = v.pushed.at(-1), reader = n.reader
      const reading = Boolean(r && ['reader', 'map', 'explain'].includes(r.kind) && reader?.detail && !reader.loading)
      const noteVersionId = reader?.detail?.currentVersionId ?? null
      const key = r ? `${r.kind}:${'noteId' in r ? r.noteId : ''}` : v.tab
      return { foreground: document.visibilityState === 'visible' && document.hasFocus(), unlocked: true, typing: performance.now() < typingUntil,
        learning: reading, speaking:false, participationAllowed:true, conversationId: c.conversationId,
        page: { key, label: reader?.title || key, revision: noteVersionId,
          context: reading && reader?.noteId ? { version: 1, context: { pageKind: 'note', sharing: 'page_registered',
            noteId: reader.noteId, ...(noteVersionId ? { noteVersionId } : {}) } } : null } }
    }
    const publish = (topic: CompanionAwarenessObservationV1['topic']) => {
      pending = pending.then(async () => {
        if (!isCurrent()) return
        const now = performance.now(), c = context()
        const quietForMs = topic === 'presence.quiet'
          ? quietPresence.quietForMs(now, c.foreground && c.unlocked && !c.typing && c.participationAllowed !== false)
          : null
        if (topic === 'presence.quiet' && quietForMs === null) return
        const episodeVersion = quietEpisodeVersion
        if (topic === 'presence.quiet') quietObservationId ??= crypto.randomUUID()
        const observation: CompanionAwarenessObservationV1 = { version: 1,
          id: topic === 'presence.quiet' ? quietObservationId! : crypto.randomUUID(), appLaunchId: launch.appLaunchId,
          deviceSessionId: launch.deviceSessionId, host: 'browser', topic, occurredAt: new Date(launchWallClock + performance.now() - launchMonotonic).toISOString(),
          elapsedMs: Math.min(45_000, Math.max(0, Math.round(now - lastAt))),
          context: quietForMs === null ? c : { ...c, quietForMs } }
        lastAt = now
        try {
          await requestJson('/me/companion/awareness', { method: 'POST', body: observation })
          if (topic === 'presence.quiet' && quietEpisodeVersion === episodeVersion) {
            quietPresence.markReported()
            quietObservationId = null
          }
          // A request may finish after unmount, an account change or a shelf switch.
          // Only the active scope may send a startup, with freshly observed context.
          if (!isCurrent() || hasStarted(scope.userId) || launch.startingUsers.has(scope.userId)) return
          const startupContext = context()
          if (!startupContext.foreground) return
          launch.startingUsers.add(scope.userId)
          try {
            await requestJson('/me/companion/awareness', { method: 'POST', body: {
              ...observation, id: crypto.randomUUID(), topic: 'app.started', elapsedMs: 0,
              occurredAt: new Date(launchWallClock + performance.now() - launchMonotonic).toISOString(),
              context: startupContext,
            } })
            // Mark only after the server has acknowledged the observation. An
            // unsuccessful request remains retryable on the next real lease.
            markStarted(scope.userId)
          } finally {
            launch.startingUsers.delete(scope.userId)
          }
        } catch (error) {
          if (isCurrent() && error instanceof ApiError && error.isUnauthorized) handleUnauthorized()
          // Lost browser leases do not accrue learning time.
        }
      })
    }
    publishRef.current = publish
    const activity = () => {
      const now = performance.now()
      quietEpisodeVersion += 1
      quietObservationId = null
      quietPresence.markActivity(now)
      if (now - lastActivityObservationAt >= 5_000) {
        lastActivityObservationAt = now
        publish('context.updated')
      }
    }
    activityRef.current = activity
    let lastPointerMoveAt = -Infinity
    const pointerMove = () => {
      const now = performance.now()
      if (now - lastPointerMoveAt < 1_000) return
      lastPointerMoveAt = now
      activity()
    }
    const visibility = () => {
      activity()
      publish(document.visibilityState === 'visible' && document.hasFocus() ? 'app.foreground' : 'context.updated')
    }
    const input = () => { const now = performance.now(); typingUntil = now + 6_000
      activity()
      if (now - lastInputAt >= 1_000) { lastInputAt = now; publish('context.updated') } }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', visibility); window.addEventListener('blur', visibility)
    document.addEventListener('pointerdown', activity, true); document.addEventListener('pointermove', pointerMove, { capture: true, passive: true })
    document.addEventListener('keydown', activity, true); document.addEventListener('input', activity, true)
    document.addEventListener('wheel', activity, { capture: true, passive: true }); document.addEventListener('touchstart', activity, { capture: true, passive: true })
    window.addEventListener('astella:companion-user-input', input)
    const timer = window.setInterval(() => { publish('context.updated'); publish('presence.quiet') }, 15_000)
    publish('context.updated')
    return () => { closed = true; if (publishRef.current === publish) publishRef.current = null; activityRef.current = null; clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', visibility); window.removeEventListener('blur', visibility)
      document.removeEventListener('pointerdown', activity, true); document.removeEventListener('pointermove', pointerMove, true)
      document.removeEventListener('keydown', activity, true); document.removeEventListener('input', activity, true)
      document.removeEventListener('wheel', activity, true); document.removeEventListener('touchstart', activity, true)
      window.removeEventListener('astella:companion-user-input', input) }
  }, [session.status, session.me?.workspaceId, session.me?.userId, companion.conversationId, companion.historyReady])
  useEffect(() => {
    if (priorPageKey.current !== pageKey) {
      priorPageKey.current = pageKey
      activityRef.current?.()
    }
    publishRef.current?.('context.updated')
    if (!pageReady) return
    const timer = setTimeout(() => publishRef.current?.('page.arrived'), 700)
    return () => clearTimeout(timer)
  }, [pageKey, pageReady, pageRevision])
}
