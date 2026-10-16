import { boundedStepSender } from "./companion-compaction.ts";
import { compactActiveToolContext, createWorkingStateSummarizer } from "./companion-active-context-compaction.ts";
import { bindHistoryForCompaction, compactUncoveredHistory, createHistoryExchangeSummarizer } from "./companion-history-pressure-compaction.ts";
import { compactionSourceMessages, createCompactionCheckpoint, restoreCompactionCheckpoint } from "./companion-compaction-checkpoint.ts";
import { createCompanionCompactionProgressStore } from "./companion-compaction-progress.ts";
import { companionStepOutputCeiling } from "./companion-dialogue-content.ts";
import { auditHash } from "./companion-tool-call-ledger.ts";
import { CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { JobLeaseLostError } from "../lib/job-lease.ts";
import { logger } from "../lib/logger.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import type { CompanionAgentLoopArgs } from "../contracts/companion-agent-loop.ts";
import type { AgentTurnRequest } from "@astella/shared";

/**
 * 压力压缩的发出口：一整轮装一个，负责「按压力把历史与工具上下文折进有边界的请求」。
 *
 * 为什么搬出来（2026-10-15 神文件棘轮）：发送、恢复检查点、折叠与轨迹记账是同一域的
 * 四件事，它们只与「这一轮怎么往外发请求」有关，与循环怎么走步无关；留在 1700 行的
 * 运行时文件里，改这里的风险看起来和改整轮编排一样大，实际完全不同。纯搬运：
 * 判据、重试与记账一字未改；运行时的可变状态（messages/步数/折叠标记/压缩证据）
 * 用访问器接进来，所有权仍在运行时。
 */
export interface CompanionStepCompactionDeps {
  event: AgentEventContext;
  read: CompanionAgentLoopArgs["read"];
  runId: string;
  conversationId: string;
  signal: AbortSignal;
  deadlineAt: number;
  initialProvider: AIProvider;
  contextReceipts: CompanionAgentLoopArgs["contextReceipts"];
  compactionCheckpoints: CompanionAgentLoopArgs["compactionCheckpoints"];
  compactionCooldown: CompanionAgentLoopArgs["compactionCooldown"];
  compactionTrace: CompanionAgentLoopArgs["compactionTrace"];
  persistCompactionTraces: CompanionAgentLoopArgs["persistCompactionTraces"];
  replayFold: CompanionAgentLoopArgs["replayFold"];
  historyBinding: ReturnType<typeof bindHistoryForCompaction>;
  compactedEvidence: AgentTurnRequest["messages"];
  getMessages: () => AgentTurnRequest["messages"];
  setMessages: (messages: AgentTurnRequest["messages"]) => void;
  getStepCount: () => number;
  getHistoryFoldApplied: () => boolean;
  setHistoryFoldApplied: (value: boolean) => void;
}

export function createCompanionStepCompaction(deps: CompanionStepCompactionDeps) {
  // 历史摘要与当前工具工作状态在请求压力出现时压缩；原始交接快照、步骤
  // 与工具账本保留完整证据，恢复时可重新读取。
  let compactionRequest: AgentTurnRequest | null = null;
  let compactionProvider = deps.initialProvider;
  let compactionStepId: string | null = null;
  const sourceProgress = (sourceKind: "history_exchanges" | "active_tool_rounds") => compactionRequest && compactionStepId
    ? createCompanionCompactionProgressStore({ event: deps.event, stepId: compactionStepId, request: compactionRequest,
      provider: compactionProvider, sourceKind }) : undefined;
  const sendWithBoundedCompaction = boundedStepSender({
    // 历史摘要还没折过 ⇒ 这次折的是它；已经折过 ⇒ 这次折的是工具工作状态。
    sourceKind: () => deps.getHistoryFoldApplied() ? "active_tool_rounds" : "history_exchanges",
    beginRequest: request => {
      compactionRequest = request as AgentTurnRequest;
      deps.contextReceipts?.beginRequest(auditHash(request));
    },
    restore: () => {
      if (compactionRequest) {
        const restored = restoreCompactionCheckpoint({ runId: deps.runId, conversationId: deps.conversationId,
          request: compactionRequest, traces: deps.compactionCheckpoints ?? [] });
        if (restored) {
          deps.compactedEvidence.push(...compactionSourceMessages(restored.source));
          deps.setMessages([...restored.messages]);
          deps.setHistoryFoldApplied(true);
          logger.info({ runId: deps.runId, sourceKind: restored.receipt.sourceKind ?? "summary_coverage" },
            "restored complete compaction checkpoint for identical request");
          return restored;
        }
      }
      return null;
    },
    fold: async replay => {
      // replayFold indexes the original history. Once folded, those positions
      // no longer identify the same messages and must never be reused.
      const pressure = deps.contextReceipts?.latestPressure();
      let history = null;
      if (!deps.getHistoryFoldApplied() && compactionRequest && pressure && deps.historyBinding) {
        try {
          history = await compactUncoveredHistory({ request: { ...compactionRequest, messages: [...replay] },
            binding: deps.historyBinding, targetInputTokens: pressure.targetTokens,
            maxOutputTokens: companionStepOutputCeiling(compactionProvider),
            ...(compactionProvider.countTextTokens ? { countTokens: (text: string) => compactionProvider.countTextTokens!(text) } : {}),
            summarize: createHistoryExchangeSummarizer(compactionProvider, { signal: deps.signal, deadlineAt: deps.deadlineAt }, sourceProgress("history_exchanges")),
          });
        } catch (error) {
          if (deps.signal.aborted || error instanceof JobLeaseLostError || error instanceof CompanionContextChangedError) throw error;
          logger.warn({ runId: deps.runId, failureType: error instanceof Error ? error.name : typeof error }, "history compaction failed; preserving complete original exchanges");
        }
      }
      history ??= deps.getHistoryFoldApplied() ? null : deps.replayFold?.(replay) ?? null;
      if (history) deps.setHistoryFoldApplied(true);
      if (!compactionRequest || !pressure) {
        if (history) deps.setMessages([...history.messages]);
        return history;
      }
      try {
        const active = await compactActiveToolContext({
          request: { ...compactionRequest, messages: [...history?.messages ?? replay] },
          targetInputTokens: pressure.targetTokens,
          maxOutputTokens: companionStepOutputCeiling(compactionProvider),
          ...(compactionProvider.countTextTokens ? { countTokens: (text: string) => compactionProvider.countTextTokens!(text) } : {}),
          summarize: createWorkingStateSummarizer(compactionProvider,
            { signal: deps.signal, deadlineAt: deps.deadlineAt }, sourceProgress("active_tool_rounds")),
        });
        const folded = active ?? history;
        if (folded) deps.setMessages([...folded.messages]);
        return folded;
      } catch (error) {
        if (deps.signal.aborted || error instanceof JobLeaseLostError || error instanceof CompanionContextChangedError) throw error;
        logger.warn({ runId: deps.runId, failureType: error instanceof Error ? error.name : typeof error }, "active tool context compaction failed; preserving original evidence");
        if (history) deps.setMessages([...history.messages]);
        return history;
      }
    },
    hasAttempt: () => deps.contextReceipts?.hasCompactionAttempt() ?? false,
    // 额度在每次重发之前消耗（companion-compaction.ts 的两条重发路径都会调）；
    // 折成功与折不动都算用掉本轮那一次，闸随后按 over_trigger_line 放行。
    consumeAttempt: () => deps.contextReceipts?.consumeCompactionAttempt(),
    ...(deps.compactionCooldown ? { cooldown: deps.compactionCooldown } : {}),
    onCompacted: async (receipt, foldedMessages, source) => {
      deps.compactedEvidence.push(...compactionSourceMessages(source));
      const pressure = deps.contextReceipts?.latestPressure() ?? null;
      deps.compactionTrace?.record({
        ...receipt,
        ...(compactionRequest ? { checkpoint: createCompactionCheckpoint(deps.read, compactionRequest, foldedMessages, source) } : {}),
        modelId: pressure?.modelId ?? null,
        inputTokens: pressure?.inputTokens ?? null,
        triggerTokens: pressure?.triggerTokens ?? null,
        hardInputTokens: pressure?.hardInputTokens ?? null,
        reason: pressure?.reason ?? null,
        at: new Date().toISOString(),
      });
      await deps.persistCompactionTraces?.();
      logger.warn({ runId: deps.runId, stepCount: deps.getStepCount(), ...receipt },
        "context pressure compacted source-bound history or tool evidence");
    },
  });

  return {
    send: sendWithBoundedCompaction,
    setStepId: (stepId: string) => { compactionStepId = stepId; },
    setProvider: (provider: AIProvider) => { compactionProvider = provider; },
  };
}
