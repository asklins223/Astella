import {
  companionRealtimeServerMessageV1Schema,
  type CompanionRealtimeServerMessageV1,
} from '@astella/shared/companion-realtime-contracts'
import type {
  CompanionStreamEventV1,
  CreateCompanionTurnRequestV1,
  CreateCompanionTurnResponseV1,
} from '@astella/shared/companion-conversation-contracts'
import { ApiError } from './api-client.ts'
import { apiOrigin } from './config.ts'
import { getToken } from './credentials.ts'

const FIRST_RETRY_MS = 700
const MAX_RETRY_MS = 20_000
const COMMAND_ACK_TIMEOUT_MS = 6_000

export type CompanionRealtimeState = 'connecting' | 'open' | 'retrying' | 'closed'

export interface CompanionRealtimeHandlers {
  conversationId: string
  getCursor: () => number
  onEvent: (event: CompanionStreamEventV1) => void
  onGap: () => Promise<void> | void
  onState?: (state: CompanionRealtimeState) => void
  onUnauthorized?: () => void
  onError?: (message: string) => void
}

export class RealtimeUnavailableError extends Error {
  constructor(message = 'WebSocket 连接暂不可用') {
    super(message)
    this.name = 'RealtimeUnavailableError'
  }
}

interface PendingCommand {
  resolve: (response: CreateCompanionTurnResponseV1) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function webSocketUrl(): string {
  const url = new URL('/companion/realtime', apiOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function statusFor(code: string, statusCode?: number): number {
  if (statusCode) return statusCode
  if (code === 'RATE_LIMITED') return 429
  if (code === 'UNAUTHORIZED') return 401
  if (code === 'NOT_FOUND') return 404
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'INTERNAL_ERROR') return 502
  return 400
}

function apiError(message: { code: string; message: string; statusCode?: number }): ApiError {
  const status = statusFor(message.code, message.statusCode)
  return new ApiError(status, message.code, message.message, {
    version: 1,
    error: message.code,
    message: message.message,
    statusCode: status,
  })
}

/** Authenticated companion socket: durable event replay plus idempotent turn submission. */
export function openCompanionRealtime(options: CompanionRealtimeHandlers): {
  submitTurn: (body: CreateCompanionTurnRequestV1) => Promise<CreateCompanionTurnResponseV1>
  close: () => void
} {
  let socket: WebSocket | null = null
  let closed = false
  let authenticated = false
  let subscribed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let gapRecovering = false
  const pending = new Map<string, PendingCommand>()

  const failPending = (error: Error) => {
    for (const command of pending.values()) {
      clearTimeout(command.timer)
      command.reject(error)
    }
    pending.clear()
  }

  const send = (message: object): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  const subscribe = () => {
    if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) return
    subscribed = false
    if (!send({ version: 1, type: 'subscribe', conversationId: options.conversationId, after: options.getCursor() })) {
      socket.close()
    }
  }

  const handleMessage = (raw: unknown) => {
    if (closed) return
    let value: unknown = raw
    try {
      if (typeof raw === 'string') value = JSON.parse(raw)
      else if (raw instanceof Blob) void raw.text().then((text) => handleMessage(text))
      else if (raw instanceof ArrayBuffer) value = JSON.parse(new TextDecoder().decode(raw))
      else return
    } catch {
      return
    }
    const parsed = companionRealtimeServerMessageV1Schema.safeParse(value)
    if (!parsed.success) return
    const message: CompanionRealtimeServerMessageV1 = parsed.data
    switch (message.type) {
      case 'auth.ok':
        authenticated = true
        subscribe()
        return
      case 'subscribed':
        if (message.conversationId !== options.conversationId) return
        subscribed = true
        attempt = 0
        options.onState?.('open')
        return
      case 'event':
        if (message.event.conversationId === options.conversationId) options.onEvent(message.event)
        return
      case 'ping':
        send({ version: 1, type: 'pong' })
        return
      case 'turn.result': {
        const command = pending.get(message.requestId)
        if (!command) return
        clearTimeout(command.timer)
        pending.delete(message.requestId)
        if (message.ok) command.resolve(message.result)
        else {
          const error = apiError(message.error)
          if (error.isUnauthorized) options.onUnauthorized?.()
          command.reject(error)
        }
        return
      }
      case 'error': {
        if (message.error.code === 'UNAUTHORIZED') {
          options.onUnauthorized?.()
          socket?.close(4401, 'unauthorized')
          return
        }
        if ((message.error.code === 'CURSOR_EXPIRED' || message.error.code === 'INVALID_CURSOR') && !gapRecovering) {
          gapRecovering = true
          subscribed = false
          options.onState?.('retrying')
          void Promise.resolve(options.onGap())
            .then(() => {
              gapRecovering = false
              subscribe()
            })
            .catch((error: unknown) => {
              gapRecovering = false
              options.onError?.(error instanceof Error ? error.message : '同步对话记录失败。')
              scheduleReconnect()
            })
          return
        }
        if (message.requestId) {
          const command = pending.get(message.requestId)
          if (command) {
            clearTimeout(command.timer)
            pending.delete(message.requestId)
            command.reject(apiError(message.error))
          }
        } else {
          options.onError?.(message.error.message)
        }
      }
    }
  }

  const scheduleReconnect = () => {
    if (closed || timer) return
    const delay = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
    attempt += 1
    options.onState?.('retrying')
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
  }

  const connect = () => {
    if (closed) return
    authenticated = false
    subscribed = false
    options.onState?.(attempt === 0 ? 'connecting' : 'retrying')
    let next: WebSocket
    try { next = new WebSocket(webSocketUrl()) }
    catch {
      scheduleReconnect()
      return
    }
    socket = next
    next.onopen = () => {
      const token = getToken()
      if (!token) {
        options.onUnauthorized?.()
        next.close(4401, 'missing session')
        return
      }
      next.send(JSON.stringify({ version: 1, type: 'auth', token }))
    }
    next.onmessage = (event) => handleMessage(event.data)
    next.onerror = () => { /* close is the single reconnect path */ }
    next.onclose = (event) => {
      if (socket === next) socket = null
      authenticated = false
      subscribed = false
      failPending(new RealtimeUnavailableError())
      if (closed) return
      if (event.code === 4401) {
        options.onUnauthorized?.()
        options.onState?.('closed')
        return
      }
      scheduleReconnect()
    }
  }

  const submitTurn = (body: CreateCompanionTurnRequestV1) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !authenticated || !subscribed) {
      return Promise.reject(new RealtimeUnavailableError())
    }
    const requestId = body.clientMessageId
    return new Promise<CreateCompanionTurnResponseV1>((resolve, reject) => {
      const commandTimer = setTimeout(() => {
        pending.delete(requestId)
        reject(new RealtimeUnavailableError('WebSocket 回执超时'))
      }, COMMAND_ACK_TIMEOUT_MS)
      pending.set(requestId, { resolve, reject, timer: commandTimer })
      if (!send({ version: 1, type: 'turn.submit', requestId, conversationId: options.conversationId, body })) {
        clearTimeout(commandTimer)
        pending.delete(requestId)
        reject(new RealtimeUnavailableError())
      }
    })
  }

  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    timer = undefined
    socket?.close(1000, 'client closed')
    socket = null
    failPending(new RealtimeUnavailableError('连接已关闭'))
    options.onState?.('closed')
  }

  connect()
  return { submitTurn, close }
}
