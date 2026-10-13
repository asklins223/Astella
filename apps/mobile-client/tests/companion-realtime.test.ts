import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/platform/credentials.ts', () => ({ getToken: () => 'test-session-token' }))

import { openCompanionRealtime } from '../src/platform/companion-realtime.ts'

type FakeHandler = ((event: any) => void) | null

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readonly sent: string[] = []
  readyState = 0
  onopen: FakeHandler = null
  onmessage: FakeHandler = null
  onerror: FakeHandler = null
  onclose: FakeHandler = null

  constructor() {
    sockets.push(this)
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const sockets: FakeWebSocket[] = []

function sentMessages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>)
}

afterEach(() => {
  sockets.length = 0
  vi.unstubAllGlobals()
})

describe('companion realtime cursor recovery', () => {
  it('waits for the refreshed cursor before resubscribing after a replay gap', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    let cursor = 4
    let finishRecovery!: () => void
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve })
    const client = openCompanionRealtime({
      conversationId: '00000000-0000-4000-8000-000000000001',
      getCursor: () => cursor,
      onEvent: () => undefined,
      onGap: async () => recovery,
    })
    const socket = sockets[0]!
    socket.open()
    socket.receive({ version: 1, type: 'auth.ok' })

    expect(sentMessages(socket).map((message) => message.type)).toEqual(['auth', 'subscribe'])
    socket.receive({
      version: 1,
      type: 'error',
      error: { code: 'CURSOR_EXPIRED', message: 'cursor expired', recoverable: true },
    })

    expect(sentMessages(socket)).toHaveLength(2)
    cursor = 42
    finishRecovery()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = sentMessages(socket)
    expect(messages).toHaveLength(3)
    expect(messages[2]).toMatchObject({ type: 'subscribe', after: 42 })
    client.close()
  })
})
