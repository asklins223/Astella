import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanionStreamEventV1 } from '@astella/shared/companion-conversation-contracts'
import { companionLine } from '../../conversation/status-line.ts'

const wire = vi.hoisted(() => ({ onEvent: null as ((event: CompanionStreamEventV1) => void) | null,
  cancel: vi.fn(async () => ({})), submit: vi.fn(), messages: vi.fn() }))
const conversationId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
vi.mock('../../platform/api.ts', () => ({ uuid: () => crypto.randomUUID(), companionApi: {
  ensureInbox: async () => ({ id: conversationId }), messages: wire.messages,
  runNodes: async () => ({ runs: [], items: [], latestSeq: 0 }), cancelRun: wire.cancel,
} }))
vi.mock('../../platform/companion-realtime.ts', () => ({
  RealtimeUnavailableError: class extends Error {},
  openCompanionRealtime: (options: {onEvent: (event: CompanionStreamEventV1) => void}) => {
    wire.onEvent = options.onEvent
    return { close: vi.fn(), submitTurn: wire.submit }
  },
}))
vi.mock('../session.ts', () => ({ handleUnauthorized: vi.fn() }))
const { companionStore, openConversation, resetConversation, setDraft, sendTurn } = await import('../companion.ts')
const base = { version: 1 as const, eventId: 'fixture', seq: 1,
  workspaceId: '00000000-0000-4000-8000-000000000003', conversationId, runId,
  generation: 1, accountEpoch: 0, createdAt: '2026-10-13T08:00:00.000Z' }
const status = (): CompanionStreamEventV1 => ({ ...base, type: 'assistant.status',
  payload: { status: 'waiting', safeLabel: '正在准备回复…', inputKind: 'initiative' } })

describe('mobile initiative participation', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', new EventTarget())
    resetConversation(); wire.cancel.mockClear()
    wire.messages.mockResolvedValue({ items: [], hasMore: false })
    wire.submit.mockResolvedValue({ runId: '00000000-0000-4000-8000-000000000004', generation: 2,
      eventCursor: 3, status: 'accepted' })
    await openConversation()
    companionStore.set({ stream: 'open' })
  })

  it('quiet consideration leaves the visible companion status calm', () => {
    wire.onEvent!(status())
    expect(companionStore.get().turn?.initiative).toBe(true)
    expect(companionLine(companionStore.get())).toBe('我在')
    wire.onEvent!({ ...base, seq: 2, type: 'turn.completed', payload: { messageIds: [], silent: true } })
    expect(companionStore.get().turn).toBeNull()
    expect(companionStore.get().messages).toEqual([])
    expect(companionStore.get().error).toBeNull()
  })

  it('typing yields immediately and a late proactive utterance cannot revive the old turn', async () => {
    wire.onEvent!(status())
    setDraft('我想接着问一句')
    expect(companionStore.get().turn).toBeNull()
    expect(wire.cancel).toHaveBeenCalledWith(runId, 1)
    wire.onEvent!({ ...base, seq: 2, type: 'assistant.utterance', payload: {
      messageId: crypto.randomUUID(), messageSeq: 1, text: '迟到的一句', proactive: true, deviceSessionId: null,
    } })
    expect(companionStore.get().messages).toEqual([])
    expect(await sendTurn(companionStore.get().draft)).toBe(true)
    expect(companionStore.get().turn?.generation).toBe(2)
    expect(companionStore.get().messages[0]?.role).toBe('user')
  })

  it('committed utterances have separate identities and reconnect replay does not duplicate them', () => {
    wire.onEvent!(status())
    const event: CompanionStreamEventV1 = { ...base, seq: 2, type: 'assistant.utterance', payload: {
      messageId: crypto.randomUUID(), messageSeq: 1, text: '你回来啦。', proactive: true, deviceSessionId: null,
    } }
    wire.onEvent!(event); wire.onEvent!(event)
    wire.onEvent!({ ...event, seq: 3, payload: { ...event.payload, messageId: crypto.randomUUID(), messageSeq: 2, text: '想从哪里开始？' } })
    expect(companionStore.get().messages.map(m => m.blocks)).toHaveLength(2)
    expect(companionStore.get().messages[0]?.id).not.toBe(companionStore.get().messages[1]?.id)
  })
})
