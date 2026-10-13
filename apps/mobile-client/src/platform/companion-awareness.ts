import { useEffect, useRef } from 'react'
import { useSession } from '../state/session.ts'
import { useCompanion } from '../state/companion.ts'
import { useNotes } from '../state/notes.ts'
import { useNav } from '../app/nav.ts'
import { requestJson } from './api-client.ts'
import type { CompanionAwarenessObservationV1, CompanionAwarenessContextV1 } from '@astella/shared/companion-initiative-contracts'

// This browser document's startup is intentionally labelled browser, never a native cold launch.
const launchId = crypto.randomUUID()
const deviceId = `browser:${launchId}`
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
  useEffect(() => {
    if (session.status !== 'ready' || !session.me || !companion.conversationId || !companion.historyReady) return
    let closed = false, typingUntil = 0, lastAt = performance.now(), lastInputAt = -Infinity, started = false
    let pending = Promise.resolve()
    const context = (): CompanionAwarenessContextV1 => {
      const { companion: c, notes: n, nav: v } = current.current
      const r = v.pushed.at(-1), reader = n.reader
      const reading = Boolean(r && ['reader', 'map', 'explain'].includes(r.kind) && reader?.detail && !reader.loading)
      const noteVersionId = reader?.detail?.currentVersionId ?? null
      const key = r ? `${r.kind}:${'noteId' in r ? r.noteId : ''}` : v.tab
      return { foreground: document.visibilityState === 'visible', unlocked: true, typing: performance.now() < typingUntil,
        learning: reading, speaking:false, participationAllowed:true, conversationId: c.conversationId,
        page: { key, label: reader?.title || key, revision: noteVersionId,
          context: reading && reader?.noteId ? { version: 1, context: { pageKind: 'note', sharing: 'page_registered',
            noteId: reader.noteId, ...(noteVersionId ? { noteVersionId } : {}) } } : null } }
    }
    const publish = (topic: CompanionAwarenessObservationV1['topic']) => {
      pending = pending.then(async () => {
        if (closed) return
        const now = performance.now(), c = context()
        const observation: CompanionAwarenessObservationV1 = { version: 1, id: crypto.randomUUID(), appLaunchId: launchId,
          deviceSessionId: deviceId, host: 'browser', topic, occurredAt: new Date(launchWallClock + performance.now() - launchMonotonic).toISOString(),
          elapsedMs: Math.min(45_000, Math.max(0, Math.round(now - lastAt))), context: c }
        lastAt = now
        try {
          await requestJson('/me/companion/awareness', { method: 'POST', body: observation })
          if (!started && c.foreground) { started = true; await requestJson('/me/companion/awareness', { method: 'POST',
            body: { ...observation, id: crypto.randomUUID(), topic: 'app.started', elapsedMs: 0 } }) }
        } catch { /* Lost browser leases do not accrue learning time. */ }
      })
    }
    publishRef.current = publish
    const visibility = () => publish(document.visibilityState === 'visible' ? 'app.foreground' : 'context.updated')
    const input = () => { const now = performance.now(); typingUntil = now + 6_000
      if (now - lastInputAt >= 1_000) { lastInputAt = now; publish('context.updated') } }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('astella:companion-user-input', input)
    const timer = window.setInterval(() => publish('context.updated'), 15_000)
    publish('context.updated')
    return () => { closed = true; publishRef.current = null; clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('astella:companion-user-input', input) }
  }, [session.status, session.me?.workspaceId, session.me?.userId, companion.conversationId, companion.historyReady])
  useEffect(() => {
    publishRef.current?.('context.updated')
    if (!pageReady) return
    const timer = setTimeout(() => publishRef.current?.('page.arrived'), 700)
    return () => clearTimeout(timer)
  }, [pageKey, pageReady, pageRevision])
}
