/**
 * Pure decisions about how a step that issued tool calls should end.
 *
 * These used to sit inline in the loop, where they were hard to test and made
 * the runtime file grow every time a closing shape was added. Nothing here
 * touches the transcript or the database; callers apply the result.
 */

import type { AgentTurnResult } from "@astella/shared";

export type CompanionToolCall = AgentTurnResult["toolCalls"][number];

/** Receipts that close every declared call honestly while a proposal waits. */
export function waitingConfirmationReceipts(
  proposalId: string,
  calls: readonly CompanionToolCall[],
  index: number,
): { role: "tool"; toolCallId: string; content: string }[] {
  return calls.slice(index).map((call, offset) => ({
    role: "tool",
    toolCallId: call.id,
    content: JSON.stringify(offset === 0
      ? { ok: false, status: "waiting_confirmation", proposalId }
      : {
        ok: false, status: "not_executed", deferredByProposalId: proposalId,
        summary: "前一项正在等待用户确认，这一项尚未执行。决定到达后按当前目标与真实回执继续，不把它当成已完成。",
      }),
  }));
}

/** Success of a call as recorded in its own tool receipt. */
function callSucceeded(messages: readonly { role: string; toolCallId?: string | null; content: unknown }[],
  call: CompanionToolCall): boolean {
  const receipt = [...messages].reverse().find(message => message.role === "tool" && message.toolCallId === call.id);
  if (!receipt || typeof receipt.content !== "string") return false;
  try {
    return (JSON.parse(receipt.content) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export interface CompanionStepClosing {
  /**
   * `annotation`: the independent artifact was already delivered, so optional
   * speech failure must not start another generation loop.
   * `silent`: a committed publication or explicit silent decision is the result.
   * `none`: keep iterating.
   */
  readonly settleAs: "annotation" | "silent" | "none";
  /** Every call in this step succeeded. */
  readonly allSucceeded: boolean;
}

/**
 * A committed publication or an explicit silent decision is the result itself.
 * Spending another round trip merely to confirm execution ended is waste.
 */
export function judgeCompanionStepClosing(input: {
  calls: readonly CompanionToolCall[];
  messages: readonly { role: string; toolCallId?: string | null; content: unknown }[];
  initiative: boolean;
  writingAnnotation: boolean;
}): CompanionStepClosing {
  const { calls } = input;
  const closingCall = calls.at(-1);
  const closesSilently = input.initiative && closingCall?.name === "companion_finish_participation";
  const closesSpeech = closingCall?.name === "companion_publish_utterance"
    && (closingCall.arguments as { final?: boolean } | null)?.final !== false
    && calls.every(call => ["companion_publish_utterance", "companion_write_annotation"].includes(call.name));
  const allSucceeded = calls.every(call => callSucceeded(input.messages, call));
  const deliveredAnnotation = input.writingAnnotation && calls.some(call => {
    if (call.name !== "companion_write_annotation"
      || (call.arguments as { final?: boolean } | null)?.final === false) return false;
    return callSucceeded(input.messages, call);
  });
  const annotationOnly = deliveredAnnotation
    && calls.every(call => ["companion_write_annotation", "companion_publish_utterance"].includes(call.name));
  const settleAs = annotationOnly ? "annotation" as const
    : (closesSilently || closesSpeech) && allSucceeded ? "silent" as const
      : "none" as const;
  return { settleAs, allSucceeded };
}
