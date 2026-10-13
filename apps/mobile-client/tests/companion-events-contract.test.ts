import { describe, expect, it } from 'vitest'
import { companionStreamEventV1Schema } from '@astella/shared/companion-conversation-contracts'

/**
 * 服务端**真的**写出来的事件，按合同过一遍。
 *
 * 2026-10-12：worker 的失败事件带着 `payload.message`（"这一轮引用的记忆已变更或撤回…"），
 * 合同是 strict 的——多一个键，整条 `error` 在所有客户端被判失败，
 * 屏幕上只剩一个永远转不过去的「正在路上」。这一条就是那件事的看门狗。
 */
describe('伴星事件合同', () => {
  it('失败事件按原样能过（带 message）', () => {
    const raw = {
      version: 1,
      eventId: '9404b494-e7bc-4bdd-a58b-f5e61a23b309:2422',
      seq: 2422,
      workspaceId: 'e5483fe4-13d1-4725-811e-473ae8258cea',
      conversationId: '9404b494-e7bc-4bdd-a58b-f5e61a23b309',
      runId: '1c31da54-4c8c-48c7-bf8d-055643a1e786',
      generation: 136,
      accountEpoch: 0,
      createdAt: '2026-10-12T10:35:51.076Z',
      type: 'error',
      payload: {
        code: 'CONTEXT_STALE',
        message: '这一轮引用的记忆已变更或撤回。请重新发送，我会按现在的内容继续。',
        requestId: '1c31da54-4c8c-48c7-bf8d-055643a1e786',
        recoverable: true,
      },
    }
    const result = companionStreamEventV1Schema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success && result.data.type === 'error') expect(result.data.payload.message).toContain('记忆已变更')
  })

  it('受理回执按原样能过', () => {
    const raw = {
      version: 1,
      eventId: '9404b494-e7bc-4bdd-a58b-f5e61a23b309:2421',
      seq: 2421,
      workspaceId: 'e5483fe4-13d1-4725-811e-473ae8258cea',
      conversationId: '9404b494-e7bc-4bdd-a58b-f5e61a23b309',
      runId: '1c31da54-4c8c-48c7-bf8d-055643a1e786',
      generation: 136,
      accountEpoch: 0,
      createdAt: '2026-10-12T10:35:51.076Z',
      type: 'turn.accepted',
      payload: {
        clientMessageId: '11111111-1111-4111-8111-111111111111',
        userMessageId: '22222222-2222-4222-8222-222222222222',
        status: 'accepted',
      },
    }
    expect(companionStreamEventV1Schema.safeParse(raw).success).toBe(true)
  })
})
