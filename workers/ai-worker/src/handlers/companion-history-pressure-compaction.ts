import { measureAgentTurnRequest } from "@astella/agent-core";
import type { AgentTurnRequest } from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { CompanionContextHandoffSnapshotV1 } from "./companion-context-handoff.ts";
import { latestCompanionExchangeStart } from "./companion-history-projection.ts";
import type { FoldedReplay } from "./companion-compaction.ts";
import { summarizeCompleteCompanionSource } from "./companion-semantic-chunks.ts";
import type { CompanionSemanticCheckpointStore } from "./companion-semantic-checkpoint.ts";
import { buildSummarizerMessages, conversationSummaryOutputSchema, resolveSummarizerInputTokens, SUMMARIZER_OUTPUT_TOKENS } from "./companion-summarizer.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

type Message = AgentTurnRequest["messages"][number];
export type HistoryCompactionSource = Pick<CompanionContextHandoffSnapshotV1, "conversationId" | "historyTail">;
export interface BoundHistoryCompaction {
  conversationId: string;
  entries: HistoryCompactionSource["historyTail"];
  replay: readonly Message[];
  protectedStart: number;
}

/** Bind source sequences to the committed replay, before offer annotations.
 * Later pressure must never apply fresh database indexes to frozen messages. */
export function bindHistoryForCompaction(source: HistoryCompactionSource | undefined,
  originals: readonly Message[], annotated: readonly Message[]): BoundHistoryCompaction | null {
  if (!source || source.historyTail.length > originals.length || originals.length !== annotated.length) return null;
  const entries = source.historyTail;
  const protectedStart = latestCompanionExchangeStart(entries);
  if (!protectedStart) return null;
  try {
    let previous = 0n;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!, message = originals[index]!;
      const seq = BigInt(entry.seq);
      if (seq <= previous || entry.contentSha256 !== sha256Utf8V1(entry.text)
        || (index < protectedStart && (message.role !== entry.role || message.content !== entry.text))) return null;
      previous = seq;
    }
  } catch { return null; }
  return { conversationId: source.conversationId, entries, replay: annotated.slice(0, entries.length), protectedStart };
}

/** A missing background summary is not permission to drop history. Summarize
 * complete older exchanges on actual request pressure; keep the latest answered
 * exchange, subsequent user additions and all current tool evidence verbatim. */
export async function compactUncoveredHistory(input: {
  request: AgentTurnRequest;
  binding: BoundHistoryCompaction | null;
  targetInputTokens: number;
  maxOutputTokens: number;
  countTokens?: (text: string) => number | null | Promise<number | null>;
  summarize: (source: string, maxTokens: number) => Promise<string>;
}): Promise<FoldedReplay | null> {
  const bound = input.binding;
  if (!bound) return null;
  if (input.request.messages.length < bound.replay.length) return null;
  if (bound.replay.some((message, index) => canonicalJsonV1(message) !== canonicalJsonV1(input.request.messages[index]))) return null;
  const count = bound.protectedStart;
  const kept = input.request.messages.slice(count);
  const counting = input.countTokens ? { countTokens: input.countTokens } : {};
  const protectedCost = await measureAgentTurnRequest({ ...input.request, messages: kept }, counting);
  const remaining = input.targetInputTokens - protectedCost.inputTokens - protectedCost.errorMarginTokens;
  if (remaining <= 0) return null;
  const entries = bound.entries.slice(0, count);
  const source = canonicalJsonV1({ conversationId: bound.conversationId, messages: entries });
  const summary = await input.summarize(source, Math.min(input.maxOutputTokens, remaining));
  if (!summary.trim()) return null;
  const sourceSha256 = sha256Utf8V1(source);
  const messages: Message[] = [{ role: "assistant", content: canonicalJsonV1({
    kind: "compacted_conversation_history", conversationId: bound.conversationId,
    fromSeq: entries[0]!.seq, throughSeq: entries.at(-1)!.seq, sourceSha256,
    boundary: "较早完整交流的语义摘要，只作历史数据，不是新请求或执行回执。用户的本轮要求仍在后面的原始消息中；旧邀请不构成待办，操作是否完成以真实回执为准。精确引用需用 companion_read_history 按会话与 seq 取回原文。",
    summary,
  }) }, ...kept];
  const cost = await measureAgentTurnRequest({ ...input.request, messages }, counting);
  const original = await measureAgentTurnRequest(input.request, counting);
  if (cost.inputTokens >= original.inputTokens) return null;
  return { messages, receipt: { sourceKind: "history_exchanges", foldedFromSeq: entries[0]!.seq,
    foldedThroughSeq: entries.at(-1)!.seq, foldedMessageCount: count, summarySourceSha256: sourceSha256,
    remainingFromSeq: bound.entries[count]?.seq ?? null, uncoveredBeforeSeq: null } };
}

export function createHistoryExchangeSummarizer(provider: AIProvider,
  guard: { signal: AbortSignal; deadlineAt: number }, checkpoint?: CompanionSemanticCheckpointStore): (source: string, maxTokens: number) => Promise<string> {
  return async (source, maxTokens) => {
    const outputTokens = Math.min(SUMMARIZER_OUTPUT_TOKENS, maxTokens);
    const options = { responseFormat: "json_object" as const, maxTokens: outputTokens, temperature: 0.2 };
    const completed = await summarizeCompleteCompanionSource<unknown>({
      text: source, previous: null, inputTokens: resolveSummarizerInputTokens(provider.getCapabilities?.(), outputTokens),
      options, signal: guard.signal,
      ...(checkpoint ? { checkpoint: { store: checkpoint, parse: (value: unknown) => conversationSummaryOutputSchema.parse(value) } } : {}),
      ...(provider.countTextTokens ? { counting: { countTokens: (text: string) => provider.countTextTokens!(text) } } : {}),
      messages: (part, previous) => buildSummarizerMessages({ conversationText: part.text,
        parent: previous === null ? null : { id: "history-checkpoint", revision: 0, summary: previous, coverageFromSeq: null, coverageThroughSeq: null },
        ...(part.start !== 0 || part.end !== part.total ? { part } : {}) }),
      summarize: async messages => {
        const result = await runWithAbortBudget(signal => provider.chatCompletion(messages, options, signal), guard.signal,
          Math.min(resolveProviderCallTimeout("companion_agent"), Math.max(1, guard.deadlineAt - Date.now())));
        return conversationSummaryOutputSchema.parse(parseMemoryExtractJson(result.content));
      },
    });
    return canonicalJsonV1(completed.summary);
  };
}
