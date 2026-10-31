import { textOfCompanionBlocks } from "../turn/companion-dialogue-content.ts";
import { companionCallFingerprint, companionMalformedToolExhausted, companionReplayExhausted, companionReplayLimitFor,
  COMPANION_ACTION_REPLAY_RETRIES_ALLOWED,
  COMPANION_INVALID_TOOL_CALLS_ALLOWED, COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED,
  COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED } from "./companion-progress-guard.ts";
import { reviewCompanionInitiativeSpeech } from "../proactive/companion-initiative-speech-review.ts";
import { sql } from "drizzle-orm";
import { agentTurnInterpretationV1Schema, AGENT_GOAL_EVIDENCE_GUIDANCE_V1 } from "@astella/shared/agent-contracts";
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
  companionOperationName,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  type CompanionAgentToolStatus,
  type CompanionContentBlockV1,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

import { createCompanionEntrySettlement } from "../turn/companion-entry-settlement.ts";
import { resolveCompanionEntryMode,
  createCompanionDirectControls, companionDirectGuidance } from "../turn/companion-entry-mode.ts";
import { companionActionProgressLabel } from "./companion-action-progress.ts";
import { companionResponseStrategy } from "../turn/companion-response-strategy.ts";
import { companionStepReasoning, COMPANION_CASUAL_TURN_GUIDANCE } from "../turn/companion-turn-workload.ts";
import { createCompanionMessageDelivery, requestedIndependentMessageCount } from "../turn/companion-message-delivery.ts";
import { CompanionToolNotExecutedError } from "../tools/companion-tool-outcome.ts";
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
import type { AIProvider } from "../../lib/ai-provider.ts";
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
import {
  emitCompanionAssistantStatus,
  recoverCompanionRunFailureSpanBestEffort,
} from "../turn/companion-dialogue-store.ts";
import { settleCompanionTurnPreamble } from "../turn/companion-turn-preamble.ts";
import { createCompanionStepCompaction } from "../context/companion-step-compaction.ts";
import { looksTruncatedReply, companionStepOutputCeiling, containsCompanionInternalToken } from "../turn/companion-dialogue-content.ts";
import { runCompanionToolExecution } from "../tools/companion-tool-execution-run.ts";
import { CompanionToolPreparation } from "../tools/companion-tool-preparation.ts";
import { companionExecutionPolicy } from "./companion-execution-policy.ts";
import { repairDegenerateCompanionAnswer } from "./companion-answer-repair.ts";
import { assembleCompanionStepRequest, companionStepPolicyText, companionStepToolSurface } from "./companion-agent-step-assembly.ts";
import { companionInitiativeInterpretationFields } from "../proactive/companion-initiative-observation.ts";
import { createdNoteToolResult, readCreatedNoteReceipt } from "../note/companion-note-authoring.ts";
import { canRetryCompanionStream, runStreamingAgentStep, CompanionSpeculativeStepDiscardedError } from "./companion-agent-streaming-step.ts";
import { recoverCompanionStreamFailure } from "./companion-stream-recovery.ts";
import { executeWatchedCompanionTurn, CompanionOutputTimeoutError, companionOutputWatchdogPolicy } from "./companion-output-watchdog.ts";
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
import { validateCompanionFinish, companionFinishRepeatsPublished, companionLatestDeliveryDraft, type CompanionFinishArguments } from "./companion-finish.ts";
import { withCompanionReceiptReferences } from "../tools/companion-tool-receipts.ts";
import { companionExecutionBlocks } from "./companion-tool-output.ts";
import { companionProviderFitsRequest } from "./companion-provider-fit.ts";
import { judgeCompanionStepClosing, waitingConfirmationReceipts } from "../turn/companion-step-closing.ts";
import { companionRecoveryIdentity, openCompanionTurn } from "../turn/companion-turn-opening.ts";
import { judgeCompanionUnavailableTool } from "../tools/companion-unavailable-tool.ts";
import { resumeCompanionInterruptedInput } from "./companion-resume-input.ts";
import { companionToolAuditLabel, rejectUnknownCompanionTool, unofferedToolReceipt, validateCompanionToolCall } from "../tools/companion-tool-call-validation.ts";
import { companionTurnMessagesWithImages, loadCompanionAttachmentImages } from "./companion-attachment-images.ts";
import { prepareCompanionImageBatches, parseCompanionImageBatch, hedgeCompanionBatch, COMPANION_IMAGE_BATCH_OPTIONS } from "./companion-image-batches.ts";
import { runWorkerAiTask } from "../note/worker-ai-task.ts";
import { applyCompanionToolLoad, createCompanionToolSurface } from "../tools/companion-tool-surface.ts";

