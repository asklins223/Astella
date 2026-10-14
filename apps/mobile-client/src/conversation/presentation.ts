import type { CompanionMessage } from '../platform/api.ts'

export interface PresentedMessage {
  /** Stable key for the first real message in this visual group. */
  key: string
  /** The server messages remain separate in state; this is only their reading view. */
  message: CompanionMessage
  sourceMessages: readonly CompanionMessage[]
}

/**
 * A run may publish several complete utterances. Keep their durable message ids,
 * but read them as one reply with paragraph breaks, matching the desktop composer.
 */
export function presentMessages(messages: readonly CompanionMessage[]): PresentedMessage[] {
  const result: PresentedMessage[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (previous && canJoin(previous.message, message)) {
      const sourceMessages = [...previous.sourceMessages, message]
      result[result.length - 1] = {
        key: previous.key,
        sourceMessages,
        message: mergeUtterances(sourceMessages),
      }
    } else {
      result.push({ key: message.id, message, sourceMessages: [message] })
    }
  }
  return result
}

function canJoin(left: CompanionMessage, right: CompanionMessage): boolean {
  return left.role === 'assistant'
    && right.role === 'assistant'
    && Boolean(left.runId)
    && left.runId === right.runId
}

function mergeUtterances(messages: readonly CompanionMessage[]): CompanionMessage {
  const first = messages[0]!
  const last = messages.at(-1)!
  const blocks: CompanionMessage['blocks'][number][] = []
  for (const message of messages) {
    for (const block of message.blocks) {
      const previous = blocks.at(-1)
      if (previous?.type === 'text' && block.type === 'text') {
        blocks[blocks.length - 1] = { ...previous, text: `${previous.text}\n\n${block.text}` }
      } else {
        blocks.push(block)
      }
    }
  }
  return {
    ...first,
    id: last.id,
    seq: first.seq,
    kind: last.kind,
    blocks,
    createdAt: first.createdAt,
    editedAt: last.editedAt,
    ...(last.followUpPrompts?.length ? { followUpPrompts: last.followUpPrompts } : {}),
  }
}
