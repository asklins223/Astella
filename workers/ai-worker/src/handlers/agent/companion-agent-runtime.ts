import { CompanionToolNotExecutedError } from "../tools/companion-tool-result.ts";
import { companionCurrentRequestMessages } from "../turn/companion-step-plan.ts";
import { companionArithmeticMismatch, type CompanionArithmeticMismatch } from "../turn/companion-arithmetic-check.ts";
import { companionCallFingerprint, companionMalformedToolExhausted, companionReplayExhausted, companionReplayLimitFor,
  COMPANION_ARITHMETIC_REPEAT_ALLOWED, COMPANION_ARITHMETIC_TOTAL_ALLOWED,
  COMPANION_ACTION_REPLAY_RETRIES_ALLOWED,
  COMPANION_INVALID_TOOL_CALLS_ALLOWED, COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED,
  COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED } from "./companion-progress-guard.ts";
import { isCompanionParticipationClosure } from "../proactive/companion-participation-output.ts";
import { reviewCompanionInitiativeSpeech } from "../proactive/companion-initiative-speech-review.ts";
import { sql } from "drizzle-orm";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
import { companionEditedNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import { executeTurn } from "@astella/agent-core";
import {
  auditHash,
  boundedToolCallIdentity,
  ensureAgentToolCall,
  executeCompanionAgentTurnWithToolChoiceFallback,
  loadContinuation,
  recordRejectedToolCall,
  safeArgumentsHash,
  updateToolCall,
} from "../tools/companion-tool-call-ledger.ts";
import {
  companionToolLabel,
  companionCapabilityOfferedInHostContext,
  companionOperationArguments,
  companionOperationDomainTool,
  companionOperationName,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  resolveCompanionInitialToolNames,
  type CompanionAgentToolStatus,
  type CompanionContentBlockV1,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

import { createCompanionRouteRecorder } from "./companion-route-record.ts";
import { resolveCompanionEntryMode, settleCompanionAttention,
  createCompanionDirectControls, companionDirectGuidance } from "../turn/companion-entry-mode.ts";
import { companionActionProgressLabel } from "./companion-action-progress.ts";
import { companionResponseStrategy } from "../turn/companion-response-strategy.ts";
import { containsCompanionToolProtocol } from "../tools/companion-tool-protocol-output.ts";
import { CompanionToolOutputRepairError } from "../tools/companion-tool-output-repair.ts";
import { companionTimeWakeupConstraint, companionExecutionConstraintGuidance } from "./companion-execution-constraints.ts";
import {
  findDuplicateSegment,
  joinVisibleSegmentsDeduped,
  VISIBLE_SEGMENT_SEPARATOR,
} from "../turn/companion-visible-segments.ts";
import { encodeCompanionRuntimeCheckpoint, loadCompanionRuntimeCheckpoint, saveCompanionRuntimeInput,
  type CompanionRuntimeState } from "./companion-runtime-checkpoint.ts";
import { createCompanionModelStepRunner } from "./companion-agent-task.ts";
import { logger } from "../../lib/logger.ts";
import { runWithAbortBudget } from "../../lib/handler-timeout.ts";
import {
  resolveCompanionAgentBudget,
  resolveProviderCallTimeout,
} from "../../lib/handler-timeout-config.ts";
import { AgentOutputError, CompanionAgentBudgetExceededError, CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { runWithCompanionModelRetries } from "./companion-model-retries.ts";
import { assembleCompanionFinishText, assembleCompanionHostSettlement,
  settleCompanionLandedWritesOnFailure } from "./companion-host-settlement.ts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { retrieveCompanionMemoriesKeyword } from "../memory/companion-memory-vector.ts";
import { sameCompanionMemoryFact } from "@astella/shared";
import {
  emitCompanionAssistantStatus,
  recoverCompanionRunFailureSpanBestEffort,
} from "../turn/companion-dialogue-store.ts";
import { settleCompanionTurnPreamble } from "../turn/companion-turn-preamble.ts";
import { createCompanionStepCompaction } from "../context/companion-step-compaction.ts";
import { looksTruncatedReply, companionStepOutputCeiling } from "../turn/companion-dialogue-content.ts";
import { companionNumericEvidenceContext } from "../context/companion-context-evidence.ts";
import { runCompanionToolExecution } from "../tools/companion-tool-execution-run.ts";
import { CompanionToolPreparation } from "../tools/companion-tool-preparation.ts";
import { companionExecutionPolicy } from "./companion-execution-policy.ts";
import { repairDegenerateCompanionAnswer } from "./companion-answer-repair.ts";
import { assembleCompanionStepRequest, companionStepPolicyText, companionStepToolSurface } from "./companion-agent-step-assembly.ts";
import { companionInitiativeInterpretationFields } from "../proactive/companion-initiative-observation.ts";
import { createdNoteToolResult, readCreatedNoteReceipt, userForbidsNoteLibraryRead } from "../note/companion-note-authoring.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "./companion-agent-streaming-step.ts";
import { recoverCompanionStreamFailure } from "./companion-stream-recovery.ts";
import { executeWatchedCompanionTurn, CompanionOutputTimeoutError } from "./companion-output-watchdog.ts";
import { companionNoteEditPrerequisite } from "../note/companion-note-authoring-stage.ts";
import { CompanionStreamStoppedError } from "../turn/companion-dialogue-stream.ts";
export { runStreamingAgentStep };
export {
  classifyCompanionToolFailure,
  CompanionToolBlockedError,
  CompanionToolError,
  CompanionToolNotExecutedError,
  CompanionToolUnavailableError,
  TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY,
  TOOL_NOT_EXECUTED_SAFE_SUMMARY,
  TOOL_UNAVAILABLE_SAFE_SUMMARY,
  VISION_EGRESS_UNAVAILABLE_SAFE_SUMMARY,
} from "../tools/companion-tool-outcome.ts";

import { readCompanionWebSearchReceipts, readWebSearchReceipt, webSearchCitationBlocks, webSearchServiceAvailable } from "../../agent/web-search.ts";
import { createCompanionNoteObservation } from "./companion-note-observation.ts";
import { companionCurrentSuccessfulToolReceipts, validateCompanionFinish, type CompanionFinishArguments } from "./companion-finish.ts";
import { companionExecutionBlocks } from "./companion-tool-output.ts";
import { companionProviderFitsRequest } from "./companion-provider-fit.ts";
import { judgeCompanionStepClosing, waitingConfirmationReceipts } from "../turn/companion-step-closing.ts";
import { companionRecoveryIdentity, openCompanionTurn } from "../turn/companion-turn-opening.ts";
import { judgeCompanionUnavailableTool } from "../tools/companion-unavailable-tool.ts";
import { resumeCompanionInterruptedInput } from "./companion-resume-input.ts";
import { companionToolAuditLabel, rejectUnknownCompanionTool, unofferedToolReceipt, validateCompanionToolCall } from "../tools/companion-tool-call-validation.ts";
import { companionTurnMessagesWithImages, reviewCompanionImageClaim } from "./companion-attachment-images.ts";
import { applyCompanionToolLoad, createCompanionToolSurface, companionAttachmentReadRequired } from "../tools/companion-tool-surface.ts";

export async function runCompanionAgentLoop(args: CompanionAgentLoopArgs): Promise<CompanionAgentLoopResult> {
  if (typeof args.provider.executeAgentTurn !== "function") {
    throw new Error("provider does not support companion agent turns");
  }
  let utterancePublished = false;
  const event: AgentEventContext = {
    ctx: args.ctx,
    read: args.read,
    expiresAt: args.expiresAt,
    constraints: args.toolConstraints,
    flushThinking: args.flushThinking,
    onUtterancePublished: async (...published) => {
      utterancePublished = true;
      await args.onUtterancePublished?.(...published);
    },
  };
  const attemptStartedAt = Date.now();
  const meta = await readRunMeta(event);
  if (meta.stepCount > 0) {
    const [published] = await withWorkerWorkspaceTransaction({ workspaceId: args.ctx.workspaceId, userId: args.read.userId },
      tx => tx.execute(sql`SELECT 1 FROM companion_run_utterances WHERE run_id=${args.read.runId} LIMIT 1`));
    utterancePublished = Boolean(published);
  }
  if (!meta.globalEnabled || meta.currentAccountEpoch !== args.read.accountEpoch) {
    throw new Error("companion agent account epoch is stale or globally disabled");
  }
  // One deployment time policy covers the run and resumed attempts; leases renew independently.
  const handlerStartedAtMs = args.handlerStartedAtMs ?? attemptStartedAt;
  const agentBudget = resolveCompanionAgentBudget();
  const handlerDeadlineAt = handlerStartedAtMs + agentBudget.loopDeadlineMs;
  const configuredBudget = companionExecutionPolicy();
  // 主动参与不再自带一份写死的步数闸（2026-10-13 用户决定：Agent 不设硬上限）。
  // 失控收敛由同一份执行政策的时间与步数声明负责，不按"这是她自己发起的"另开一档。
  const budget = configuredBudget;
  const contractDeadlineAt = attemptStartedAt + (budget.deadlineMs ?? Infinity) - meta.elapsedMs;
  let deadlineAt = Math.min(handlerDeadlineAt, contractDeadlineAt);
  if (deadlineAt <= attemptStartedAt) throw new CompanionAgentBudgetExceededError("companion agent execution budget exhausted");
  let flushedMs = 0;
  /** 本次尝试自上次落库以来新消耗的执行时间（累加到 agent_elapsed_ms）。 */
  const elapsedDelta = (): number => {
    const total = Date.now() - attemptStartedAt;
    const delta = total - flushedMs;
    if (delta <= 0) return 0;
    flushedMs = total; return delta;
  };
  // 扁平工具面（方案 29 §4.1）：**不再选技能**。
  //
  // 原来这里 `selectSkill()` 用 triggerHints 子串匹配挑一个技能，工具面 = 它的
  // toolNames；没命中就是空工具面 + 单步。基线实测 90.7% 的轮次一个工具都没有——
  // "读记忆 / 看系统状态 / 跳转页面"不是被她拒绝，而是**根本没出现在她面前**。
  // 每轮给出权限档允许的全部工具，直到当前任务完成。
  // Latest-turn attention is independent of durable goals and historical actions.
  const attentionRequestHash = sha256Utf8V1(args.read.userText);
  const notePage = (args.read.pageContext as { context?: { pageKind?: string; replyPurpose?: string; annotationTarget?: unknown;
    noteId?: unknown; noteVersionId?: unknown }; selection?: unknown } | null);
  const writingAnnotation = Boolean(notePage?.context?.annotationTarget);
  const completeNoteReply = !writingAnnotation && Boolean(notePage?.context?.replyPurpose
    || (notePage?.context?.pageKind === "note" && notePage.selection));
  event.constraints = {
    ...event.constraints,
    webSearchEnabled: meta.webSearchEnabled === true && webSearchServiceAvailable(),
    noteLibraryReadEnabled: event.constraints.noteLibraryReadEnabled !== false
      && !userForbidsNoteLibraryRead(args.read.userText),
  };
  // 工具面的成员资格只由**声明 + 宿主事实**决定（见 shared/companion-host-context.ts）：
  // 权限档、数据外发政策，加上"这一轮实际发生了什么"（批注/整篇正文/主动轮）。
  // 本轮判定（意图）在类型上就进不来——2026-10-09 的翻车正是它进来过一次。
  const entryMode = resolveCompanionEntryMode();
  const availableDefinitions = resolveAllCompanionAgentTools(meta.permissionLevel, event.constraints)
    .filter(definition => companionCapabilityOfferedInHostContext(definition,
      { writingAnnotation, completeNoteReply, initiative: Boolean(args.read.initiativeInput) }));
  const cachedInterpretation = args.read.initiativeInput ? agentTurnInterpretationV1Schema.parse(
    companionInitiativeInterpretationFields({ requestHash: attentionRequestHash, topic: args.read.initiativeInput.topic }))
    : writingAnnotation ? agentTurnInterpretationV1Schema.parse({
    version: 1, requestHash: attentionRequestHash, intent: "task", toolUse: "act", subjects: [],
    goalRelation: "new", goalReference: null, candidateOperations: ["notes.write.annotate"], ambiguities: [], status: "interpreted",
  }) : meta.turnInterpretation?.requestHash === attentionRequestHash ? meta.turnInterpretation : null;
  // 注意力记录是宿主占位：没有独立分类，也没有等待分类的串行往返。
  const routeRecorder = createCompanionRouteRecorder({ entryMode });
  const opening = openCompanionTurn(args);
  const dialogueHistory = opening.dialogueHistory;
  const currentRequest = opening.currentRequest;
  let messages = opening.messages;
  // The turn's pictures travel with the user message when the model can see.
  messages = await companionTurnMessagesWithImages({ args, messages });
  const recoveryIdentity = companionRecoveryIdentity({
    args, currentRequest, permissionLevel: meta.permissionLevel,
    definitions: availableDefinitions,
    primary: args.provider,
    fallback: args.fallbackProvider ?? null,
  });
  const recovered = meta.stepCount > 0
    ? await loadCompanionRuntimeCheckpoint(event, recoveryIdentity) : null;
  if (recovered && recovered.state.entryMode !== entryMode) throw new CompanionContextChangedError();
  if (recovered) {
    if (recovered.phase === "waiting" && recovered.proposalId !== args.continuationProposalId)
      throw new CompanionContextChangedError();
    messages = [...recovered.state.messages];
    if (recovered.state.visibleSegmentDelivered.includes(true)
      && args.onVisibleCheckpoint && !await args.onVisibleCheckpoint(recovered.state.visibleSegments.join(VISIBLE_SEGMENT_SEPARATOR))) {
      throw new CompanionStreamStoppedError("recovered visible checkpoint diverged from committed output");
    }
    deadlineAt = Math.min(deadlineAt, attemptStartedAt + (budget.deadlineMs ?? Infinity) - recovered.state.elapsedMs);
    logger.info({ runId: args.read.runId, stepId: recovered.stepId, phase: recovered.phase,
      stepCount: recovered.state.stepCount }, "restored private Agent working-state checkpoint");
    if (recovered.phase === "settled") return recovered.result!;
  }
  const noteObservation = createCompanionNoteObservation(event, Boolean(recovered), notePage?.context);
  const attention = await settleCompanionAttention({ args, requestHash: attentionRequestHash, cached: cachedInterpretation });
  // 回合前段（注意力落定、历史绑定、工具面与能力快照）整段在
  // companion-turn-preamble.ts；messages 仍归运行时所有，用访问器接进去。
  const preamble = await settleCompanionTurnPreamble({
    loopArgs: args,
    event,
    meta,
    budget,
    availableDefinitions,
    dialogueHistory,
    recovered,
    attention,
    elapsedMsDelta: elapsedDelta(),
    getMessages: () => messages,
    setMessages: (next) => { messages = next; },
  });
  const {
    historyBinding, userRequiresTool, userAskedForAction, definitions, reminderListAsked,
    steerableReadTools, steerableActionTools, requestedActionTools,
  } = preamble;
  const directControls = createCompanionDirectControls({ mode: entryMode, attention,
    userText: args.read.userText, deepened: recovered?.state.deepened, onInterpretation: args.onTurnInterpretation });
  if (definitions.length === 0)
    throw new Error(`companion tool surface resolved empty for permission "${String(meta.permissionLevel)}"`);
  const notePrefetch = await noteObservation.read(attention);
  const notePrefetched = notePrefetch.prefetched;
  if (notePrefetch.message) messages.push(notePrefetch.message);
  const requiresMaterialRead = (!notePrefetched || notePrefetch.truncated === true)
    && userRequiresTool && attention.toolUse === "read";
  const toolSurface = createCompanionToolSurface({
    definitions,
    initiative: Boolean(args.read.initiativeInput),
    hasImageAttachments: Boolean(args.read.userImageAttachments?.length),
    pageKind: notePage?.context?.pageKind ?? null,
    candidateOperations: attention.candidateOperations,
    loadedToolNames: recovered?.state.loadedToolNames ?? [],
  });
  const offeredToolDefinitions = toolSurface.offered;
  /** Persisted with the checkpoint so a resumed turn keeps what it loaded. */
  const loadedToolNames = toolSurface.loadedToolNames;
  routeRecorder.record(event);


  /**
   * 这一轮开不开思考：**整轮定一次**，不在每个 step 重算。快速档在不加深时关，
   * 调用 companion_deepen 或直接选择深度档时开；工具回来不会另开一档。
   */
  const disableThinking = directControls.disableThinking();
  const responseStrategy = companionResponseStrategy(attention);
  // 这是调用意图，不是上游实际消耗：不支持 none 的模型仍使用最低思考档。
  logger.info({ runId: args.read.runId, requestedDisableThinking: disableThinking,
    providerId: args.provider.id, modelId: args.provider.modelId, basis: `entry:${entryMode}` },
    "companion turn thinking preference resolved; provider applies declared levels");
  // 先显示可观察的工作状态，不把模型内部思维链当作 UI 内容。明确动作轮用任务状态
  // 取代泛化的「正在思考」；status 事件与 assistant.delta/TTS 分开。
  const actionProgressLabel = companionActionProgressLabel(attention, requestedActionTools);
  if (notePrefetched) {
    await emitCompanionAssistantStatus({
      workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
      status: "thinking", safeLabel: "已读到指定笔记，正在整理回答。",
    });
  } else if (actionProgressLabel) {
    await emitCompanionAssistantStatus({
      workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
      status: "acting", safeLabel: actionProgressLabel,
    });
  } else if (!disableThinking) {
    await emitCompanionAssistantStatus({
      workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
      status: "thinking", safeLabel: "正在思考…",
    });
  }
  // 压力压缩的发出口整段搬到 companion-step-compaction.ts（发送、检查点恢复、
  // 历史/工具折叠与轨迹记账同属一域）；运行时保留可变状态的所有权，用访问器接进去。
  let historyFoldApplied = recovered?.state.historyFoldApplied ?? false;
  const compactedEvidence: AgentTurnRequest["messages"] = [...recovered?.state.compactedEvidence ?? []];
  const stepCompaction = createCompanionStepCompaction({
    event,
    read: args.read,
    runId: args.read.runId,
    conversationId: args.read.conversationId,
    signal: args.ctx.signal,
    deadlineAt,
    initialProvider: args.provider,
    contextReceipts: args.contextReceipts,
    compactionCheckpoints: args.compactionCheckpoints,
    compactionCooldown: args.compactionCooldown,
    compactionTrace: args.compactionTrace,
    persistCompactionTraces: args.persistCompactionTraces,
    replayFold: args.replayFold,
    historyBinding,
    compactedEvidence,
    getMessages: () => messages,
    setMessages: (next) => { messages = next; },
    getStepCount: () => stepCount,
    getHistoryFoldApplied: () => historyFoldApplied,
    setHistoryFoldApplied: (value) => { historyFoldApplied = value; },
  });
  const sendWithBoundedCompaction = stepCompaction.send;

  // Numeric evidence must include receipts obtained during this loop, not only
  // the request's starting transcript. Otherwise a freshly read statistic is
  // treated as invented and costs a full correction round.
  const contextText = (): string => companionNumericEvidenceContext([
    ...args.baseMessages, ...compactedEvidence, ...companionCurrentRequestMessages(messages),
  ]);
  const hostReminderInjected = typeof args.read.hereAndNow === "string" && /提醒/.test(args.read.hereAndNow);
  let stepCount = recovered?.state.stepCount ?? resolveAgentStepCountForResume(meta);
  const resumedStepCount = stepCount;
  let toolCallCount = meta.toolCallCount;
  const invalidArgumentCalls = new Set<string>(recovered?.state.invalidArgumentCalls);
  /**
   * Repeated schema failures are a tool-contract problem, not new work. Different
   * invalid payloads defeat the identical-call guard, so count per tool instead:
   * after five rejected payloads this run stops offering that tool and lets the
   * model answer or use another one. Valid arguments reset nothing else.
   */
  const malformedToolAttempts = new Map<string, number>();
  const malformedTools = new Set<string>();
  /** Any rejected tool call (schema, unknown, unoffered) counts toward one cap. */
  let invalidToolCallCount = 0;
  const invalidToolCallLimitReached = (): boolean => {
    invalidToolCallCount += 1;
    return invalidToolCallCount >= COMPANION_INVALID_TOOL_CALLS_ALLOWED;
  };
  /** A forbidden time-based action may be retried a few times, then settled. */
  const executionConstraintAttempts = new Map<string, number>();
  const rejectedExecutionConstraints = new Set<string>(recovered?.state.rejectedExecutionConstraints);
  /** 每个「工具名 + 参数」指纹已交付过几次成功回执；判据与收口见 `companion-progress-guard.ts`。 */
  const successfulCallReceipts = new Map<string, number>();
  /**
   * Set when the previous step produced a completion claim with no receipt.
   * The next step must actually call a tool; the host does not choose which.
   */
  let correctionRequiresTool = false;
  /** One correction for describing an unseen picture, then the honest note stands. */
  let imageClaimCorrected = false;
  event.verifyUtterance = () => {
    // The rule exists to stop one reply from being said twice: prose first, then
    // the same sentences again through the speech tool.
    if (visibleSegments.some(segment => segment.trim()))
      throw new CompanionToolNotExecutedError("这轮已经开始连续回复，请接着把当前回复完成。需要分几句交流时，从第一句使用发言能力，避免正文和发言重复。");
  };
  event.reviewInitiativeSpeech = text => reviewCompanionInitiativeSpeech({ ctx: args.ctx, read: args.read, text, provider: args.provider });

  /**
   * 本轮可见正文的分段（④-b）：每个产出文本的步各占一段，按顺序拼接。
   *
   * 为什么不是"只取终答那一步的 content"：带工具的一步如果开了流式，它的开场白
   * 已经发给客户端了，无法撤回；把开场白排除在最终正文之外，等于让"客户端累积的
   * 草稿"与"assistant.final 指向的消息"从第一个字起就不一致。纳入进来则流式前缀
   * 天然是最终正文的前缀，硬约束（reconcileStreamedText）无需放宽。
   */
  const visibleSegments: string[] = [...recovered?.state.visibleSegments ?? []];
  /** 与 visibleSegments 一一对应：该段是否已经流式下发过（E 去重的安全性判据）。 */
  const visibleSegmentDelivered: boolean[] = [...recovered?.state.visibleSegmentDelivered ?? []];
  /** 本轮工具结果带出的富块（nav / quote…），随终态消息落进 `companion_messages.blocks`。 */
  const richBlocks: CompanionContentBlockV1[] = [...recovered?.state.richBlocks ?? []];
  let webSearchCalls = recovered?.state.webSearchCalls ?? 0;
  const richBlockKeys = new Set<string>(richBlocks.map(block => canonicalJsonV1(block)));
  const pushRichBlock = (block: CompanionContentBlockV1) => {
    const key = canonicalJsonV1(block);
    if (richBlockKeys.has(key)) return;
    richBlockKeys.add(key);
    richBlocks.push(block);
  };
  if (meta.toolCallCount > 0 && !recovered) {
    for (const result of await readCompanionWebSearchReceipts({ workspaceId: args.ctx.workspaceId, userId: args.read.userId }, args.read.runId)) {
      webSearchCalls++;
      for (const block of webSearchCitationBlocks(result)) pushRichBlock(block);
      if (result.status === "unavailable") event.constraints.webSearchEnabled = false;
    }
  }
  /** 退化回复闸每轮至多触发一次（2026-09-19 深夜，tokenrhythm 退化窗口实测）。 */
  let degenerateRetried = recovered?.state.degenerateRetried ?? false;
  // Repair may resume after new native tool evidence, but repeated malformed
  // prose with no intervening progress must not become an unbounded retry loop.
  let outputRepairToolCount: number | null = recovered?.state.outputRepairToolCount ?? null;
  /** A wrong calculated result gets a real chance to converge; a repeated same
   * wrong result is the signal that it is not making progress. */
  const arithmeticMismatchCounts = new Map<string, number>();
  let arithmeticCorrectionCount = 0;
  const actionReplayCounts = new Map<string, number>();
  /** "让她做件事却没落地"闸每轮至多一次：补一步就够，不把她逼成循环。 */
  let actionSteerAttempts = recovered?.state.actionSteerAttempts ?? 0;
  let quoteCorrectionUsed = recovered?.state.quoteCorrectionUsed ?? false;
  /**
   * "她说查过了、其实没查"单独一条额度（下面闸的注释说为什么不能共用）。
   */
  let lookupClaimSteered = recovered?.state.lookupClaimSteered ?? false;
  /** steer 之后紧跟的那一步换哪个 provider（见下面 stepProvider 的选取）。 */
  let steerSwapToFallback = recovered?.state.steerSwapToFallback ?? false;
  let protocolFallback = recovered?.state.protocolFallback ?? false;
  utterancePublished ||= recovered?.state.utterancePublished ?? false;
  if (args.continuationProposalId && (!recovered || recovered.phase === "waiting")) {
    messages = await loadContinuation(event, messages, args.continuationProposalId, deadlineAt,
      recovered?.phase === "waiting" ? { pendingCallId: recovered.pendingCallId!, onExecution: saved => {
        for (const block of companionExecutionBlocks(saved, { runId: args.read.runId,
          fallbackLabel: "查看已保存的结果" })) pushRichBlock(block);
      } } : undefined);
  }
  const workingState = (completedStepCount = stepCount): CompanionRuntimeState => ({
    messages: [...messages], compactedEvidence: [...compactedEvidence], stepCount: completedStepCount, toolCallCount,
    elapsedMs: Math.max(meta.elapsedMs, recovered?.state.elapsedMs ?? 0) + Date.now() - attemptStartedAt,
    visibleSegments: [...visibleSegments], visibleSegmentDelivered: [...visibleSegmentDelivered], richBlocks: [...richBlocks],
    webSearchCalls, historyFoldApplied, invalidArgumentCalls: [...invalidArgumentCalls],
    rejectedExecutionConstraints: [...rejectedExecutionConstraints], degenerateRetried, outputRepairToolCount,
    actionSteerAttempts, quoteCorrectionUsed, lookupClaimSteered,
    steerSwapToFallback, protocolFallback, utterancePublished,
    loadedToolNames: [...loadedToolNames],
    entryMode, deepened: directControls.deepened(),
  });
  const finishBoundary = (stepId: string, status: "succeeded" | "failed", hash: string | undefined,
    errorCode?: string, result?: Extract<CompanionAgentLoopResult, { status: "completed" }>) => finishStep(event, stepId, status, hash,
      errorCode, encodeCompanionRuntimeCheckpoint(recoveryIdentity, { phase: result ? "settled" : "continue",
        state: workingState(), ...(result ? { result } : {}) }));
  /**
   * 质量闸用尽重试后的收尾：保留已经交付/落下的真实内容，附一句宿主核对说明。
   * 目的不是“成功”，而是不让一次模型波动把整轮打成死信，也不把没做的事说成做了。
   */
  const settleWithHostNote = async (input: {
    stepId: string; said: string; saidHash: string; errorCode: string; note: string;
    includeSaid: boolean; landedWrites: boolean; reasoning?: AgentTurnResult["reasoning"];
  }): Promise<Extract<CompanionAgentLoopResult, { status: "completed" }>> => {
    const settlement = assembleCompanionHostSettlement({
      visibleSegments, visibleSegmentDelivered, richBlockCount: richBlocks.length,
      said: input.said, includeSaid: input.includeSaid, note: input.note,
      landedWrites: input.landedWrites, reasoning: input.reasoning,
    });
    if (settlement.empty) {
      await finishBoundary(input.stepId, "failed", input.saidHash, input.errorCode);
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
      throw new AgentOutputError("no_progress", "no verified reply body or saved result remains after correction");
    }
    const completedResult = { status: "completed" as const, text: settlement.text, blocks: richBlocks, memoryRefs: [],
      writesLanded: input.landedWrites,
      ...(settlement.reasoning ? { reasoning: settlement.reasoning } : {}) };
    await finishBoundary(input.stepId, "failed", input.saidHash, input.errorCode, completedResult);
    await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
      ...args.contextReceipts?.runMetaPatch() });
    return completedResult;
  };
  const arithmeticCorrectionInstruction = (mismatch: CompanionArithmeticMismatch) =>
    `你写出的结果 ${mismatch.claimed} 与表达式 ${mismatch.expression} 的计算结果 ${mismatch.expected} 不一致。`
    + "先用 companion_observe（action=calculate）核对，再用回执里的结果回答；不要心算。";
  const settleArithmeticLoop = async (stepId: string, result: AgentTurnResult, mismatch: CompanionArithmeticMismatch) =>
    settleWithHostNote({ stepId, said: String(result.content ?? ""), saidHash: sha256Utf8V1(String(result.content ?? "")),
      errorCode: "ARITHMETIC_MISMATCH",
      note: `（宿主核对：${mismatch.expression} 的计算结果是 ${mismatch.expected}，回答里的 ${mismatch.claimed} 对不上；已停止继续尝试。）`,
      includeSaid: false,
      landedWrites: companionActionResultRecorded(messages, companionWriteToolNames(definitions)),
      reasoning: result.reasoning });
  /**
   * Help a wrong calculation converge instead of accepting or instantly killing
   * it. A different wrong result means the model is still trying; the same wrong
   * result repeated is the signal that it cannot get there on its own.
   */
  const arithmeticRetry = async (input: { stepId: string; result: AgentTurnResult; text: string;
    stepEmitted: boolean; toolCallId?: string }) => {
    if (args.read.initiativeInput || !input.text.trim()) return null;
    const mismatch = companionArithmeticMismatch(args.read.userText ?? "", input.text);
    if (!mismatch) return null;
    const key = `${mismatch.expression}|${mismatch.claimed}`;
    const repeats = (arithmeticMismatchCounts.get(key) ?? 0) + 1;
    arithmeticMismatchCounts.set(key, repeats);
    arithmeticCorrectionCount += 1;
    const instruction = arithmeticCorrectionInstruction(mismatch);
    if (repeats > COMPANION_ARITHMETIC_REPEAT_ALLOWED || arithmeticCorrectionCount > COMPANION_ARITHMETIC_TOTAL_ALLOWED) {
      return { kind: "settled" as const, result: await settleArithmeticLoop(input.stepId, input.result, mismatch) };
    }
    if (input.toolCallId) {
      messages.push({ role: "tool", toolCallId: input.toolCallId,
        content: JSON.stringify({ ok: false, status: "not_executed", error: instruction }) });
    }
    messages = dropCompanionInternalCorrections(messages);
    messages.push(...companionStepCorrectionMessages({ currentRequest, alreadyDisplayed: input.stepEmitted, instruction }));
    await finishBoundary(input.stepId, "succeeded", sha256Utf8V1(input.text));
    await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
    return { kind: "continue" as const };
  };
  /** Stop a turn that keeps producing unusable tool calls. The agent remains
   * free between attempts; this only bounds a loop that cannot make progress. */
  const settleInvalidToolLoop = async (stepId: string, result: AgentTurnResult) => {
    const said = String(result.content ?? "");
    logger.warn({ runId: args.read.runId, stepCount, invalidToolCallCount },
      "companion invalid tool call loop reached its cap; settling honestly");
    return settleWithHostNote({ stepId, said, saidHash: sha256Utf8V1(said),
      errorCode: "TOO_MANY_INVALID_TOOL_CALLS",
      note: "（宿主核对：本轮累计多次工具调用没有形成有效执行，已停止继续尝试；没有保存或修改。）",
      includeSaid: false,
      landedWrites: companionActionResultRecorded(messages, companionWriteToolNames(definitions)),
      reasoning: result.reasoning });
  };
  const waitForConfirmation = (proposalId: string, calls: AgentTurnResult["toolCalls"], index: number) => {
    // Close every declared call honestly before a future model request. Later
    // calls remain in the transcript with their original arguments and an
    // explicit non-execution receipt; the Agent can replan after the decision.
    messages.push(...waitingConfirmationReceipts(proposalId, calls, index));
  };
  /**
   * "这句话在语法上说完了吗"——**只看结构，不看长度**（40 §4.4.2）。
   *
   * 旧版按活跃度取 2/4/6 字当阈值。合同把这条判掉了：「移除…所有场景共用的长度
   * 要求」「短句…不单独触发重跑」「字数…只作诊断」。用户设成「安静」就是要
   * 「在的。」这种答案，阈值拦它等于每轮白烧一次调用。
   *
   * 这层薄包装留在运行时文件里：输出闸棘轮（companion-gate-ratchet.test.ts 的 G5）
   * 要求 `looksTruncatedReply(` 的调用仍出现在运行时侧，挪进别的模块会让它红。
   */
  const companionReplyIsTruncated = (text: string): boolean => looksTruncatedReply(stripVoiceExpressionTags(text));
  // 有效的步数上限就是"没有"（2026-10-16：agent 里不许存在预算上限，也不许用预算
  // 兜底）。`budget.maxSteps` 若被部署侧设过，它只作为 run 回执里的观测读数
  // （见上面 `workingState()`），既不抽走工具、也不结束这一轮，更不会被告知模型。
  const stepBudget = Infinity;
  return executeTurn<CompanionAgentLoopResult>({
    signal: args.ctx.signal, now: Date.now,
    limits: () => ({ maxSteps: null, deadlineAt }),
    budgetError: () => new CompanionAgentBudgetExceededError("companion agent deadline exceeded"),
    advance: async () => {
    if (args.ctx.signal.aborted) throw new Error("companion agent aborted");
    if (Date.now() >= deadlineAt) {
      throw new CompanionAgentBudgetExceededError("companion agent deadline exceeded");
    }
    const currentMeta = await readRunMeta(event);
    if (!currentMeta.globalEnabled || currentMeta.currentAccountEpoch !== args.read.accountEpoch) {
      throw new Error("companion agent account epoch changed during execution");
    }
    stepCount += 1;
    // 不再有"最后一步"（2026-10-16：不要用预算的方式兜底）。旧写法走到配置的步数
    // 上限就抽走工具面逼她作答——那是用计数决定她说什么。纯函数那一侧仍接受这个
    // 入参供探针渲染文案，运行时永远传 false。
    const finalAnswerOnly = false;
    /**
     * Adaptive-thinking ladder for hosts whose model has no adaptive mode.
     * It follows facts already true for this step, never the user's wording:
     *   - first casual step, no tool yet  -> none  (fast chat)
     *   - this turn has used a tool        -> medium (act on evidence)
     *   - correcting a failed/unsupported step -> high
     * Deepen is a user-visible control; it raises the ceiling to high.
     */
    const stepReasoningEffort = ((): "none" | "medium" | "high" => {
      if (actionSteerAttempts > 0 || arithmeticCorrectionCount > 0) return "high";
      if (directControls.deepened()) return "high";
      if (toolCallCount > 0) return "medium";
      return "none";
    })();
    const needsAttachedImageRead = toolCallCount === 0 && companionAttachmentReadRequired({
      hasImageAttachments: Boolean(args.read.userImageAttachments?.length),
      visionEnabled: event.constraints.visionEnabled === true,
      userText: args.read.userText,
    });
    const currentSuccesses = companionCurrentToolSuccesses([...compactedEvidence, ...messages]);
    const editPrerequisite = companionNoteEditPrerequisite({ requestedActions: requestedActionTools,
      hasPageNote: typeof notePage?.context?.noteId === "string",
      hostNotePrefetched: notePrefetched && notePrefetch.truncated !== true,
      successfulTools: currentSuccesses });
    const actionReceiptReady = requestedActionTools.length > 0
      && requestedActionTools.every(name => currentSuccesses.some(tool => tool.name === name));
    const pendingMaterialRead = requiresMaterialRead && toolCallCount === 0;
    // Candidates may name the domain tool or one of its operations; the surface
    // speaks domain tools only. Normalize before deciding which tool survives.
    const materialReadTools = new Set(attention.candidateOperations.map(name => companionOperationDomainTool(name) ?? name));
    // 工具面、执行政策与请求装配这三样的判据在 `companion-agent-step-assembly.ts`。
    const requireToolThisStep = correctionRequiresTool && stepCount > resumedStepCount;
    correctionRequiresTool = false;
    const { tools: toolsOfferedThisStep, toolChoice: toolChoiceThisStep } = companionStepToolSurface({
      toolDefinitions: offeredToolDefinitions().filter(tool => !malformedTools.has(tool.name))
        .filter(tool => tool.name !== "companion_deepen"
          || (entryMode === "direct_fast" && !directControls.deepened()))
        .filter(tool => tool.name === "companion_finish" || (needsAttachedImageRead ? tool.name === "companion_visual"
          : editPrerequisite === "search" ? tool.name === "companion_notes_read"
          : editPrerequisite === "read" ? tool.name === "companion_notes_read"
          : !pendingMaterialRead || materialReadTools.size === 0 || materialReadTools.has(tool.name))),
      finalAnswerOnly,
      requiresTool: (userRequiresTool && (userAskedForAction || !notePrefetched || notePrefetch.truncated === true))
        || needsAttachedImageRead || editPrerequisite !== null
        || requireToolThisStep,
      toolCallCount: editPrerequisite ? 0 : toolCallCount,
    });
    const runtimePolicy = companionStepPolicyText({
      permissionLevel: currentMeta.permissionLevel,
      toolCount: toolsOfferedThisStep.length,
      stepBudget,
      finalAnswerOnly,
      attentionIntent: attention.intent,
      requestSource: currentRequest.hostObservation ? "host_observation" : "user",
      offeredToolNames: toolsOfferedThisStep.map((tool) => tool.name),
      writingAnnotation,
      completeNoteReply,
    });
    /**
     * A required read tool is a routing decision, not a knowledge answer:
     * spending the full thinking budget before calling `companion_read_note`
     * made the first visible word wait ~20s on MiMo (2026-10-17). The final
     * answer step still uses the turn's declared thinking level.
     */
    const readOnlyRequiredStep = toolChoiceThisStep === "required"
      && (needsAttachedImageRead || editPrerequisite !== null || (!userAskedForAction && stepCount === resumedStepCount + 1));
    if (readOnlyRequiredStep) {
      logger.info({ runId: args.read.runId, stepCount, basis: "read-required-first-step" },
        "companion read-only required step uses the lowest declared thinking level");
    }
    /**
     * 第一步就是普通一步：没有分类器，也没有可复用的闲聊预生成。
     */
    let stepRequest: AgentTurnRequest = assembleCompanionStepRequest({
      turnPolicy: typeof args.baseMessages[0]?.content === "string" ? args.baseMessages[0].content : "",
      runtimePolicy,
      executionGuidance: [pendingMaterialRead ? "用户本轮明确要求读取材料，目前还没有本轮读取回执。现在先调用所提供的读取工具；历史回复及历史读取不能证明最新资料的状态，也不能代替本轮请求的读取。要求最近更新的手记时，先用 companion_notes_read（action=search）的 order=updated 取得当前候选，再 action=read 读取正文。此步不直接回答摘要，也不声称已经读完。" : "",
        editPrerequisite ? "当前编辑能力允许从对话中修改已保存手记，目标页无需预先打开；历史里要求先打开页面的拒绝不再代表本轮条件。先定位并读取完整段落，后续步骤会提供编辑工具；权限与版本核验仍须通过。" : "",
        editPrerequisite === "search" ? "现在先用 companion_notes_read（action=search）定位用户指定的已保存手记，取得真实noteId；本步不撰写正文、不猜测ID。" : "",
        editPrerequisite === "read" ? "现在用 companion_notes_read（action=read）读取目标版本，includeBlocks=true、maxChars=20000，取得真实version、blockIndex与完整content。目标ID不确定时先搜索；未读完按游标续读。本步不撰写修改内容。" : "",
        responseStrategy.guidance, companionExecutionConstraintGuidance(attention),
        companionDirectGuidance(entryMode)].filter(Boolean).join("\n"),
      attention,
      currentUserText: currentRequest.hostObservation ? undefined : args.read.userText,
      messages: companionNoteEditRoutingMessages(messages, requestedActionTools.includes("notes.write.edit"), noteObservation.hasResolvedTarget(attention)),
      tools: toolsOfferedThisStep,
      toolChoice: toolChoiceThisStep,
      disableThinking: directControls.disableThinking(),
      reasoningEffort: stepReasoningEffort,
      provider: args.provider,
      temperature: responseStrategy.temperature,
    });
    const stepId = await persistStep(event, stepCount, auditHash(stepRequest));
    stepCompaction.setStepId(stepId);
    const preparation = new CompanionToolPreparation(definitions.filter(definition =>
      toolsOfferedThisStep.some(tool => tool.name === definition.name)), async (tool, definition, status) => {
      await appendAgentEvent(event, "agent.tool", { tool: {
        toolCallId: tool.id, name: definition.name, toolVersion: definition.toolVersion,
        riskClass: definition.riskClass, status,
        safeLabel: status === "requested"
          ? `正在准备${(companionToolLabel(definition.name) ?? "这一步").replace(/^正在/, "")}`
          : companionToolLabel(definition.name) ?? "这一步",
        ...(status === "not_executed" ? { safeSummary: "内容准备中断，这一步没有执行。" } : {}),
      } });
    });
    // 这一步默认走主档；需要恢复时采用正式 companion_fallback 槽。
    // 备用槽可能只有 64k 窗口，装不下时切过去会把一次可恢复的 steering
    // 变成整轮 AGENT_BUDGET_EXCEEDED。装不下就留在主槽重试。
    const pendingSteer = steerSwapToFallback;
    let stepProvider = args.provider;
    if ((steerSwapToFallback || protocolFallback) && typeof args.fallbackProvider?.executeAgentTurn === "function") {
      const fallbackFits = await companionProviderFitsRequest(args.fallbackProvider, stepRequest);
      if (fallbackFits) stepProvider = args.fallbackProvider;
      else logger.warn({ runId: args.read.runId, stepCount, fallbackModelId: args.fallbackProvider.modelId },
        "companion steer kept on primary provider: fallback context window cannot fit this request");
    }
    steerSwapToFallback = false;
    if (stepProvider !== args.provider) {
      // 记录实际备用槽模型；同型号恢复也保持可观测。
      logger.warn(
        { runId: args.read.runId, stepCount, modelId: stepProvider.modelId },
        "companion agent steered step runs on the configured fallback provider",
      );
    }
    /** Tools this step loaded, so they are callable in the same output. */
    const loadedThisStep = new Set<string>();
    /** 本步是否已经下发过文本（重试判据，每步重置）。 */
    let stepEmitted = false;
    /** The text the user actually saw this step, including streamed deltas. */
    let stepVisibleText = "";
    const resumingInput = recovered?.phase === "input" && stepCount === resumedStepCount + 1;
    if (resumingInput) {
      const resumed = await resumeCompanionInterruptedInput({
        event, stepId, stepRequest, stepProvider,
        permissionLevel: meta.permissionLevel,
        workspaceId: args.ctx.workspaceId, userId: args.read.userId,
        runId: args.read.runId, conversationId: args.read.conversationId,
        initialVisibleText: args.initialVisibleText,
        visibleSegments, visibleSegmentDelivered, messages, currentRequest,
        compactionCheckpoints: args.compactionCheckpoints,
        separator: VISIBLE_SEGMENT_SEPARATOR,
      });
      stepRequest = resumed.stepRequest;
      // Reuse the whole stored model result, keeping its already delivered prefix once.
      if (resumed.reuseStoredResult) stepEmitted = true;
    }
    await saveCompanionRuntimeInput(event, stepId, encodeCompanionRuntimeCheckpoint(recoveryIdentity,
      { phase: "input", state: { ...workingState(stepCount - 1), steerSwapToFallback: pendingSteer } }));
    const runModelStepTask = createCompanionModelStepRunner({
      job: args.ctx,
      read: args.read,
      event,
      permissionLevel: meta.permissionLevel,
      deadlineAt: () => deadlineAt,
      getStepId: () => stepId,
    });
    let result;

    try {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new CompanionAgentBudgetExceededError("companion agent deadline exceeded");
      }
      const providerCallTimeout = Math.min(resolveProviderCallTimeout("companion_agent"), remainingMs);
      const executeBufferedTurn = async (signal: AbortSignal): Promise<AgentTurnResult> => {
        const execution = await executeCompanionAgentTurnWithToolChoiceFallback({
          request: stepRequest,
          provider: stepProvider,
          fallbackProvider: args.fallbackProvider,
          signal,
          executeTurn: (provider, request, callSignal) => sendWithBoundedCompaction(request, (folded) =>
            runModelStepTask(
              provider,
              folded,
              callSignal,
              (taskSignal) => executeWatchedCompanionTurn(provider, folded, taskSignal),
              providerCallTimeout,
            )),
          onFallback: (error, fallbackProvider) => logger.warn({
            runId: args.read.runId,
            stepCount,
            providerCode: error.providerCode,
            primaryModelId: stepProvider.modelId,
            fallbackModelId: fallbackProvider.modelId,
          }, "companion required tool_choice is unsupported; retrying on cross-model fallback"),
        });
        stepProvider = execution.provider;
        return execution.result;
      };
      /**
       * 这一步能不能走流式（2026-09-19 ④-b）。
       *
       * - 终答步（工具已被撤下）恒可流式；
       * - **带工具的一步**只有在 provider 声明"流式也解析 tool_calls"时才可流式：
       *   否则模型返回的工具调用会被静默丢掉（用户看到"我去看看"，然后什么都没发生）。
       *   未声明的实现那一步仍走整段取回；opencode_go 已解析流式工具回执。
       */
      const canStreamThisStep = Boolean(args.onProviderDelta)
        && !resumingInput
        && !utterancePublished
        && typeof stepProvider.chatCompletionStream === "function"
        && (finalAnswerOnly || stepRequest.tools.length === 0 || stepProvider.chatCompletionStreamToolCalls === true);
      stepCompaction.setProvider(stepProvider);
      // One transport-attempt budget per logical step, shared by streaming and
      // buffered mode. A persistent 5xx used to spend two stream attempts and
      // then three buffered attempts, five serial provider calls for one step.
      let providerTransportAttempts = 0;
      const runBuffered = (attempts = Math.max(1, 3 - providerTransportAttempts)): Promise<AgentTurnResult> =>
        runWithCompanionModelRetries(
          () => runWithAbortBudget(
            executeBufferedTurn,
            args.ctx.signal,
            Math.min(providerCallTimeout, Math.max(1, deadlineAt - Date.now())),
          ),
          { signal: args.ctx.signal, deadlineAt, attempts,
            // With another provider available, let the caller switch instead of re-asking this one.
            switchProviderAvailable: args.fallbackProvider !== undefined && args.fallbackProvider !== args.provider },
        );

      if (canStreamThisStep) {
        // Every step streams: deltas go straight through validate → persist → SSE.
        // 分段符与最终正文的拼接口径必须一致（非首段 "\n\n"），否则已下发前缀
        // 与最终正文会分叉——见 joinVisibleSegmentsDeduped。
        // "非首段"要按**实际下发过**判断，不能按分段数组长度：被 hold 攒住、从没发出去
        // 的那一段留在数组里时，客户端其实一个字都没收到，此时再补一个分段符就成了
        // 下发原文的开头两个换行（实机 2026-09-22 场景 T 的分叉就是这么来的）。
        /**
         * 提前派发（R7，40b §4.1-1）。**默认关闭**——见 companion-eager-dispatch-config。
         *
         * 它在这里做什么：provider 每判定一格工具调用「确定完整」就把那一格交给
         * scheduler；scheduler 判完（顺序／缺口／确认门／参数完整／只读白名单）
         * 就**开跑**，且**不 await**——await 会把流按停，而 R7 要的就是并行。
         *
         * 它**不在这里做什么**：
         *  - 不推 tool 消息。循环里那一条 `ensureAgentToolCall` 会拿到提前派发写好的
         *    终态，走已有的重放路径（`!replayable` → 重发事件 + 推消息 + continue），
         *    所以工具**不会被跑第二遍**。这也正是为什么不要新写一条"跳过"分支：
         *    跳过漏了 tool 消息，下一次 provider 请求会因缺 tool 响应被拒。
         *  - 不重发事件、不重放结果——那是账本的职责，而账本只有一行 per call id。
         */
        // 流式那一步同样可能先被闸拦下（此时一个字都还没下发，重发不会复读）。
        const attemptStream = (): Promise<AgentTurnResult> => {
          providerTransportAttempts += 1;
          return sendWithBoundedCompaction(stepRequest, (folded) =>
            runModelStepTask(stepProvider, folded, args.ctx.signal, (signal) =>
              runStreamingAgentStep({
                provider: stepProvider,
                stepRequest: folded,
                ctxSignal: signal,
              timeoutMs: providerCallTimeout,
              onProviderDelta: async text => {
                stepVisibleText += text;
                return args.onProviderDelta!(text);
              },
              ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
              separatorBefore: visibleSegmentDelivered.includes(true) ? VISIBLE_SEGMENT_SEPARATOR : "",
              // Action and required-read steps buffer prose until the step's
              // tool outcome is known. Streaming them looked faster, but a
              // required-read step that then gets steered produced two full
              // answers in one bubble (2026-10-17 `today` turn).
              //
              // Buffer only when this step must call a tool before speaking.
              deferPublication: stepRequest.toolChoice === "required",
              onToolCallStarted: preparation.observe,
              // Every step batches, not only the final one: a direct answer is step 1,
              // and holding nothing there would leave the degenerate gate blind.
              // 换来的是坍缩闸可达——按用户口径（"说的太短了"是抱怨 #1），这个方向值。
              // 攒批不影响正确性：没下发过的内容仍由 writeTail 在终态补发，
              // "已下发是最终正文的前缀"这条不变量照旧成立。
              holdUntilChars: stepHoldChars({ userAskedForAction: userAskedForAction && !actionReceiptReady }),
              onTextEmitted: () => { stepEmitted = true; },
            })));
        };
        /**
         * 这一步能不能原样重来。
         *
         * 判据是"**这一步**一个字都没下发"（不是整轮）：前面几步已经下发的内容
         * 与这一步无关，重打不会让客户端看到两段前缀。`stepEmitted` 由
         * runStreamingAgentStep 在 emit 时**同步**置位——不能用 deliveredChars()
         * 事后判断，因为 emit 是排队落库的，provider 抛错时可能还有增量压在
         * 链上没有落库（那时重试会重复下发同一段文本）。
         */
        const canRetryStream = (err: unknown): boolean =>
          canRetryCompanionStream(err, { emitted: stepEmitted, now: Date.now(), deadline: deadlineAt });
        try {
          result = await attemptStream();
        } catch (error) {
          result = await recoverCompanionStreamFailure({
            error, runBuffered, attemptStream, canRetryStream,
            stepProvider, fallbackProvider: args.fallbackProvider,
            fitsFallback: async () => args.fallbackProvider !== undefined
              && await companionProviderFitsRequest(args.fallbackProvider, stepRequest),
            useFallback: provider => { stepProvider = provider; protocolFallback = true; },
            stepCount, runId: args.read.runId,
          });
        }
      } else {
        result = await runBuffered();
      }
      if (containsCompanionToolProtocol(String(result.content ?? "")))
        throw new CompanionToolOutputRepairError("", String(result.content ?? ""));
      await preparation.finish(result.toolCalls ?? []);
    } catch (error) {
      await preparation.finish([]).catch(preparationError => logger.warn(
        { runId: args.read.runId, err: preparationError }, "companion tool preparation could not be settled"));
      // A landed write outlives a transport failure; do not bury it in an error card.
      const landed = args.ctx.signal.aborted ? null : settleCompanionLandedWritesOnFailure({ messages,
        visibleSegments, visibleSegmentDelivered, richBlocks, stepEmitted, definitions });
      if (landed) {
        const completedResult = { status: "completed" as const, text: landed.text, blocks: richBlocks, memoryRefs: [], writesLanded: true };
        await finishBoundary(stepId, "failed", undefined, "PROVIDER_UNAVAILABLE", completedResult);
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(), ...args.contextReceipts?.runMetaPatch() });
        logger.warn({ runId: args.read.runId, stepCount, receipts: landed.receiptIds, err: error },
          "companion model step failed after landed writes; delivered the real receipts host-side");
        return { kind: "settled", result: completedResult };
      }
      if (error instanceof CompanionOutputTimeoutError && !stepEmitted && !protocolFallback
        && stepProvider === args.provider && args.fallbackProvider !== args.provider
        && typeof args.fallbackProvider?.executeAgentTurn === "function" && !args.ctx.signal.aborted
        && await companionProviderFitsRequest(args.fallbackProvider, stepRequest)) {
        protocolFallback = true;
        await finishBoundary(stepId, "failed", undefined, error.code === "provider_first_output_timeout"
          ? "PROVIDER_FIRST_OUTPUT_TIMEOUT" : "PROVIDER_IDLE_TIMEOUT");
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
        await emitCompanionAssistantStatus({ workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
          status: "acting", safeLabel: "当前服务的输出等待较久，正在用备用服务接续这次任务。" });
        return { kind: "continue" };
      }
      const outputRepair = error instanceof CompanionToolOutputRepairError ? error
        : error instanceof AgentOutputError && error.code === "arguments_malformed"
          ? new CompanionToolOutputRepairError("", "", "arguments_malformed") : null;
      if (outputRepair && outputRepairToolCount !== toolCallCount && Date.now() < deadlineAt && !args.ctx.signal.aborted) {
        outputRepairToolCount = toolCallCount;
        // The configured alternate keeps the frozen request, checkpoints and
        // write receipts. Once a native protocol fails, don't bounce later
        // steps back onto the same incompatible route after each saved note.
        if (stepProvider === args.provider && args.fallbackProvider && args.fallbackProvider !== args.provider
          && typeof args.fallbackProvider.executeAgentTurn === "function") protocolFallback = true;
        if (outputRepair.publishedText.length > 0) {
          visibleSegments.push(outputRepair.publishedText);
          visibleSegmentDelivered.push(true);
        }
        messages = dropCompanionInternalCorrections(messages);
        messages.push(...companionStepCorrectionMessages({ currentRequest,
          alreadyDisplayed: outputRepair.publishedText.length > 0,
          instruction: [outputRepair.code === "arguments_malformed"
            ? "上一版原生工具调用的参数不是合法 JSON，宿主没有执行那次调用。"
            : "上一版把工具调用协议写进了正文，宿主没有执行这些文字。",
            "需要工具时只能使用本轮声明的原生工具调用通道和参数结构；不需要工具就直接完成当前任务。此前已取得的真实工具回执继续有效，不重复已完成的操作。已显示的前缀保留，只接续或纠正，不从头重复。"].join("\n"),
        }));
        await finishBoundary(stepId, "failed", outputRepair.draftSha256,
          outputRepair.code === "arguments_malformed" ? "TOOL_ARGUMENTS_INVALID" : "REPLY_FORMAT_INVALID");
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch() });
        logger.warn({ runId: args.read.runId, stepCount, toolCallCount,
          publishedChars: outputRepair.publishedText.length, draftSha256: outputRepair.draftSha256, reason: outputRepair.code },
        "companion malformed protocol draft quarantined; continuing with explicit correction feedback");
        return { kind: "continue" };
      }
      // 归因：run 预算耗尽（含 handler abort —— 它的 signal 就是 args.ctx.signal）
      // 必须与 provider 故障区分开，否则运维无法从错误码看出"真超时"。
      const deadlineExceeded = Date.now() >= deadlineAt || args.ctx.signal.aborted;
      await finishStep(
        event,
        stepId,
        "failed",
        undefined,
        deadlineExceeded ? "AGENT_DEADLINE_EXCEEDED" : outputRepair
          ? outputRepair.code === "arguments_malformed" ? "TOOL_ARGUMENTS_INVALID" : "REPLY_FORMAT_INVALID" : "PROVIDER_UNAVAILABLE",
      );
      throw error;
    }
    // Truncated with nothing delivered: retry once at the declared ceiling. A
    // streamed prefix cannot be withdrawn, so that case is only logged.
    if (result.finishReason === "length" && !stepEmitted && Date.now() < deadlineAt) {
      const ceiling = companionStepOutputCeiling(stepProvider);
      if (ceiling > stepRequest.maxTokens) {
        const retryMaxTokens = ceiling;
        logger.warn(
          { runId: args.read.runId, stepCount, maxTokens: stepRequest.maxTokens, retryMaxTokens },
          "companion agent step truncated by maxTokens; retrying once at the declared ceiling",
        );
        try {
          const retryRequest = { ...stepRequest, maxTokens: retryMaxTokens };
          result = await runWithAbortBudget(
            (signal) => runModelStepTask(
              stepProvider,
              retryRequest,
              signal,
              (taskSignal) => executeWatchedCompanionTurn(stepProvider, retryRequest, taskSignal),
              Math.min(resolveProviderCallTimeout("companion_agent"), Math.max(1, deadlineAt - Date.now())),
            ),
            args.ctx.signal,
            Math.min(resolveProviderCallTimeout("companion_agent"), Math.max(1, deadlineAt - Date.now())),
          );
          stepRequest = retryRequest;
        } catch (retryError) {
          logger.warn(
            { err: retryError, stepCount },
            "companion agent truncation retry failed; keeping the truncated result",
          );
        }
      } else {
        logger.warn({ runId: args.read.runId, stepCount, maxTokens: stepRequest.maxTokens },
          "companion agent step hit the model's own output ceiling; nothing left to grow into");
      }
    }
    if (args.read.initiativeInput && isCompanionParticipationClosure(result.content)) result = { ...result, content: "" };
    let calls: NonNullable<AgentTurnResult["toolCalls"]> = result.toolCalls ?? [];
    if (calls.length === 0 && (utterancePublished || !String(result.content ?? "").trim())) {
      const [published] = await withWorkerWorkspaceTransaction({ workspaceId: args.ctx.workspaceId, userId: args.read.userId },
        tx => tx.execute(sql`SELECT 1 FROM companion_run_utterances WHERE run_id=${args.read.runId} LIMIT 1`));
      // Publishing selects an explicit message channel. A subsequent bare final
      // only ends execution; it cannot leak completion notes or repeat speech.
      if (utterancePublished || published || (args.read.initiativeInput && !String(result.content ?? "").trim())) {
        await finishBoundary(stepId, "succeeded", sha256Utf8V1(""), undefined,
          { status: "completed", text: "", blocks: richBlocks, memoryRefs: [] });
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
        return { kind: "settled", result: { status: "completed", text: "", blocks: richBlocks, memoryRefs: [] } };
      }
    }
    // 修复阶梯的判据与日志在 companion-answer-repair.ts（本轮之前它和循环缠在一起，
    // 58 条运行时用例一条都没盯到这条降级路径）。
    const repair = await repairDegenerateCompanionAnswer({
      result, calls, stepRequest, stepEmitted, alreadyRetried: degenerateRetried,
      deadlineAt, stepCount, runId: args.read.runId,
      fallbackProvider: args.fallbackProvider, ctxSignal: args.ctx.signal, isTruncated: companionReplyIsTruncated,
      invokeProvider: ({ provider, request, signal, timeoutMs }) => runModelStepTask(
        provider, request, signal, taskSignal => executeWatchedCompanionTurn(provider, request, taskSignal), timeoutMs),
    });
    result = repair.result;
    calls = repair.calls;
    degenerateRetried = repair.retried;
    const landedWrites = companionActionResultRecorded(messages, companionWriteToolNames(definitions));
    // Repair incomplete drafts first. Every surviving explanation then takes
    // complete delivery guards; a repaired draft cannot bypass them.
    if (result.finishReason === "length") {
      // A capped response is incomplete even if it contains a tool call. Do not
      // dispatch more actions or publish it as a successful final answer.
      const prefix = typeof result.content === "string" ? result.content : "";
      const prefixHash = sha256Utf8V1(prefix);
      if (!stepEmitted && prefix.length > 0 && args.onProviderDelta) {
        const separator = visibleSegmentDelivered.some(Boolean) ? VISIBLE_SEGMENT_SEPARATOR : "";
        if (!(await args.onProviderDelta(separator + prefix))) {
          throw new CompanionStreamStoppedError("companion incomplete output delivery stopped");
        }
      }
      const truncated = judgeCompanionDeliveryGate({ gate: "output_truncated", landedWrites,
        hasDeliverablePrefix: prefix.trim().length > 0 });
      if (truncated.destroysTurn) {
        await finishStep(event, stepId, "failed", prefixHash, truncated.stepErrorCode);
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch() });
        throw new AgentOutputError("output_truncated", "companion answer reached its output ceiling");
      }
      // 不销毁必须在这里收步：往下会派发工具（截断的响应不许派发），且前缀已发过会重复。
      const truncatedResult = { status: "completed" as const, text: prefix, blocks: richBlocks, memoryRefs: [], writesLanded: landedWrites };
      await finishBoundary(stepId, "failed", prefixHash, truncated.stepErrorCode, truncatedResult);
      logger.warn({ runId: args.read.runId, stepCount }, truncated.bypassNote);
      return { kind: "settled", result: truncatedResult };
    }
    // 这一步说过的话交给产出核对（三类判据见 `reviewCompanionStepCorrection`）。
    // 必须显式写 `: string`：`said → lookupClaim → steerSwapToFallback → stepProvider → result → said`
    // 是一圈真实的类型推断回路（steer 之后那一步换哪个模型，取决于这一步说了什么）。
    // 少这个注解，tsc 报 TS7022/TS18046 一长串，而看起来最无辜的改法都会"莫名"炸掉整个文件。
    const said: string = String(result.content ?? "").trim() ? String(result.content ?? "") : stepVisibleText;
    /**
     * Describing a picture that was never looked at is the same class of failure
     * as claiming a write with no receipt: the facts say it cannot be known.
     * The pictures count as seen when they were sent with this request, or when
     * the turn holds a successful image read.
     */
    const imageGate = reviewCompanionImageClaim({
      said, calls, messages, sentDirectly: args.turnImagesSentDirectly === true,
      hasAttachments: Boolean(args.read.userImageAttachments?.length),
      alreadyCorrected: imageClaimCorrected, runId: args.read.runId, stepCount,
    });
    if (imageGate) {
      imageClaimCorrected = true;
      messages = dropCompanionInternalCorrections(messages);
      messages.push(...companionStepCorrectionMessages({ currentRequest, alreadyDisplayed: stepEmitted,
        instruction: imageGate.instruction }));
      await finishBoundary(stepId, "succeeded", sha256Utf8V1(said));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
      return { kind: "continue" };
    }
    if (calls.length === 0) {
      const arithmeticStep = await arithmeticRetry({ stepId, result, text: said, stepEmitted });
      if (arithmeticStep) return arithmeticStep;
    }
    // The receipt gate is independent of routing: whatever entry mode is used,
    // "already set / saved / forgot" with no tool receipt this turn is a claim,
    // not a completion. Word-list claim detection only decides whether to ask
    // for a retry; it never chooses a tool or a route.
    const review = reviewCompanionStepCorrection({
      said,
      contextText: contextText(),
      compactedEvidence,
      messages,
      turnToolUse: attention.toolUse,
      pageContext: args.read.pageContext,
      stepCalls: calls.length,
      toolCallCount,
      finalAnswerOnly,
      stepCount,
      stepBudget,
      nowMs: Date.now(),
      deadlineAt,
      userAskedForAction,
      requestedActionTools,
      // A correction without a receipt still has not read anything. Completed
      // reads and host prefetches remove this requirement; step count cannot.
      requiresReadReceipt: requiresMaterialRead && calls.length === 0 && toolCallCount === 0,
      requiresReminderRead: reminderListAsked && !hostReminderInjected
        && calls.length === 0 && toolCallCount === 0,
      landedWrites,
      actionSteerAttempts,
      lookupClaimSteered,
      quoteCorrectionUsed,
    });
    const { unverifiedClaims, unverifiedQuotes, unbackedActionClaims, lookupClaim, steerPlan, correctQuote } = {
      unverifiedClaims: [] as string[], unverifiedQuotes: [] as string[],
      unbackedActionClaims: review.unbackedActionClaims,
      lookupClaim: false, correctQuote: false,
      // Quote/numeric wording checks stay off; a promise with no receipt does
      // not. "我这就打开笔记库" / "我这就去查" are exactly what this branch
      // must not deliver when nothing ran. The retry is decided by facts (no
      // receipt, budget left) and never names a tool.
      steerPlan: {
        steer: calls.length === 0 && stepCount < stepBudget && Date.now() < deadlineAt
          && actionSteerAttempts < actionSteerBudget({ userAskedForAction })
          && ((userAskedForAction && !companionActionResultRecorded(messages, requestedActionTools))
            || (toolCallCount === 0 && (review.unbackedActionClaims.length > 0
              || looksLikeUnfulfilledActionNarration(said)))),
        consumeAction: true, consumeLookup: false, swapToFallback: false,
      } };
    if (steerPlan.steer || correctQuote) {
      if (correctQuote) quoteCorrectionUsed = true;
      if (steerPlan.consumeAction) actionSteerAttempts += 1;
      // The correction is a prompt, not a forced tool call: the agent remains
      // free to answer or choose another action.
      // The correction step may need a tool from a group the first step did not
      // load. Expand the surface for this steer rather than naming a tool the
      // model cannot call.
      const steerNames = resolveCompanionInitialToolNames({
        availableToolNames: definitions.map(definition => definition.name),
        pageKind: notePage?.context?.pageKind ?? null,
        hasImageAttachments: Boolean(args.read.userImageAttachments?.length),
        candidateOperations: [...requestedActionTools, ...steerableActionTools, ...steerableReadTools],
      });
      for (const name of steerNames) loadedToolNames.add(name);
      // 只花**这一次真正为它补的那条额度**。此前这里无条件把 `lookupClaimSteered`
      // 置真，于是第 1 步的形状问题会把"说查过而没查"那条独立额度一起吃掉——
      // 实机 2026-09-22 真人轮量到：第 1 步因数字无出处被 steer，第 2 步她说出
      // "搜索没搜到任何相关记忆"（零工具，而库里有 10 条含那句话的活记忆），
      // 已经没额度了，那句假阴性就交付了。这一行的注释原本写的就是这个设计意图。
      if (steerPlan.consumeLookup) lookupClaimSteered = true;
      // 「说查过而没查」和「让她做事却没做」这两类，补的那一步都换兜底模型：
      // 指名道姓要求她调用工具都换不来一次真实调用（实机 2026-09-21 两次），
      // 这是模型档的问题，多说一遍同样的话只会多烧一步。
      // 后者今天新增：实测同一句「有哪张卡到期了？打开第一张」连跑两轮，
      // action-request 的 steer 都触发了，同档第二次仍然 tools=0，
      // 还回了一句"到期列表现在是空的"（库里 25 条 pending 到期）——
      // 不换模型时，这一步只是让她把同一个谎再说一遍。
      steerSwapToFallback = steerPlan.swapToFallback;
      // 空的一步（provider 退化时会一个字都不给）不写进正文，也不回灌空的
      // assistant 消息——那会在拼接里留下一个孤立的空段。
      if (said.trim().length > 0 && (!pendingMaterialRead || stepEmitted)) {
        // Only text the user already received stays in the visible reply; a held
        // draft was never seen and is exactly what this correction replaces.
        // assistant 消息仍然回灌：模型要看得见自己说过什么，纠正才接得上。
        if (stepEmitted) {
          visibleSegments.push(said);
          visibleSegmentDelivered.push(true);
        }
        // 没发出去的草稿不回灌历史：尤其是“已保存/已改好”这种无回执的完成声明，
        // 一旦留在消息里，下一轮她会把自己的谎当依据（2026-10-25 实机连锁复读）。
        // 纠正指令已经带着待核对的片段，足够她重写；只有用户真正看到的那段才进历史。
        if (stepEmitted) messages.push({ role: "assistant", content: said });
      }
      messages = dropCompanionInternalCorrections(messages);
      messages.push(...companionStepCorrectionMessages({
        currentRequest,
        alreadyDisplayed: stepEmitted,
        instruction: buildCompanionStepCorrectionInstruction({
          missingActionReceipt: userAskedForAction && requestedActionTools.length > 0
            && !companionActionResultRecorded(messages, requestedActionTools),
          prerequisiteTools: editPrerequisite ? toolsOfferedThisStep.map(tool => tool.name) : undefined,
          correctQuote,
          unbackedActionClaims,
          unverifiedQuotes,
          unverifiedClaims,
          lookupClaim,
          steerableReadTools,
          steerableActionTools,
          requestedActionTools,
        }),
      }));
      correctionRequiresTool = unbackedActionClaims.length > 0;
      await finishBoundary(stepId, "succeeded", sha256Utf8V1(said));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      logger.warn({ runId: args.read.runId, stepCount, chars: said.trim().length,
        claims: unverifiedClaims.slice(0, 4),
        actionClaims: unbackedActionClaims.slice(0, 4),
        by: companionSteerCause({ correctQuote, unverifiedClaims, unverifiedQuotes, lookupClaim,
          unbackedActionClaims, userAskedForAction }) },
      "companion agent step needs a steer; cause in `by`");
      return { kind: "continue" };
    }
    /**
     * Give the agent more than one chance when it claimed a write without any
     * receipt. The next step is still a normal free-choice step: no forced
     * tool_choice and no named tool, only the factual feedback that nothing ran.
     */
    if (calls.length === 0 && unbackedActionClaims.length > 0 && !args.read.initiativeInput
      && actionSteerAttempts < COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED) {
      actionSteerAttempts += 1;
      correctionRequiresTool = true;
      messages = dropCompanionInternalCorrections(messages);
      messages.push(...companionStepCorrectionMessages({ currentRequest, alreadyDisplayed: stepEmitted,
        instruction: `上一段声称“${unbackedActionClaims.slice(0, 2).join("、")}”，但本轮没有任何工具回执。`
          + "不要假设它已经执行；如果用户要求改变数据，请调用合适的工具并等待真实回执；如果只是聊天，请删掉完成声明后正常回答。" }));
      await finishBoundary(stepId, "succeeded", sha256Utf8V1(said));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
      logger.warn({ runId: args.read.runId, stepCount, attempt: actionSteerAttempts,
        claims: unbackedActionClaims.slice(0, 3) }, "companion unbacked claim gets another free-choice step");
      return { kind: "continue" };
    }
    // Unbacked completion claims get an honest note; a proactive turn just stays quiet.
    if (calls.length === 0 && unbackedActionClaims.length > 0 && !args.read.initiativeInput) {
      const completedResult = await settleWithHostNote({ stepId, said, saidHash: sha256Utf8V1(said),
        errorCode: "ACTION_CLAIM_UNVERIFIED", note: companionUnbackedActionFallback(landedWrites),
        includeSaid: stepEmitted, landedWrites, reasoning: result.reasoning });
      logger.warn({ runId: args.read.runId, stepCount, claims: unbackedActionClaims.slice(0, 4),
        landedWrites, emitted: stepEmitted }, "companion unbacked action claim withheld; delivered an honest receipt note");
      return { kind: "settled", result: completedResult };
    }
    // 一次纠正的额度限制生成次数，不能把仍不匹配的原文引用降为成功终答。
    const saidHash = sha256Utf8V1(said);
    const quoteGate = judgeCompanionDeliveryGate({ gate: "unverified_quote", landedWrites,
      // A verified quote mismatch must not erase an otherwise complete explanation.
      // The correction step already ran; keep the text and leave a failed trace.
      hasDeliverablePrefix: said.trim().length > 0 });
    if (calls.length === 0 && unverifiedQuotes.length > 0) {
      if (quoteGate.destroysTurn) {
        const completedResult = await settleWithHostNote({ stepId, said, saidHash,
          errorCode: quoteGate.stepErrorCode, note: companionUnverifiedQuoteFallback(),
          includeSaid: stepEmitted, landedWrites, reasoning: result.reasoning });
        logger.warn({ runId: args.read.runId, stepCount, quotes: unverifiedQuotes.slice(0, 2) },
          "companion quote remained unverified after correction; delivered an honest note");
        return { kind: "settled", result: completedResult };
      }
      await finishBoundary(stepId, "failed", saidHash, quoteGate.stepErrorCode);
      logger.warn({ runId: args.read.runId, stepCount }, quoteGate.bypassNote);
    }
    if (reminderListAsked && !hostReminderInjected && !messages.some(message => message.role === "tool")) {
      logger.warn({ runId: args.read.runId, stepCount }, "reminder list asked but never read; delivered an honest note");
      return { kind: "settled", result: await settleWithHostNote({ stepId, said, saidHash,
        errorCode: "REMINDER_LIST_NOT_READ", note: companionReminderReadFallback(),
        includeSaid: false, landedWrites, reasoning: result.reasoning }) };
    }
    if (requiresMaterialRead && calls.length === 0 && toolCallCount === 0) {
      const completedResult = await settleWithHostNote({ stepId, said, saidHash,
        errorCode: "READ_NOT_EXECUTED", note: companionMaterialReadFallback(),
        includeSaid: stepEmitted, landedWrites, reasoning: result.reasoning });
      logger.warn({ runId: args.read.runId, stepCount }, "requested material read still has no receipt; delivered an honest note");
      return { kind: "settled", result: completedResult };
    }
    const actionGate = judgeCompanionDeliveryGate({ gate: "action_not_executed", landedWrites });
    if (calls.length === 0 && userAskedForAction && requestedActionTools.length > 0
      && !companionActionResultRecorded(messages, requestedActionTools)) {
      if (actionGate.destroysTurn) {
        const completedResult = await settleWithHostNote({ stepId, said, saidHash,
          errorCode: actionGate.stepErrorCode, note: companionActionNotExecutedFallback(landedWrites),
          includeSaid: stepEmitted, landedWrites, reasoning: result.reasoning });
        logger.warn({ runId: args.read.runId, stepCount, requestedActionTools },
          "requested action has no receipt after correction; delivered an honest note instead of failing the run");
        return { kind: "settled", result: completedResult };
      }
      await finishBoundary(stepId, "failed", saidHash, actionGate.stepErrorCode);
      logger.warn({ runId: args.read.runId, stepCount }, actionGate.bypassNote);
    }
    if (calls.length === 0) {
      // 写回执已经落下时，普通正文同样可以交付：回执真实且属于本轮，宿主直接
      // 绑定它们，不再为了补一个 companion_finish 多花一次完整模型调用。
      if (landedWrites) {
        // The model wrote the user-facing answer but skipped the receipt
        // reference. The receipts are real and owned by this request, so bind
        // them host-side instead of asking for the same generation again.
        const receipts = companionCurrentSuccessfulToolReceipts(messages);
        const writes = receipts.filter(receipt => receipt.riskClass !== "read");
        if (writes.length > 0) {
          const base = joinVisibleSegmentsDeduped([...visibleSegments, said], [...visibleSegmentDelivered, stepEmitted]).text.trim();
          const summary = writes.map(receipt => receipt.summary).filter(Boolean).join("；");
          const text = base && summary ? `${base}\n\n${summary}`
            : base || (summary ? `改好了：${summary}。` : "改动已经保存。");
          const completedResult = { status: "completed" as const, text, blocks: richBlocks, memoryRefs: [],
            writesLanded: true, ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
          await finishBoundary(stepId, "succeeded", sha256Utf8V1(text), undefined, completedResult);
          await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
            ...args.contextReceipts?.runMetaPatch() });
          logger.warn({ runId: args.read.runId, stepCount, receipts: writes.map(receipt => receipt.id) },
            "companion wrote but skipped companion_finish; bound current-request receipts host-side");
          return { kind: "settled", result: completedResult };
        }
        const completedResult = await settleWithHostNote({ stepId, said, saidHash: sha256Utf8V1(said),
          errorCode: "FINISH_CONTRACT_INCOMPLETE",
          note: "（宿主核对：写入回执已经落下，但本轮没有按终答契约引用回执；完成状态以工具回执为准。）",
          includeSaid: stepEmitted, landedWrites, reasoning: result.reasoning });
        logger.warn({ runId: args.read.runId, stepCount },
          "companion wrote but did not finalize with receipt references; delivered an honest receipt note");
        return { kind: "settled", result: completedResult };
      }
      // ④-b：可见正文是**每一步 content 的顺序拼接**（工具步前的开场白也在里面）。
      // 拼接口径必须与流式下发的分段符一致，否则已下发前缀与最终正文分叉。
      // 判据用 length（不是 trim）：只要这一步吐出过字符，它的分段符就已经在下发原文里。
      const stepText = typeof result.content === "string" ? result.content : "";
      if (stepText.length > 0) {
        visibleSegments.push(stepText);
        // 这一步是否流式成功（stepEmitted 只在流式 emit 时置位；降级缓冲未 emit
        // 则为 false）——E 去重据此决定该段能不能丢。
        visibleSegmentDelivered.push(stepEmitted);
      }
      const deduped = joinVisibleSegmentsDeduped(visibleSegments, visibleSegmentDelivered);
      if (deduped.dropped.length > 0) {
        logger.warn(
          {
            runId: args.read.runId,
            stepCount,
            droppedCount: deduped.dropped.length,
            droppedChars: deduped.dropped.reduce((sum, segment) => sum + segment.length, 0),
          },
          "companion agent dropped duplicated undelivered segment(s) from the visible reply",
        );
      }
      const text = deduped.text;
      if (text.trim().length === 0) {
        const completedResult = await settleWithHostNote({ stepId, said, saidHash: sha256Utf8V1(said),
          errorCode: "EMPTY_AGENT_RESPONSE", note: companionEmptyReplyFallback(),
          includeSaid: false, landedWrites, reasoning: result.reasoning });
        logger.warn({ runId: args.read.runId, stepCount }, "companion agent returned an empty final response; delivered a host receipt note");
        return { kind: "settled", result: completedResult };
      }
      if (stepText.trim().length === 0 && visibleSegments.length > 0) {
        // 终答那一步一个字都没说，但前面工具步说过话——本轮只能拿开场白当答复。
        // 不判失败（客户端**已经看到**那段文字，此刻再报错只会让气泡与报错打架），
        // 但必须留下痕迹，否则"模型没作答"这件事在运维侧完全不可见。
        logger.warn(
          { runId: args.read.runId, stepCount, preambleChars: text.length },
          "companion agent final step was empty; answering with earlier step text only",
        );
      }
      // An already-streamed repeat cannot be dropped without diverging from the final text.
      const duplicated = deduped.dropped.length === 0 ? findDuplicateSegment(visibleSegments) : null;
      if (duplicated !== null) {
        logger.warn(
          {
            runId: args.read.runId,
            stepCount,
            chars: duplicated.length,
            excerpt: duplicated.slice(0, 40),
          },
          "companion agent repeated an earlier segment in the visible reply",
        );
      }
      const completedResult = { status: "completed" as const, text, blocks: richBlocks, memoryRefs: [], writesLanded: landedWrites,
        ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
      await finishBoundary(stepId, "succeeded", sha256Utf8V1(text), undefined, completedResult);
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      // 交回终步 reasoning：下一轮若以这条收尾，网关要求把 reasoning_text 一并带回。
      return { kind: "settled", result: completedResult };
    }
    // A tool step's content is a preamble, not the final answer. It was already
    // streamed, so it stays in the visible text or the draft diverges from the message.
    if (stepEmitted && typeof result.content === "string" && result.content.length > 0) {
      visibleSegments.push(result.content);
      visibleSegmentDelivered.push(true);
    }
    // Flush the complete preamble while the run still accepts output. Once the
    // card commits waiting state, its tail must not remain in a process buffer.
    if (visibleSegmentDelivered.includes(true) && args.onVisibleCheckpoint
      && !await args.onVisibleCheckpoint(visibleSegments.join(VISIBLE_SEGMENT_SEPARATOR))) {
      throw new CompanionStreamStoppedError("visible step checkpoint could not be committed");
    }
    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      // 思考模式模型（deepseek）要求下一轮把本轮 reasoning 原样回传，否则工具
      // 循环第二步 400「reasoning_text must be passed back」；句柄是 provider
      // 不透明数据，这里只做透传，不解析、不落库。
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result.phase ? { phase: result.phase } : {}),
    });
    for (const [callIndex, call] of calls.entries()) {
      // The card and the entire paused batch must commit together: a fast
      // confirmation or worker crash cannot observe a card without its state.
      event.prepareConfirmation = proposalId => ({ stepId,
        checkpoint: encodeCompanionRuntimeCheckpoint(recoveryIdentity, { phase: "waiting", proposalId,
          pendingCallId: call.id, state: { ...workingState(), messages: [...messages,
            ...waitingConfirmationReceipts(proposalId, calls, callIndex)] } }) });
      const identity = boundedToolCallIdentity(call);
      if (!identity) {
        // The provider returned a tool-call id/name outside the SSE contract
        // bounds (toolCallId ≤200, name ≤80). It cannot be keyed safely in the
        // audit table, so the call is blocked outright. The tool result still
        // has to be echoed with the original id or the provider will reject the
        // next request for a missing tool response.
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: String(call.id).slice(0, 200) || "invalid",
            name: String(call.name).slice(0, 80) || "invalid",
            toolVersion: "unknown",
            riskClass: "irreversible",
            status: "blocked",
            safeLabel: "工具调用标识非法，操作已阻止",
          },
        });
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: false, status: "blocked", error: "invalid tool call identity" }) });
        if (invalidToolCallLimitReached()) return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        continue;
      }
      // The reduced surface is a declaration, not a suggestion. A tool that
      // was not offered this step must be loaded first; otherwise the model
      // could silently use the full catalog and the prompt savings would be
      // cosmetic. `load_tools` itself must be callable even before loading.
      // A step can load a group and then use it in the same output. Judging that
      // second call against the surface as it was at step start rejected it as
      // "not loaded" (2026-10-27 live: diagram ran 10 steps doing exactly this),
      // so anything this step loaded is callable from here on.
      const offeredNow = toolsOfferedThisStep.some(tool => tool.name === identity.name)
        || (loadedThisStep.has(identity.name)
          && offeredToolDefinitions().some(tool => tool.name === identity.name));
      if (identity.name !== "companion_load_tools" && !offeredNow) {
        const offered = toolsOfferedThisStep.map(tool => tool.name);
        await recordRejectedToolCall(event, stepId, identity, safeArgumentsHash(call.arguments),
          getCompanionAgentTool(identity.name), "not_executed", "这个工具组还没有装载");
        messages.push({ role: "tool", toolCallId: call.id,
          content: unofferedToolReceipt(identity.name, offered) });
        if (invalidToolCallLimitReached()) return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        continue;
      }
      const definition = getCompanionAgentTool(identity.name);
      // 唯一的归属边界是"这个工具注册过吗"+ 上面的权限档过滤。
      // 原先还要求它属于本轮选中的那个技能，那正是能力被静默关掉的地方。
      if (!definition) {
        await rejectUnknownCompanionTool({
          identity,
          availableTools: toolsOfferedThisStep.map(tool => tool.name),
          recordRejected: reason => recordRejectedToolCall(event, stepId, identity,
            safeArgumentsHash(call.arguments), null, "blocked", reason),
          appendEvent: tool => appendAgentEvent(event, "agent.tool", { tool }),
          pushReceipt: content => messages.push({ role: "tool", toolCallId: identity.id, content }),
        });
        if (invalidToolCallLimitReached()) return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        continue;
      }
      const invalidIdentity = `${identity.name}:${safeArgumentsHash(call.arguments)}`;
      const validated = validateCompanionToolCall({ name: identity.name, arguments: call.arguments,
        alreadyRejected: invalidArgumentCalls, identity: invalidIdentity });
      if (validated.rejection) {
        invalidArgumentCalls.add(invalidIdentity);
        const malformedAttempts = companionMalformedToolExhausted(malformedToolAttempts, identity.name);
        if (malformedAttempts >= COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED) malformedTools.add(identity.name);
        logger.warn({ runId: args.read.runId, toolName: identity.name,
          malformedAttempts, ...validated.logFields },
        "companion tool arguments rejected; schema field metadata only");
        // 40b §3.2：`not_executed` 就是「参数无效」这一格。它据此知道
        // **改参数重来是有意义的**，而 "failed" 会让它以为这个工具本身坏了，
        // 转头去编一个答案。账本与模型现在说的是同一个词。
        await recordRejectedToolCall(
          event, stepId, identity, safeArgumentsHash(call.arguments),
          definition, "not_executed", validated.rejection.reason,
        );
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: identity.id,
            name: identity.name,
            toolVersion: definition.toolVersion,
            riskClass: definition.riskClass,
            status: "not_executed",
            safeLabel: companionToolAuditLabel(definition.name, definition.description),
            safeSummary: validated.rejection.reason,
          },
        });
        messages.push({ role: "tool", toolCallId: identity.id, content: validated.rejection.content });
        if (malformedAttempts >= COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED) {
          messages.push({ role: "tool", toolCallId: identity.id, content: JSON.stringify({
            ok: false, status: "unavailable",
            error: `${identity.name} 已经连续 ${malformedAttempts} 次参数不符合契约，本轮暂时不再提供这个工具。不要继续重试它；改用已提供的其他工具，或如实说明这一项没有做成。`,
          }) });
        }
        if (invalidToolCallLimitReached()) {
          return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        }
        // Exact duplicates are still just rejected receipts: the model may
        // correct the payload. The per-tool and run-wide caps end a real loop.
        continue;
      }
      const parsedArgs = { data: validated.accepted!.arguments };
      // A forget call may carry only the user's own description. Resolve it to
      // one real memory before the ledger/confirmation freezes arguments.
      // Several hits are only ambiguous when they are different facts: the same
      // preference stored twice is one thing to the user, and the delete already
      // cascades through its copies, so the best match is the right target.
      if (companionOperationName({ name: identity.name, arguments: parsedArgs.data }) === "memory.write.forget"
        && !parsedArgs.data.memoryId && typeof parsedArgs.data.query === "string") {
        const scope = { workspaceId: args.ctx.workspaceId, userId: args.read.userId };
        const found = await withWorkerWorkspaceTransaction(scope, tx =>
          retrieveCompanionMemoriesKeyword(tx, scope, String(parsedArgs.data.query), 6, null, { budgetTier: "active" }));
        const target = found.items.length === 1 ? found.items[0]
          : found.items.length > 1 && found.items.every(item => sameCompanionMemoryFact(item.content, found.items[0]!.content))
            ? found.items[0] : undefined;
        if (target) {
          parsedArgs.data = { ...parsedArgs.data, memoryId: target.memoryId,
            expectedRevision: target.revision };
        } else {
          messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({
            ok: false, status: "not_executed",
            error: found.items.length === 0
              ? "没有找到和这句相符的记忆；如果确实没有，就直接告诉用户当前没有这条，不要编造删除。"
              : `找到 ${found.items.length} 条可能相关的记忆，不能替你猜是哪一条。先向用户确认，或把命中的原话列出来让他选。`,
            candidates: found.items.map(item => ({ memoryId: item.memoryId, content: item.content.slice(0, 80) })),
          }) });
          continue;
        }
      }
      const serializedArgs = canonicalJsonV1(parsedArgs.data);
      const argsHash = sha256Utf8V1(serializedArgs);
      // Domain tools keep one model-facing name; internal receipts and policy
      // checks still key on the legacy operation they dispatch to.
      const executedToolName = companionOperationName({ name: identity.name, arguments: parsedArgs.data });
      const ledgerDefinition = executedToolName === definition.name ? definition : { ...definition, name: executedToolName };
      if (identity.name === "companion_finish") {
        if (calls.length !== 1) {
          messages.push({ role: "tool", toolCallId: call.id,
            content: JSON.stringify({ ok: false, status: "not_executed",
              error: "companion_finish 必须单独调用：先完成本轮工具调用，再单独交付最终回答。" }) });
          continue;
        }
        const verdict = validateCompanionFinish(parsedArgs.data as CompanionFinishArguments, messages);
        if (!verdict.ok) {
          messages.push({ role: "tool", toolCallId: call.id,
            content: JSON.stringify({ ok: false, status: "not_executed", error: verdict.error }) });
          await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
            toolVersion: definition.toolVersion, riskClass: definition.riskClass, status: "not_executed",
            safeLabel: "最终回答没有交付", safeSummary: verdict.error.slice(0, 240) } });
          continue;
        }
        const writesNow = companionActionResultRecorded(messages, companionWriteToolNames(definitions));
        if (writesNow && !verdict.writesLanded) {
          const error = "本轮已有真实写回执；companion_finish 的 actions 不能为空。把对应回执 id 放进 actions 后再交付，或先说明为什么这轮不需要引用它。";
          messages.push({ role: "tool", toolCallId: call.id,
            content: JSON.stringify({ ok: false, status: "not_executed", error }) });
          await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
            toolVersion: definition.toolVersion, riskClass: definition.riskClass, status: "not_executed",
            safeLabel: "最终回答没有交付", safeSummary: error } });
          continue;
        }
        const finishText = assembleCompanionFinishText({ visibleSegments, visibleSegmentDelivered,
          utterancePublished, finishText: verdict.text });
        // A finisher can leave verdict.text empty while the streamed content
        // (result.content) carries the actual answer. Review the text the user
        // would see, not just the finish argument.
        const reviewedFinishText = finishText.trim() ? finishText
          : (String(result.content ?? "").trim() ? String(result.content ?? "") : stepVisibleText);
        const arithmeticStep = await arithmeticRetry({ stepId, result, text: reviewedFinishText,
          stepEmitted, toolCallId: call.id });
        if (arithmeticStep) return arithmeticStep;
        messages.push({ role: "tool", toolCallId: call.id,
          content: JSON.stringify({ ok: true, receiptId: call.id, summary: "最终回答已交付" }) });
        await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
          toolVersion: definition.toolVersion, riskClass: definition.riskClass, status: "succeeded",
          safeLabel: "最终回答已交付" } });
        toolCallCount += 1;
        const text = finishText;
        const completedResult = { status: "completed" as const, text, blocks: richBlocks, memoryRefs: [],
          writesLanded: verdict.writesLanded || writesNow,
          ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
        await finishBoundary(stepId, "succeeded", sha256Utf8V1(text), undefined, completedResult);
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch() });
        return { kind: "settled", result: completedResult };
      }
      const control = await directControls.apply(identity.name, parsedArgs.data);
      if (control) {
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(control) });
        await updateRunMeta(event, { turnInterpretation: attention });
        await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
          toolVersion: definition.toolVersion, riskClass: definition.riskClass,
          status: control.ok ? "succeeded" : "not_executed", safeLabel: control.summary } });
        continue;
      }
      await directControls.observeDocumentWork([identity.name]);
      if (identity.name === "companion_load_tools") {
        const groups = (parsedArgs.data as { groups?: string[] }).groups ?? [];
        const loaded = await applyCompanionToolLoad({
          surface: toolSurface, groups, definitions,
          callId: call.id, toolName: identity.name, toolVersion: definition.toolVersion,
          pushReceipt: content => messages.push({ role: "tool", toolCallId: call.id, content }),
          recordAudit: tool => appendAgentEvent(event, "agent.tool", { tool }),
        });
        for (const name of loaded) loadedThisStep.add(name);
        continue;
      }
      const restriction = companionTimeWakeupConstraint(attention, identity.name, parsedArgs.data);
      if (restriction) {
        await recordRejectedToolCall(event, stepId, identity, argsHash, definition, "not_executed", restriction.instruction);
        await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
          toolVersion: definition.toolVersion, riskClass: definition.riskClass, status: "not_executed",
          safeLabel: companionToolLabel(definition.name), safeSummary: "这轮只按事件触发，没有设置时间。" } });
        messages.push({ role: "tool", toolCallId: identity.id, content: JSON.stringify({ ok: false,
          status: "not_executed", code: "execution_constraint", error: restriction.instruction }) });
        const constraintAttempts = (executionConstraintAttempts.get(restriction.key) ?? 0) + 1;
        executionConstraintAttempts.set(restriction.key, constraintAttempts);
        if (constraintAttempts >= 3 || invalidToolCallLimitReached()) {
          return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        }
        rejectedExecutionConstraints.add(restriction.key);
        continue;
      }
      // Field/range limits come from the capability's actual schema. A second
      // generic JSON character cap rejects valid escaped Markdown and evidence.
      const ledgerArguments = companionOperationArguments(executedToolName, parsedArgs.data);
      const record = await ensureAgentToolCall(
        event,
        stepId,
        ledgerDefinition,
        { id: identity.id, arguments: ledgerArguments },
        argsHash,
        result.reasoning,
      );
      const operationCallId = record.toolCallId;
      // The ledger owns replay of open records and reuse of terminal outcomes.
      const replayable = record.status === "requested" || record.status === "executing";
      if (!replayable) {
        // Re-emit under the original operation id so a new provider call id updates one node.
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: record.toolCallId,
            ...(record.toolCallId !== identity.id ? { preparationToolCallId: identity.id } : {}),
            name: definition.name,
            toolVersion: definition.toolVersion,
            riskClass: definition.riskClass,
            status: record.status as CompanionAgentToolStatus,
            safeLabel: companionToolLabel(definition.name) ?? definition.description.slice(0, 240),
            ...(record.safeSummary ? { safeSummary: record.safeSummary } : {}),
            ...(executedToolName === "notes.write.create" && record.status === "succeeded" && readCreatedNoteReceipt(record.resultRef)
              ? { noteCreated: readCreatedNoteReceipt(record.resultRef)! } : {}),
            ...(executedToolName === "notes.write.edit" && record.status === "succeeded" && record.resultRef ? { noteEdit: companionEditedNoteV1Schema.parse(JSON.parse(record.resultRef)) } : {}),
            ...(executedToolName === "notes.write.annotate" && record.status === "succeeded" && record.resultRef ? { noteAnnotation: JSON.parse(record.resultRef) } : {}),
            ...(record.status === "waiting_confirmation" && record.proposalId
              ? { proposalId: record.proposalId }
              : {}),
          },
        });
        if (record.status === "waiting_confirmation" && record.proposalId) {
          waitForConfirmation(record.proposalId, calls, callIndex);
          await updateRunMeta(event, {
            stepCount,
            toolCallCount,
            elapsedMsDelta: elapsedDelta(),
          });
          return { kind: "settled", result: { status: "waiting_for_confirmation", proposalId: record.proposalId, memoryRefs: [] } };
        }
        if (record.status === "succeeded") {
          // 账本复用回执=原地重放的计数点之一（另一个在下面真执行成功那一支）。
          const replayFingerprint = companionCallFingerprint(definition.name, argsHash);
          const replayLimit = companionReplayLimitFor(executedToolName, definition.riskClass);
          if (companionReplayExhausted(successfulCallReceipts, replayFingerprint, replayLimit)) {
            const replays = (actionReplayCounts.get(replayFingerprint) ?? 0) + 1;
            actionReplayCounts.set(replayFingerprint, replays);
            if (replays > COMPANION_ACTION_REPLAY_RETRIES_ALLOWED) {
              await finishStep(event, stepId, "failed", undefined, "REPEATED_IDENTICAL_TOOL_CALL");
              await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
              throw new AgentOutputError("no_progress", "companion repeated an identical tool call after its successful receipt");
            }
            messages.push({ role: "tool", toolCallId: call.id,
              content: JSON.stringify({ ok: true, replay: true,
                summary: "这个操作本轮已经执行成功，直接用上一条回执的结果；不要重复执行。",
                operation: executedToolName }) });
            malformedTools.add(definition.name);
            continue;
          }
          if (record.resultPayload) {
            const saved = record.resultPayload;
            for (const block of companionExecutionBlocks(saved, { runId: args.read.runId, toolName: definition.name,
              fallbackLabel: companionToolLabel(definition.name) ?? "查看结果" })) pushRichBlock(block);
            if (executedToolName === "web.search" && saved.value.status === "unavailable") event.constraints.webSearchEnabled = false;
            messages.push({ role: "tool", toolCallId: call.id,
              content: JSON.stringify({ ok: true, receiptId: call.id, operation: executedToolName, data: saved.value, summary: saved.safeSummary }) });
            continue;
          }
          const editedNote = executedToolName === "notes.write.edit" && record.resultRef
            ? companionEditedNoteV1Schema.parse(JSON.parse(record.resultRef)) : null;
          const editedModelReceipt = editedNote ? { kind: editedNote.kind, noteId: editedNote.noteId, noteVersionId: editedNote.noteVersionId, operation: editedNote.operation, summary: editedNote.summary } : null;
          const createdNote = executedToolName === "notes.write.create" ? readCreatedNoteReceipt(record.resultRef) : null;
          if (createdNote) for (const block of createdNoteToolResult(createdNote).blocks ?? []) pushRichBlock(block);
          const searchResult = executedToolName === "web.search" ? readWebSearchReceipt(record.resultRef) : null;
          if (searchResult) {
            for (const block of webSearchCitationBlocks(searchResult)) pushRichBlock(block);
            if (searchResult.status === "unavailable") event.constraints.webSearchEnabled = false;
          }
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              ok: true,
              receiptId: call.id,
              operation: executedToolName,
              summary: record.safeSummary ?? "工具已完成",
              ...(searchResult ? { data: searchResult } : {}),
              ...(editedModelReceipt ? { data: editedModelReceipt } : record.resultRef ? { resultRef: record.resultRef } : {}),
            }),
          });
        } else {
          const safeSummary = record.safeSummary ?? "检测到重复工具调用，已阻止重放";
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              ok: false,
              status: record.status,
              error: safeSummary,
            }),
          });
        }
        continue;
      }
      // 工具调用总数不再有上限（2026-10-16）：那个计数只保证"问得多的被砍掉"。
      // 计数仍如实累加，因为 run 回执与诊断读数要看它。
      if (record.isNew) toolCallCount += 1;
      /**
       * 受数据外发政策管的能力（读图）这一轮**没有**（40b §3.2 `unavailable`）。
       *
       * 为什么放在这里而不是执行器里：执行器那道门禁（`executeReadTool` 抛 blocked）
       * 看到的是「有人调了一个不该跑的工具」，说不出**用户缺了哪个开关**；
       * 而 §3.2 要求这一档「指出实际影响及可用替代」——那句话的素材在约束里，
       * 只有拿着 `event.constraints` 的这一层说得出来。
       *
       * 为什么在 `appendAgentEvent(requested)` **之前**：这一次调用从一开始就知道
       * 不会执行，先发一条 `requested` 只会让同一个节点多闪一次。账本那一行由
       * `ensureAgentToolCall` 建好了——doctor 那边要看的正是"她答应过、结果没发生"——
       * 所以直接把它终结成 `blocked`，精确词只给模型。
       */
      const unavailable = judgeCompanionUnavailableTool({
        toolName: executedToolName,
        constraints: event.constraints,
        searchLimitReached: executedToolName === "web.search"
          && budget.maxWebSearchCalls != null && webSearchCalls >= budget.maxWebSearchCalls,
      });
      if (unavailable) {
        await updateToolCall(event, operationCallId, {
          status: unavailable.ledgerStatus,
          safeSummary: unavailable.safeSummary,
        });
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: operationCallId,
            name: definition.name,
            toolVersion: definition.toolVersion,
            riskClass: definition.riskClass,
            status: unavailable.ledgerStatus,
            safeLabel: companionToolLabel(definition.name) ?? definition.description.slice(0, 240),
            safeSummary: unavailable.safeSummary,
          },
        });
        messages.push({ role: "tool", toolCallId: call.id, content: unavailable.receipt });
        continue;
      }
      /**
       * 执行段交给 `runCompanionToolExecution`（40b §4.1-1 / §4.1-2 / R7）。
       *
       * 为什么搬出去：提前派发要在**流还没结束**时跑同一段，而那不可能在循环里
       * ——循环要等 provider 交回 toolCalls 才存在。搬出去之后两边调的是**同一份**
       * 实现，不是两份。
       *
       * 这里仍留着三件执行段不该管的事：判参数与超长（账本在 `ensureAgentToolCall`
       * 之前各自落）、记预算（`toolCallCount` 是循环的账）、推 tool 消息
       * （形状由这一处统一决定，分叉不报错）。
       */
      // Before invoking an action, reuse the successful receipt for the same
      // fingerprint. Reads may legitimately re-read; actions and generated
      // artifacts must not run twice just because the model asked again.
      const preReplayFingerprint = companionCallFingerprint(definition.name, argsHash);
      if (companionReplayLimitFor(executedToolName, definition.riskClass) === 0
        && (successfulCallReceipts.get(preReplayFingerprint) ?? 0) > 0) {
        messages.push({ role: "tool", toolCallId: call.id,
          content: JSON.stringify({ ok: true, replay: true,
            summary: "这个操作本轮已经执行成功，直接用上一条回执的结果；不要重复执行。",
            operation: executedToolName }) });
        malformedTools.add(definition.name);
        continue;
      }
      if (executedToolName === "web.search") webSearchCalls++;
      const run = await runCompanionToolExecution({
        event,
        definition,
        operationCallId,
        toolCallId: call.id,
        arguments: parsedArgs.data,
        deadlineAt,
        signal: args.ctx.signal,
        runId: args.read.runId,
        logger,
      });
      if (run.kind === "failure") {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ ok: false, status: run.modelStatus, error: run.safeSummary }),
        });
        // A rejected execution is an invalid tool call too. Without this the
        // same blocked or failed call could be retried forever because only
        // successful receipts feed the identical-call guard.
        if (invalidToolCallLimitReached()) {
          return { kind: "settled", result: await settleInvalidToolLoop(stepId, result) };
        }
        continue;
      }
      if (run.kind === "waiting") {
        waitForConfirmation(run.proposalId, calls, callIndex);
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch() });
        return { kind: "settled", result: { status: "waiting_for_confirmation", proposalId: run.proposalId, memoryRefs: [] } };
      }
      // 同一个「工具名 + 参数」本轮已交付过成功回执，这次又是原样调用=原地重放。
      // For an action, do not execute it again: answer with the prior receipt so
      // the visible artifact stays single and the model can finish. Only a
      // repeated replay without finishing is a real loop.
      const replayFingerprint = companionCallFingerprint(definition.name, argsHash);
      const replayLimit = companionReplayLimitFor(executedToolName, definition.riskClass);
      if (companionReplayExhausted(successfulCallReceipts, replayFingerprint, replayLimit)) {
        const replays = (actionReplayCounts.get(replayFingerprint) ?? 0) + 1;
        actionReplayCounts.set(replayFingerprint, replays);
        if (replays > COMPANION_ACTION_REPLAY_RETRIES_ALLOWED) {
          await finishStep(event, stepId, "failed", undefined, "REPEATED_IDENTICAL_TOOL_CALL");
          await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
          throw new AgentOutputError("no_progress", "companion repeated an identical tool call after its successful receipt");
        }
        messages.push({ role: "tool", toolCallId: call.id,
          content: JSON.stringify({ ok: true, replay: true,
            summary: "这个操作本轮已经执行成功，直接用上一条回执的结果；不要重复执行。",
            operation: executedToolName }) });
        malformedTools.add(definition.name);
        continue;
      }
      const execution = run.execution;
      messages = companionMessagesAfterToolProgress(messages, visibleSegments);
      actionSteerAttempts = 0;
      lookupClaimSteered = false;
      if (executedToolName === "web.search" && (execution.value as { status?: string })?.status === "unavailable") {
        event.constraints.webSearchEnabled = false;
      }
      await recoverCompanionRunFailureSpanBestEffort({
        workspaceId: args.ctx.workspaceId,
        userId: args.read.userId,
        runId: args.read.runId,
      }, "tool");
      for (const block of companionExecutionBlocks(execution, { runId: args.read.runId, toolName: definition.name,
        fallbackLabel: companionToolLabel(definition.name) ?? "查看结果" })) pushRichBlock(block);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        // Read tools budget and paginate their data before serialization. Cutting
        // an encoded envelope corrupts escapes/cursors; the next complete request
        // is governed by its actual token budget instead.
        content: JSON.stringify({ ok: true, receiptId: call.id, operation: executedToolName, data: execution.value, summary: execution.safeSummary }),
      });
    }
    const closing = judgeCompanionStepClosing({
      calls, messages, initiative: Boolean(args.read.initiativeInput), writingAnnotation,
      actionReceiptMissing: userAskedForAction && requestedActionTools.length > 0
        && !companionActionResultRecorded(messages, requestedActionTools),
    });
    if (closing.settleAs === "annotation") {
      // The independent artifact is already delivered. Optional speech failure cannot turn it into another generation loop.
      const completedResult = { status: "completed" as const, text: utterancePublished ? "" : said.trim(), blocks: richBlocks, memoryRefs: [], writesLanded: landedWrites,
        ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
      await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)), undefined, completedResult);
      return { kind: "settled", result: completedResult };
    }
    if (closing.settleAs === "silent") {
      const completedResult = { status: "completed" as const, text: "", blocks: richBlocks, memoryRefs: [] };
      await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)), undefined, completedResult);
      return { kind: "settled", result: completedResult };
    }
    await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)));
    await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(), ...args.contextReceipts?.runMetaPatch() });
    return { kind: "continue" };
    },
  });
}