export async function runCompanionAgentLoop(args: CompanionAgentLoopArgs): Promise<CompanionAgentLoopResult> {
  if (typeof args.provider.executeAgentTurn !== "function") {
    throw new Error("provider does not support companion agent turns");
  }
  let utterancePublished = false;
  const publishedUtteranceTexts: string[] = [];
  // The user's stated count, if any, becomes the delivery contract: the tool
  // description already promises to honour it, so the host must check it too.
  const messageDelivery = createCompanionMessageDelivery(
    args.read.initiativeInput ? null : requestedIndependentMessageCount(args.read.userText));
  const event: AgentEventContext = {
    ctx: args.ctx,
    read: args.read,
    expiresAt: args.expiresAt,
    constraints: args.toolConstraints,
    flushThinking: args.flushThinking,
    onUtterancePublished: async (...published) => {
      utterancePublished = true;
      const spoken = published[1];
      if (typeof spoken === "string" && spoken.trim()) publishedUtteranceTexts.push(spoken);
      messageDelivery.record(published[0]);
      await args.onUtterancePublished?.(...published);
    },
  };
  const attemptStartedAt = Date.now();
  const meta = await readRunMeta(event);
  if (meta.stepCount > 0) {
    const published = await withWorkerWorkspaceTransaction({ workspaceId: args.ctx.workspaceId, userId: args.read.userId },
      tx => tx.execute<{ message_id: string; blocks: unknown }>(sql`SELECT u.message_id,m.blocks FROM companion_run_utterances u
        JOIN companion_messages m ON m.id=u.message_id WHERE u.run_id=${args.read.runId} ORDER BY m.seq`));
    for (const row of published) {
      messageDelivery.record(row.message_id);
      publishedUtteranceTexts.push(textOfCompanionBlocks(row.blocks));
    }
    utterancePublished = published.length > 0;
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
    noteLibraryReadEnabled: event.constraints.noteLibraryReadEnabled !== false,
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
  // The semantic entry is settled once, then cached in the run metadata.
  const opening = openCompanionTurn(args);
  const dialogueHistory = opening.dialogueHistory;
  const currentRequest = opening.currentRequest;
  let messages = opening.messages;
  // Keep asset identities in checkpoints. Inline bytes belong only to a model
  // request; persisting a base64 copy on every step inflates image conversations.
  const imageCache = new Map<string, Awaited<ReturnType<typeof loadCompanionAttachmentImages>>[number] | null>();
  const imageBatchCache: Parameters<typeof prepareCompanionImageBatches>[0]["cache"] = new Map();
  const imageReadCache = new Map<string, { question: string; description: string; uncertainties: string[] }>();
  event.imageReadCache = imageReadCache;
  const loadTurnImages: typeof loadCompanionAttachmentImages = async input => {
    const missing = input.attachments.filter(ref => !imageCache.has(ref.assetId));
    if (missing.length) {
      const loaded = await loadCompanionAttachmentImages({ ...input, attachments: missing });
      for (const ref of missing) imageCache.set(ref.assetId, null);
      for (const image of loaded) imageCache.set(image.assetId, image);
    }
    return input.attachments.flatMap(ref => { const image = imageCache.get(ref.assetId); return image ? [image] : []; });
  };
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
  const entry = createCompanionEntrySettlement({ args, event, mode: entryMode, requestHash: attentionRequestHash,
    cached: cachedInterpretation, messages, writingAnnotation, recovered: Boolean(recovered),
    requiresGrounding: writingAnnotation || completeNoteReply || Boolean(args.read.initiativeInput
      || args.read.userImageAttachments?.length || args.continuationProposalId || currentRequest.hostObservation) });
  const attention = entry.attention;
  if (!entry.speculative) await entry.settle();
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
    historyBinding, userRequiresTool, userAskedForAction, definitions,
    requestedActionTools,
  } = preamble;
  const directControls = createCompanionDirectControls({ mode: entryMode, attention,
    userText: args.read.userText, imageTurn: Boolean(args.turnImagesSentDirectly || args.read.userImageAttachments?.length),
    deepened: recovered?.state.deepened, onInterpretation: args.onTurnInterpretation });
  if (definitions.length === 0)
    throw new Error(`companion tool surface resolved empty for permission "${String(meta.permissionLevel)}"`);
  /** Actions decide the delivery contract: a landed write or a pending
   * independent message still needs a finish that cites it. A turn that only
   * read material has nothing to cite and can deliver its prose directly. */
  const companionWriteNames = companionWriteToolNames(definitions);
  /**
   * Every turn that could produce work must declare its outcome through
   * `companion_finish`; prose alone cannot settle it. The signal is the tool
   * surface, not the wording: if this turn was offered a tool that changes
   * state or produces an artifact, "I did it" has to cite that tool's receipt.
   * A read-only or greeting turn has nothing to cite and still answers in
   * prose, so plain conversation keeps its single round trip.
   */
  /** Actions decide the delivery contract: a landed write or a pending
   * independent message needs a finish that cites it. Whether prose may settle
   * a work-capable turn is decided at settlement, where the tool surface and
   * this run's receipts are both known. */
  const companionDeliveryContractRequired = () => companionActionResultRecorded(messages, companionWriteNames)
    || messageDelivery.incomplete();

  // Reading is a model tool decision. Page identity remains in context; the
  // host never selects library notes from words in the current sentence.
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


  /** The opening preference sets presence feedback. Each step below can raise
   * effort for tool evidence, repair, or explicit deepening. */
  const disableThinking = entry.speculative || directControls.disableThinking();
  // 这是调用意图，不是上游实际消耗：不支持 none 的模型仍使用最低思考档。
  logger.info({ runId: args.read.runId, requestedDisableThinking: disableThinking,
    providerId: args.provider.id, modelId: args.provider.modelId, basis: `entry:${entryMode}` },
    "companion turn thinking preference resolved; provider applies declared levels");
  // 先显示可观察的工作状态，不把模型内部思维链当作 UI 内容。明确动作轮用任务状态
  // 取代泛化的「正在思考」；status 事件与 assistant.delta/TTS 分开。
  const actionProgressLabel = companionActionProgressLabel(attention, requestedActionTools);
  if (actionProgressLabel) {
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
   * A published message is a message even when the same step also wrote prose.
   *
   * This used to reject the call outright, to stop one reply being said twice.
   * The rejection assumed the model would retry through the speech channel from
   * the first sentence; what actually happens (mimo, 2026-10-28) is that the
   * model drafts the whole answer as prose, publishes message one, gets refused,
   * and the turn closes on the prose — one bubble with "第二条：" inside it.
   * The record-level dedupe (same content hash, same sentence) already prevents
   * a literal repeat, so publish is allowed and the prose stays a draft: the
   * client drops it once the published messages exist.
   */
  event.verifyUtterance = () => {
    if (messageDelivery.full()) throw new CompanionToolNotExecutedError("用户指定的消息数量已发完，不再追加额外气泡。请继续完成其他要求或结束本轮。");
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
  /** Successful action replay is tracked independently of model prose. */
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
  const finishBoundary = (stepId: string, status: "succeeded" | "failed" | "cancelled", hash: string | undefined,
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
    const speculativeStep = entry.speculative && stepCount === 1 && !attention.resourceDecision;
    if (!speculativeStep) await entry.settle();
    // 不再有"最后一步"（2026-10-16：不要用预算的方式兜底）。旧写法走到配置的步数
    // 上限就抽走工具面逼她作答——那是用计数决定她说什么。纯函数那一侧仍接受这个
    // 入参供探针渲染文案，运行时永远传 false。
    const finalAnswerOnly = false;
    messages = withCompanionReceiptReferences(messages, compactedEvidence);
    const currentSuccesses = companionCurrentToolSuccesses(messages);
    const actionReceiptReady = requestedActionTools.length > 0
      && requestedActionTools.every(name => currentSuccesses.some(tool => tool.name === name));
    // 工具面、执行政策与请求装配这三样的判据在 `companion-agent-step-assembly.ts`。
    const { tools: toolsOfferedThisStep, toolChoice: toolChoiceThisStep } = companionStepToolSurface({
      toolDefinitions: offeredToolDefinitions().filter(tool => !malformedTools.has(tool.name))
        .filter(tool => tool.name !== "companion_deepen"
          || (entryMode === "direct_fast" && !directControls.deepened())),
      finalAnswerOnly,
      requiresTool: userRequiresTool || messageDelivery.incomplete(),
      toolCallCount: messageDelivery.incomplete() ? 0 : toolCallCount,
      requireStructuredResponse: !speculativeStep && companionDeliveryContractRequired(),
      deliveryDraftAvailable: args.read.initiativeInput ? undefined : companionLatestDeliveryDraft(messages) !== null,
    });
    const runtimePolicy = companionStepPolicyText({
      permissionLevel: currentMeta.permissionLevel,
      toolCount: toolsOfferedThisStep.length,
      stepBudget,
      finalAnswerOnly,
      attentionIntent: speculativeStep || entry.workload === "casual" ? "conversation" : attention.intent,
      requestSource: currentRequest.hostObservation ? "host_observation" : "user",
      offeredToolNames: toolsOfferedThisStep.map((tool) => tool.name),
      writingAnnotation,
      completeNoteReply,
    });
    const stepReasoningEffort = companionStepReasoning({ mode: entryMode, resourcePath: speculativeStep || entry.workload === "casual" ? "chat" : "work",
      deepened: directControls.deepened(), repairing: actionSteerAttempts > 0,
      readOnlyRequiredStep: false, toolCallCount });
    const casualStep = (speculativeStep || entry.workload === "casual") && stepReasoningEffort === "none";
    const outputWatchdogPolicy = (provider: AIProvider) => companionOutputWatchdogPolicy(
      casualStep ? "casual" : "adaptive", provider === args.provider ? "primary" : "recovery");
    const responseStrategy = companionResponseStrategy(casualStep ? { intent: "conversation", toolUse: "none" } : attention);
    // Image delivery follows the host's capability/data policy. A fast text
    // follow-up still needs its historical originals on their source turns.
    const imageMessages = await companionTurnMessagesWithImages({
      args, messages }, loadTurnImages);
    const providerMessages = await prepareCompanionImageBatches({ messages: imageMessages,
      userText: args.read.userText, signal: args.ctx.signal, cache: imageBatchCache,
      onImage: image => imageReadCache.set(image.assetId, { question: args.read.userText,
        description: image.description, uncertainties: image.uncertainties }),
      runBatch: batch => runWorkerAiTask({ job: args.ctx, userId: args.read.userId,
        taskId: "companion_image_batch", taskVersion: 1,
        idempotencyKey: `companion-image-batch:${args.read.runId}:${batch.key}`,
        inputSnapshotRef: { kind: "task", id: `${args.read.runId}:image-batch`, hash: batch.key },
        input: batch.messages, modelId: args.provider.modelId,
        promptVersion: `${args.provider.promptVersion}:companion-image-batch-v1`, resourceClass: "interactive_ai",
        timeoutMs: Math.min(resolveProviderCallTimeout("companion_agent"), deadlineAt - Date.now()),
        execute: async (batchMessages, signal) => {
          const result = await hedgeCompanionBatch(
            async batchSignal => {
              const response = await args.provider.chatCompletion(batchMessages, COMPANION_IMAGE_BATCH_OPTIONS, batchSignal);
              parseCompanionImageBatch(response.content, batch.assetIds);
              return response;
            },
            { signal });
          return { ok: true, output: result.content, promptTokens: result.usage?.promptTokens ?? undefined,
            completionTokens: result.usage?.completionTokens ?? undefined };
        },
      }),
    });
    let stepRequest: AgentTurnRequest = assembleCompanionStepRequest({
      turnPolicy: typeof args.baseMessages[0]?.content === "string" ? args.baseMessages[0].content : "",
      runtimePolicy,
      executionGuidance: [companionDeliveryContractRequired()
        ? "本轮已有真实写回执或待发独立消息；最终用 companion_finish 交付，引用真实回执并核对当前请求。本步可同时给出完整正文并调用 finish、省略 text，不先另发草稿再重写。" : "",
        responseStrategy.guidance, companionExecutionConstraintGuidance(attention),
        casualStep ? COMPANION_CASUAL_TURN_GUIDANCE : companionDirectGuidance(entryMode),
        args.turnImagesSentDirectly ? "宿主已实际随本次输入提供的原图或分批视觉结果可以直接用于回答，无需为证明看过再逐张调用工具。对这些当前输入的解释可以直接回答；尚未提供的库内材料仍需真实读取回执。看不清的内容保留不确定，不根据旧答案补全。" : "",
        messageDelivery.guidance()].filter(Boolean).join("\n"),
      attention,
      currentUserText: currentRequest.hostObservation ? undefined : args.read.userText,
      messages: providerMessages,
      tools: toolsOfferedThisStep,
      toolChoice: toolChoiceThisStep,
      disableThinking: stepReasoningEffort === "none",
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
      if (fallbackFits) { stepProvider = args.fallbackProvider; protocolFallback = true; }
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
              (taskSignal) => executeWatchedCompanionTurn(provider, folded, taskSignal, outputWatchdogPolicy(provider)),
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
      const deliveryContractRequired = companionDeliveryContractRequired();
      const canStreamThisStep = !deliveryContractRequired && Boolean(args.onProviderDelta)
        && !resumingInput
        && !utterancePublished
        && typeof stepProvider.chatCompletionStream === "function"
        && (finalAnswerOnly || stepRequest.tools.length === 0 || stepProvider.chatCompletionStreamToolCalls === true);
      // A decision may settle during checkpoint I/O. Never run the speculative
      // request through an ungated buffered/fallback path in that race.
      if (speculativeStep && !canStreamThisStep) throw new CompanionSpeculativeStepDiscardedError();
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
        // Ordinary replies stream directly. Required execution/finish steps
        // retain their buffered delivery contract and actual receipt checks.
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
              outputWatchdogPolicy: outputWatchdogPolicy(stepProvider),
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
              // Resource routing never exempts a body, including a speculative
              // chat draft or the preamble before the first tool executes.
              deferPublication: stepRequest.toolChoice === "required",
              onToolCallStarted: preparation.observe,
              ...(speculativeStep ? { releaseGate: async () => (await entry.settle()).resourceDecision?.path === "chat" } : {}),
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
          if (speculativeStep && ((await entry.settle()).resourceDecision?.path !== "chat"
            || error instanceof CompanionSpeculativeStepDiscardedError)) throw new CompanionSpeculativeStepDiscardedError();
          result = await recoverCompanionStreamFailure({
            error, runBuffered, attemptStream, canRetryStream,
            stepProvider, fallbackProvider: args.fallbackProvider,
            fitsFallback: async () => args.fallbackProvider !== undefined
              && await companionProviderFitsRequest(args.fallbackProvider, stepRequest),
            useFallback: provider => { stepProvider = provider; stepCompaction.setProvider(provider); protocolFallback = true; },
            stepCount, runId: args.read.runId,
          });
        }
      } else {
        result = await runBuffered();
      }
      if (containsCompanionToolProtocol(String(result.content ?? "")))
        throw new CompanionToolOutputRepairError("", String(result.content ?? ""));
      if (containsCompanionInternalToken(String(result.content ?? "")))
        throw new CompanionToolOutputRepairError("", String(result.content ?? ""), "internal_token_leak");
      await preparation.finish(result.toolCalls ?? []);
      await entry.settle();
    } catch (error) {
      await preparation.finish([]).catch(preparationError => logger.warn(
        { runId: args.read.runId, err: preparationError }, "companion tool preparation could not be settled"));
      if (error instanceof CompanionSpeculativeStepDiscardedError && !stepEmitted && !args.ctx.signal.aborted) {
        await entry.settle();
        await finishBoundary(stepId, "cancelled", undefined, "SPECULATIVE_DRAFT_DISCARDED");
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
        return { kind: "continue" };
      }
      // A landed write outlives a transport failure; do not bury it in an error card.
      const landed = args.ctx.signal.aborted ? null : settleCompanionLandedWritesOnFailure({ messages, currentRunEvidence: compactedEvidence,
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
          ? "PROVIDER_FIRST_OUTPUT_TIMEOUT" : error.code === "provider_progress_timeout" ? "PROVIDER_PROGRESS_TIMEOUT" : "PROVIDER_IDLE_TIMEOUT");
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
            : outputRepair.code === "internal_token_leak" ? "上一版把内部上下文字段或标识写进了正文，未通过交付校验。"
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
    let calls: NonNullable<AgentTurnResult["toolCalls"]> = result.toolCalls ?? [];
    if (calls.length === 0 && messageDelivery.incomplete()) {
      if (actionSteerAttempts >= COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED)
        throw new AgentOutputError("action_unverified", "requested independent messages were not delivered");
      actionSteerAttempts += 1;
      steerSwapToFallback = true;
      messages = dropCompanionInternalCorrections(messages);
      messages.push(...companionStepCorrectionMessages({ currentRequest, alreadyDisplayed: stepEmitted,
        instruction: messageDelivery.guidance() }));
      await finishBoundary(stepId, "failed", auditHash(result), "ACTION_NOT_EXECUTED");
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
      return { kind: "continue" };
    }
    if (!companionDeliveryContractRequired() && calls.length === 0 && (utterancePublished || !String(result.content ?? "").trim())) {
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
      const prefix = stepEmitted && typeof result.content === "string" ? result.content : "";
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
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      logger.warn({ runId: args.read.runId, stepCount }, truncated.bypassNote);
      return { kind: "settled", result: truncatedResult };
    }
    // The host validates structured execution facts, not words in the reply.
    // Task meaning belongs to the model; prose cannot create an operation.
    const said: string = String(result.content ?? "").trim() ? String(result.content ?? "") : stepVisibleText;
    const saidHash = sha256Utf8V1(said);
    // Actions shape the delivery contract: once a write landed or an independent
    // message is still pending, prose alone cannot settle the turn. A turn whose
    // only work was reading/preparing material has nothing to cite, so its
    // answer is the delivery. The old rule used the work decision itself and
    // spent an extra finish round trip on every read-and-tell turn.
    if (calls.length === 0 && (landedWrites || messageDelivery.incomplete())) {
      if (actionSteerAttempts++ >= COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED) {
        return { kind: "settled", result: await settleWithHostNote({ stepId, said, saidHash,
          errorCode: "FINISH_CONTRACT_INCOMPLETE", includeSaid: false, landedWrites, reasoning: result.reasoning,
          note: "这次还没有核对完全部要求；已执行的部分保留，不能确认整件事完成。" }) };
      }
      // MiMo's wire protocol only supports automatic tool choice. A missing
      // delivery contract must not spend every repair on that same route;
      // the configured fallback can complete the unchanged goal and receipts.
      steerSwapToFallback = true;
      messages = companionDeliveryRepairMessages({ messages, result, currentRequest, alreadyDisplayed: stepEmitted,
        instruction: "你刚才给出了完整草稿，尚未提交交付工具。核对当前请求各项及真实回执；草稿准确且目标已覆盖时，调用 companion_finish 并省略 text，宿主会精确保留原稿，不必重新抄写。仍提供 outcome 和 requirements。" + AGENT_GOAL_EVIDENCE_GUIDANCE_V1 + "需要修正正文时用 text 提供修正版；缺少依据时继续处理，不能将未完成标为完成。已经成功的操作不要重做；独立消息已发布时不额外确认。" });
      await finishBoundary(stepId, "failed", saidHash, "FINISH_CONTRACT_INCOMPLETE");
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
      return { kind: "continue" };
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
      // Prose cannot settle a turn that had work-capable tools: the model must
      // declare an outcome through `companion_finish`, where a "completed"
      // requirement has to cite a receipt from this run. Without this, "图已经
      // 画好了" with no diagram, or "没有提醒能力" while the tool is offered,
      // reaches the user as fact. Reads-only and greeting turns cite nothing,
      // so their finish validates on the first try and no wording is inspected.
      const workCapableOffered = definitions
        .some(tool => tool.riskClass !== "read" || DELIVERABLE_READ_TOOL_NAMES.has(tool.name));
      const finishSettled = messages.some(message => message.role === "tool"
        && message.toolCalls?.some(call => call.name === "companion_finish"));
      if (workCapableOffered && !finishSettled && !args.read.initiativeInput) {
        if (actionSteerAttempts++ < COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED) {
          steerSwapToFallback = true;
          messages = companionDeliveryRepairMessages({ messages, currentRequest, alreadyDisplayed: stepEmitted,
            result: { content: String(result.content ?? "") },
            instruction: "交付前先调用 companion_finish 声明本轮结果：outcome 说明整体是否完成，requirements 逐条对照用户要求；"
              + "标为 fulfilled 的条目必须引用本轮真实成功的工具回执 id，本轮没有做过的事不要标成完成，也不要在正文里声称已经做了。"
              + AGENT_GOAL_EVIDENCE_GUIDANCE_V1 + "草稿正确时省略 text，宿主保留原稿。" });
          await finishBoundary(stepId, "failed", sha256Utf8V1(String(result.content ?? "")), "FINISH_CONTRACT_INCOMPLETE");
          await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
          logger.warn({ runId: args.read.runId, stepCount }, "prose tried to settle a work-capable turn; required a finish contract");
          return { kind: "continue" };
        }
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
      // A reply that only carries an expression tag is empty, not delivered.
      // 2026-10-29 production: `[neutral]` alone settled a turn silently and the
      // next request inherited the unanswered task.
      if (stripVoiceExpressionTags(text).trim().length === 0) {
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
      // Multiple identities stay ambiguous even when one text contains another:
      // an exception or extra condition can change the intended deletion target.
      if (companionOperationName({ name: identity.name, arguments: parsedArgs.data }) === "memory.write.forget"
        && !parsedArgs.data.memoryId && typeof parsedArgs.data.query === "string") {
        const scope = { workspaceId: args.ctx.workspaceId, userId: args.read.userId };
        const found = await withWorkerWorkspaceTransaction(scope, tx =>
          retrieveCompanionMemoriesKeyword(tx, scope, String(parsedArgs.data.query), 6, null, { budgetTier: "active" }));
        const target = found.items.length === 1 ? found.items[0] : undefined;
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
        if (messageDelivery.incomplete()) {
          messages.push({ role: "tool", toolCallId: call.id,
            content: JSON.stringify({ ok: false, status: "not_executed", error: messageDelivery.guidance() }) });
          steerSwapToFallback = true;
          if (actionSteerAttempts++ >= COMPANION_UNBACKED_CLAIM_RETRIES_ALLOWED)
            throw new AgentOutputError("action_unverified", "requested independent messages were not delivered");
          continue;
        }
        if (calls.length !== 1) {
          messages.push({ role: "tool", toolCallId: call.id,
            content: JSON.stringify({ ok: false, status: "not_executed",
              error: "companion_finish 必须单独调用：先完成本轮工具调用，再单独交付最终回答。" }) });
          continue;
        }
        const verdict = validateCompanionFinish(parsedArgs.data as CompanionFinishArguments, messages,
          { requireRequirements: companionActionResultRecorded(messages, companionWriteNames),
            allowSilent: Boolean(args.read.initiativeInput) && !stepEmitted && !visibleSegments.length
              && !utterancePublished && !String(result.content ?? "").trim(),
            currentRunEvidence: compactedEvidence });
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
        const assembledFinishText = assembleCompanionFinishText({ visibleSegments, visibleSegmentDelivered,
          utterancePublished, finishText: verdict.text });
        // Delivering the same words a second time adds a duplicate bubble; the
        // explicit channel already carried them. New or corrected text still delivers.
        const finishText = companionFinishRepeatsPublished(assembledFinishText, publishedUtteranceTexts) ? "" : assembledFinishText;
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
        content: JSON.stringify({ ok: true, receiptId: call.id, operation: executedToolName, data: execution.value, summary: execution.safeSummary,
          // A step's prose is a draft, not a delivered message. When the model
          // drafts the whole reply and then publishes part of it, the remainder
          // would be lost: the client drops the draft as soon as a published
          // message exists. The receipt says both halves — the draft is not
          // visible, and a published message needs no spoken confirmation.
          ...(executedToolName === "say.publish"
            ? { note: "这条已经发给用户看到了。还有内容要发就继续调用本工具，每次一条；全部说完就结束。没通过本工具发出的正文不会出现在对话里，收尾也不用汇报已经发了什么。" + messageDelivery.guidance() } : {}) }),
      });
    }
    const closing = judgeCompanionStepClosing({
      calls, messages, initiative: Boolean(args.read.initiativeInput), writingAnnotation,
      // A work turn cannot end on a bare published line: the model may have
      // only said the first of several messages. Prose-only answers still
      // settle directly; this gate is about ending right after a say.publish.
      actionReceiptMissing: messageDelivery.incomplete() || (userAskedForAction && requestedActionTools.length > 0
        && !companionActionResultRecorded(messages, requestedActionTools)),
    });
    if (closing.settleAs === "annotation") {
      // The independent artifact is already delivered. Optional speech failure cannot turn it into another generation loop.
      const completedResult = { status: "completed" as const, text: utterancePublished ? "" : said.trim(), blocks: richBlocks, memoryRefs: [], writesLanded: landedWrites,
        ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
      await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)), undefined, completedResult);
      // Terminal settlements still account for the step and its calls; the run
      // receipt must not read as zero work because the artifact closed early.
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      return { kind: "settled", result: completedResult };
    }
    if (closing.settleAs === "silent") {
      const completedResult = { status: "completed" as const, text: "", blocks: richBlocks, memoryRefs: [] };
      await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)), undefined, completedResult);
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
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
  companionActionNotExecutedFallback,
  companionActionResultRecorded,
  companionCurrentToolSuccesses,
  companionEmptyReplyFallback,

  companionStepCorrectionMessages,
  companionDeliveryRepairMessages,
  companionMessagesAfterToolProgress,
  dropCompanionInternalCorrections,
  companionWriteToolNames,
  stepHoldChars,
  type CompanionAgentLoopResult,
} from "../turn/companion-step-plan.ts";
import { judgeCompanionDeliveryGate } from "./companion-delivery-gates.ts";

// 事件与步进持久化由 companion-agent-events.ts 承担，也在该模块保存运行态模型恢复点。
import {
  appendAgentEvent,
  finishStep,
  persistStep,
  readRunMeta,
  resolveAgentStepCountForResume,
  updateRunMeta,
} from "./companion-agent-events.ts";/** Reads that still produce something the user asked to see. A diagram turn
 * settles through the finish contract like a write, because telling the user a
 * chart exists is a delivery claim. */
const DELIVERABLE_READ_TOOL_NAMES = new Set(["companion_visual", "companion_goals_write"]);


