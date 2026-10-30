import { agentTurnRequestSchema, type AgentTurnRequest } from "@astella/shared";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { CompactionTraceV1 } from "./companion-context-handoff.ts";
import type { FoldedReplay } from "./companion-compaction.ts";
import { currentCompanionRequestMessages } from "../tools/companion-tool-receipts.ts";

export interface CompanionCompactionCheckpoint {
  runId: string;
  conversationId: string;
  requestSha256: string;
  messagesSha256: string;
  /** JSON keeps valid fractional provider/tool parameters out of the integer-only handoff canonical form. */
  messagesJson: string;
  source?: { json: string; sha256: string };
}

/** Exact original tool output stays available to verification after its prompt
 * projection becomes a summary. Never promote generated summary prose to source. */
export function compactionSourceMessages(source: FoldedReplay["source"],
  requestMessages: AgentTurnRequest["messages"]): AgentTurnRequest["messages"] {
  if (!source || sha256Utf8V1(source.json) !== source.sha256) return [];
  try {
    const messages = JSON.parse(source.json);
    const parsed = agentTurnRequestSchema.shape.messages.safeParse(messages);
    if (!parsed.success) return [];
    // A source can contain older native rounds. Only exact messages present
    // after this request's boundary can become current execution evidence.
    const current = new Set(currentCompanionRequestMessages(requestMessages).map(message => stableStringify(message)));
    return parsed.data.filter(message => current.has(stableStringify(message)));
  } catch { return []; }
}

export function createCompactionCheckpoint(scope: { runId: string; conversationId: string },
  request: AgentTurnRequest, messages: readonly AgentTurnRequest["messages"][number][], source?: FoldedReplay["source"]): CompanionCompactionCheckpoint {
  const messagesJson = stableStringify(messages);
  return { runId: scope.runId, conversationId: scope.conversationId, requestSha256: sha256Utf8V1(stableStringify(request)),
    messagesSha256: sha256Utf8V1(messagesJson), messagesJson,
    ...(source ? { source: { ...source } } : {}) };
}

/** Reuse only a complete checkpoint for this run's identical full request.
 * A changed policy, capability surface, evidence or provider shaping misses. */
export function restoreCompactionCheckpoint(input: { runId: string; conversationId: string;
  request: AgentTurnRequest; traces: readonly CompactionTraceV1[] }): FoldedReplay | null {
  const requestSha256 = sha256Utf8V1(stableStringify(input.request));
  for (const trace of [...input.traces].reverse()) {
    const checkpoint = trace.checkpoint;
    if (!checkpoint || checkpoint.runId !== input.runId || checkpoint.conversationId !== input.conversationId
      || checkpoint.requestSha256 !== requestSha256 || typeof checkpoint.messagesJson !== "string"
      || sha256Utf8V1(checkpoint.messagesJson) !== checkpoint.messagesSha256
      || (checkpoint.source && sha256Utf8V1(checkpoint.source.json) !== checkpoint.source.sha256)) continue;
    let messages: AgentTurnRequest["messages"];
    try {
      messages = JSON.parse(checkpoint.messagesJson);
      if (!agentTurnRequestSchema.shape.messages.safeParse(messages).success) continue;
    } catch { continue; }
    return { messages, ...(checkpoint.source ? { source: { ...checkpoint.source } } : {}), receipt: {
      ...(trace.sourceKind ? { sourceKind: trace.sourceKind } : {}),
      foldedFromSeq: trace.foldedFromSeq, foldedThroughSeq: trace.foldedThroughSeq,
      foldedMessageCount: trace.foldedMessageCount, summarySourceSha256: trace.summarySourceSha256,
      remainingFromSeq: trace.remainingFromSeq, uncoveredBeforeSeq: trace.uncoveredBeforeSeq,
    } };
  }
  return null;
}