import {
  type AgentEventContext,
  readLatestPageContextRow,
} from "../tools/companion-read-tools.ts";

export type { AgentEventContext };
export { readLatestPageContextRow };

// 步进规划族已搬到 companion-step-plan.ts（B2）。纯搬运：判据、上限、类型一字未改。
import {
  buildCompanionStepCorrectionInstruction,
  companionActionNotExecutedFallback,
  companionActionResultRecorded,
  companionCurrentToolSuccesses,
  companionEmptyReplyFallback,
  companionMaterialReadFallback,
  companionReminderReadFallback,
  companionNoteEditRoutingMessages,
  companionStepCorrectionMessages,
  companionMessagesAfterToolProgress,
  actionSteerBudget,
  companionUnbackedActionFallback,
  companionUnverifiedQuoteFallback,
  dropCompanionInternalCorrections,
  companionWriteToolNames,
  reviewCompanionStepCorrection,
  stepHoldChars,
  type CompanionAgentLoopResult,
} from "../turn/companion-step-plan.ts";
import { companionSteerCause, judgeCompanionDeliveryGate } from "./companion-delivery-gates.ts";
import { looksLikeUnfulfilledActionNarration } from "../turn/companion-dialogue-content.ts";

// 事件与步进持久化由 companion-agent-events.ts 承担，也在该模块保存运行态模型恢复点。
import {
  appendAgentEvent,
  finishStep,
  persistStep,
  readRunMeta,
  resolveAgentStepCountForResume,
  updateRunMeta,
} from "./companion-agent-events.ts";
