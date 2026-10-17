import { CompanionToolNotExecutedError } from "./companion-tool-result.ts";
import { companionCallFingerprint, companionReplayExhausted } from "./companion-progress-guard.ts";
import { isCompanionParticipationClosure } from "./companion-participation-output.ts";
import { sql } from "drizzle-orm";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
import { companionEditedNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import type { CompanionAgentLoopArgs } from "../contracts/companion-agent-loop.ts";
import { executeTurn } from "@astella/agent-core";
import { measureAgentTurnRequest, resolveContextBudget } from "@astella/agent-core";
import {
  auditHash,
  boundedToolCallIdentity,
  ensureAgentToolCall,
  executeCompanionAgentTurnWithToolChoiceFallback,
  loadContinuation,
  recordRejectedToolCall,
  safeArgumentsHash,
  updateToolCall,
} from "./companion-tool-call-ledger.ts";
import {
  COMPANION_AGENT_TOOL_LABELS,
  allowedMainRouteV2Schema,
  companionCapabilityOfferedInHostContext,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  resolveCompanionInitialToolNames,
  resolveCompanionToolGroupNames,
  validateCompanionAgentToolArguments,
  type CompanionAgentToolStatus,
  type CompanionContentBlockV1,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

import { COMPANION_TOOL_INTENT_TIMEOUT_MS, interpretCompanionTurn } from "./companion-tool-intent.ts";
import { createCompanionRouteRecorder } from "./companion-route-record.ts";
import { companionAttentionObjects } from "./companion-attention.ts";
import { companionTurnThinking } from "./companion-turn-thinking.ts";
import { companionActionProgressLabel } from "./companion-action-progress.ts";
import { companionResponseStrategy } from "./companion-response-strategy.ts";
import { containsCompanionToolProtocol } from "./companion-tool-protocol-output.ts";
import { CompanionToolOutputRepairError } from "./companion-tool-output-repair.ts";
import { companionTimeWakeupConstraint, companionExecutionConstraintGuidance } from "./companion-execution-constraints.ts";
import {
  findDuplicateSegment,
  joinVisibleSegmentsDeduped,
  VISIBLE_SEGMENT_SEPARATOR,
} from "./companion-visible-segments.ts";
import { restoreCompactionCheckpoint } from "./companion-compaction-checkpoint.ts";
import { encodeCompanionRuntimeCheckpoint, loadCompanionRuntimeCheckpoint, saveCompanionRuntimeInput,
  type CompanionRuntimeState } from "./companion-runtime-checkpoint.ts";
import { companionAgentModelInputHash, createCompanionModelStepRunner } from "./companion-agent-task.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import {
  resolveCompanionAgentBudget,
  resolveProviderCallTimeout,
} from "../lib/handler-timeout-config.ts";
import { AgentOutputError, CompanionAgentBudgetExceededError, CompanionContextChangedError } from "../lib/non-retryable-errors.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";
import { currentWorkerWorkspaceTransaction, withWorkerWorkspaceTransaction } from "../db.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import {
  emitCompanionAssistantStatus,
  recoverCompanionRunFailureSpanBestEffort,
} from "./companion-dialogue-store.ts";
import { settleCompanionTurnPreamble } from "./companion-turn-preamble.ts";
import { createCompanionStepCompaction } from "./companion-step-compaction.ts";
import { looksTruncatedReply, companionStepOutputCeiling, sanitizeCompanionVisibleText } from "./companion-dialogue-content.ts";
import { unavailableCompanionToolSummary } from "./companion-tool-outcome.ts";
import { companionNumericEvidenceContext } from "./companion-context-evidence.ts";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";
import { runCompanionToolExecution } from "./companion-tool-execution-run.ts";
import { CompanionToolPreparation } from "./companion-tool-preparation.ts";
import { companionExecutionPolicy } from "./companion-execution-policy.ts";
import { repairDegenerateCompanionAnswer } from "./companion-answer-repair.ts";
import { assembleCompanionStepRequest, companionStepPolicyText, companionStepToolSurface, companionWebSearchAllowedForStep } from "./companion-agent-step-assembly.ts";
import { companionInitiativeInterpretationFields, recentOwnLines, renderCompanionInitiativeObservation } from "./companion-initiative-observation.ts";
import { createdNoteToolResult, readCreatedNoteReceipt, userForbidsNoteLibraryRead } from "./companion-note-authoring.ts";
import {
  EAGER_TOOL_DISPATCH_ENABLED,
  createCompanionEagerScheduler,
} from "./companion-eager-dispatch-config.ts";
import { canRetryCompanionStream, runStreamingAgentStep } from "./companion-agent-streaming-step.ts";
import { CompanionStreamStoppedError } from "./companion-dialogue-stream.ts";
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
} from "./companion-tool-outcome.ts";

import { readCompanionWebSearchReceipts, readWebSearchReceipt, webSearchCitationBlocks, webSearchServiceAvailable } from "../agent/web-search.ts";
import { loadNoteReadPage } from "./companion-read-tools.ts";

type AgentMessage = AgentTurnRequest["messages"][number];

/**
 * Whether a provider's declared context window can take this request.
 * `measureAgentTurnRequest` counts the full serialized request (system,
 * messages and tool schemas) in the same units as the governor.
 */
async function providerFitsRequest(provider: NonNullable<CompanionAgentLoopArgs["fallbackProvider"]>,
  request: AgentTurnRequest): Promise<boolean> {
  const capability = provider.getCapabilities?.();
  if (!capability || !Number.isSafeInteger(capability.contextWindowTokens) || capability.contextWindowTokens <= 0) {
    return true; // Unknown window: keep the previous behaviour rather than refuse.
  }
  try {
    const measured = await measureAgentTurnRequest(request);
    const budget = resolveContextBudget({
      capability,
      requestedOutputTokens: provider.resolveOutputTokenLimit?.() ?? request.maxTokens ?? null,
      outputLimitEnforced: capability.outputLimitEnforced,
    });
    return measured.inputTokens <= budget.hardInputTokens;
  } catch {
    return true;
  }
}

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
  if (deadlineAt <= attemptStartedAt) {
    throw new CompanionAgentBudgetExceededError("companion agent execution budget exhausted");
  }
  let flushedMs = 0;
  /** 本次尝试自上次落库以来新消耗的执行时间（累加到 agent_elapsed_ms）。 */
  const elapsedDelta = (): number => {
    const total = Date.now() - attemptStartedAt;
    const delta = total - flushedMs;
    if (delta <= 0) return 0;
    flushedMs = total;
    return delta;
  };
  // 扁平工具面（方案 29 §4.1）：**不再选技能**。
  //
  // 原来这里 `selectSkill()` 用 triggerHints 子串匹配挑一个技能，工具面 = 它的
  // toolNames；没命中就是空工具面 + 单步。基线实测 90.7% 的轮次一个工具都没有——
  // "读记忆 / 看系统状态 / 跳转页面"不是被她拒绝，而是**根本没出现在她面前**。
  // 每轮给出权限档允许的全部工具，直到当前任务完成。
  // Latest-turn attention is independent of durable goals and historical actions.
  const attentionRequestHash = sha256Utf8V1(args.read.userText);
  const notePage = (args.read.pageContext as { context?: { pageKind?: string; replyPurpose?: string; annotationTarget?: unknown }; selection?: unknown } | null);
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
  const availableDefinitions = resolveAllCompanionAgentTools(meta.permissionLevel, event.constraints)
    .filter(definition => companionCapabilityOfferedInHostContext(definition,
      { writingAnnotation, completeNoteReply, initiative: Boolean(args.read.initiativeInput) }));
  const cachedInterpretation = args.read.initiativeInput ? agentTurnInterpretationV1Schema.parse(
    companionInitiativeInterpretationFields({ requestHash: attentionRequestHash, topic: args.read.initiativeInput.topic }))
    : writingAnnotation ? agentTurnInterpretationV1Schema.parse({
    version: 1, requestHash: attentionRequestHash, intent: "task", toolUse: "act", subjects: [],
    goalRelation: "new", goalReference: null, candidateOperations: ["companion_write_annotation"], ambiguities: [], status: "interpreted",
  }) : meta.turnInterpretation?.requestHash === attentionRequestHash ? meta.turnInterpretation : null;
  /**
   * 分类器**不等**——它和"闲聊版第一步"并行跑（2026-10-07 用户决定：首字延迟里
   * 最大的一块就是这次串行往返，实测 1.9–2.4s，而且不产出任何可见内容）。
   */
  const routeRecorder = createCompanionRouteRecorder({ scopeKey: `${args.ctx.workspaceId}:${args.read.userId}`, userText: args.read.userText, recentMessages: args.read.recentMessages, embedText: args.embedText, activeLearningTask: args.read.groundedTutorContext !== null || args.read.formalAnswerInProgress });
  const attentionResult = cachedInterpretation
    ? Promise.resolve(cachedInterpretation)
    : interpretCompanionTurn(args.provider, args.baseMessages, {
      requestHash: attentionRequestHash,
      objects: companionAttentionObjects(args.read, meta.relatedGoals),
      capabilities: availableDefinitions.map(definition => definition.name),
      recentMessages: args.read.recentMessages,
      conversationClock: args.read.conversationClock,
      job: args.ctx,
      runId: args.read.runId,
      userId: args.read.userId,
      permissionLevel: meta.permissionLevel,
      stepTimeoutMs: Math.min(COMPANION_TOOL_INTENT_TIMEOUT_MS, deadlineAt - Date.now()),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: (attempt) => isJobLeaseActive({ ...args.ctx, leaseToken: attempt.leaseToken }),
      onReceipt: (receipt) => routeRecorder.onReceipt(receipt, { runId: args.read.runId, providerId: args.provider.id, modelId: args.provider.modelId }),
    });
  const attentionPromise = routeRecorder.track(attentionResult.then(async (attention) => {
    // Persist any explicit account preference before the speculative stream's release gate opens.
    const voicePreferenceWrite = await args.onTurnInterpretation?.(attention);
    return voicePreferenceWrite ? { ...attention, voicePreferenceWrite } : attention;
  }));

  // Preserve host-origin historical records through the same path as completed
  // native exchanges. They close no fabricated assistant turn and create no new
  // human request; their original source remains in the handoff and database.
  // reasoning 随 assistant 历史一起带回去：网关在思考模式下把"以 assistant 收尾"的
  // 请求当成续写，要求交回那条的 reasoning_text。主动参与轮每一轮都是这个形状，
  // 剥掉它就等于每一轮 400（0435；实测只带 encrypted_content 也不行）。
  const dialogueHistory = args.baseMessages
    .filter((message) => message.role !== "system" || message.hostObservation)
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.hostObservation ? { hostObservation: true } : {}),
      ...(message.reasoning && message.reasoning.length > 0 ? { reasoning: message.reasoning } : {}),
    } as AgentMessage));
  /**
   * 主动参与按**对话**装配（2026-10-13）：历史就是真实的 user/assistant 回合，宿主报告的时刻
   * 是一条带 hostObservation 的 system 观察消息，排在历史之后。原来这两样被压成一个 JSON 块、
   * 历史塞进 `recentDialogue` 字段，她读到的是"关于这段聊天的材料"，接不出上一句是谁说的、
   * 隔了多久——那正是"像个人一样接着聊"最需要的两层。
   *
   * 回放的是 role+content 两份纯文本（`companion-context-handoff.ts:312` 已经把工具与思考句柄
   * 剥掉），不带上一轮运行的句柄。**观察消息压在末尾并不能豁免"以 assistant 收尾"的
   * provider 要求**——2026-10-14 实测证伪了这条旧断言：观察消息就在末尾，思考开且带工具的
   * 主动轮仍然 400「reasoning_text must be passed back」。该形状现在由 provider 侧的
   * `endsWithAssistantTurn` 守卫兜住（降级为关思考，见 opencode-go）。跨运行句柄的旧错误
   * 来自把上一轮当本轮草稿，不是来自历史本身。
   */
  let messages = [...dialogueHistory];
  const initiativeObservation = args.read.initiativeInput
    ? { role: "system" as const, hostObservation: true as const,
      content: renderCompanionInitiativeObservation(args.read.initiativeInput,
        { lastOwnLines: recentOwnLines(dialogueHistory) }) }
    : null;
  const currentRequest = initiativeObservation
    ?? [...messages].reverse().find((message) => message.role === "user");
  if (!currentRequest) throw new Error("companion turn is missing its current user request");
  if (initiativeObservation) messages.push(initiativeObservation);
  const recoveryIdentity = { version: 1, runId: args.read.runId, conversationId: args.read.conversationId,
    baseMessages: args.baseMessages, currentRequest, permissionLevel: meta.permissionLevel,
    definitions: availableDefinitions.map(({ name, toolVersion, parameters }) => ({ name, toolVersion, parameters })),
    provider: { id: args.provider.id, modelId: args.provider.modelId, promptVersion: args.provider.promptVersion,
      capability: args.provider.getCapabilities?.() ?? null },
    fallback: args.fallbackProvider ? { id: args.fallbackProvider.id, modelId: args.fallbackProvider.modelId,
      promptVersion: args.fallbackProvider.promptVersion } : null };
  const recovered = meta.stepCount > 0
    ? await loadCompanionRuntimeCheckpoint(event, recoveryIdentity) : null;
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

  // 回合前段（投机器、注意力落定、历史绑定、工具面与能力快照）整段搬到
  // companion-turn-preamble.ts；messages 仍归运行时所有，用访问器接进去。
  const preamble = await settleCompanionTurnPreamble({
    loopArgs: args,
    event,
    meta,
    budget,
    availableDefinitions,
    dialogueHistory,
    recovered,
    attentionPromise,
    cachedInterpretation,
    handlerStartedAtMs,
    deadlineAt,
    elapsedMsDelta: elapsedDelta(),
    getMessages: () => messages,
    setMessages: (next) => { messages = next; },
  });
  const {
    attention, historyBinding, userRequiresTool, userAskedForAction, definitions,
    steerableReadTools, steerableActionTools, requestedActionTools,
  } = preamble;
  if (definitions.length === 0)
    throw new Error(`companion tool surface resolved empty for permission "${String(meta.permissionLevel)}"`);
  /**
   * Host pre-read for the current note.
   *
   * MiMo's Responses adapter rewrites tool_choice=required to auto, so "the
   * interpreter said read" did not guarantee a read: the model could answer
   * from history and still say it had just read the note. The host now reads
   * the first page before generation when the interpreter named
   * companion_read_note and the page context carries a real note id. The model
   * answers from that block; continuation still uses the normal read tool.
   */
  let notePrefetched = false;
  // Either current-page read operation means "the answer lives in this note".
  // The interpreter picks companion_read_current_page for "这一页" phrasings; if
  // only companion_read_note counted, the note stayed out of context and the
  // model answered from a note it had read earlier in the conversation.
  const readsCurrentNote = attention.candidateOperations.includes("companion_read_note")
    || attention.candidateOperations.includes("companion_read_current_page");
  logger.info({
    runId: args.read.runId, recovered: Boolean(recovered), toolUse: attention.toolUse,
    readsCurrentNote, notePrefetchContext: notePage?.context ?? null,
  }, "companion note prefetch decision inputs");
  if (!recovered && (attention.toolUse === "read" || attention.toolUse === "uncertain")
    && readsCurrentNote) {
    const noteId = (notePage?.context as { noteId?: unknown } | undefined)?.noteId;
    const noteVersionId = (notePage?.context as { noteVersionId?: unknown } | undefined)?.noteVersionId;
    if (typeof noteId === "string" && /^[0-9a-f-]{36}$/i.test(noteId)) {
      try {
        const note = await withWorkerWorkspaceTransaction(
          { workspaceId: args.ctx.workspaceId, userId: args.read.userId },
          tx => loadNoteReadPage(tx, {
            workspaceId: args.ctx.workspaceId,
            userId: args.read.userId,
            noteId,
            ...(typeof noteVersionId === "string" ? { noteVersionId } : {}),
            startOrdinal: 1,
            startOffset: 0,
            maxChars: 3_000,
          }),
        );
        if (note && note.page.body.trim().length > 0) {
          notePrefetched = true;
          const truncated = note.truncated
            ? `（第 1–${note.page.endOrdinal} 块，共 ${note.totalBlocks} 块；后面还没读）`
            : `（共 ${note.totalBlocks} 块）`;
          messages.push({
            role: "system",
            hostObservation: true,
            content: [
              "<prefetched_note>",
              `《${note.title}》${truncated}`,
              note.page.body,
              "</prefetched_note>",
              "这是宿主在你开口前读到的当前笔记正文。直接据此回答，不要描述读取过程，也不要说没读到。"
              + "需要续读时再用 companion_read_note（同版本、按 nextStartOrdinal 继续）。",
            ].join("\n"),
          });
          logger.info({ runId: args.read.runId, noteId, chars: note.page.body.length, truncated: note.truncated },
            "companion note prefetched by host before generation");
        }
      } catch (error) {
        logger.warn({ runId: args.read.runId, noteId, err: error }, "companion note prefetch failed; leaving the read to the model");
      }
    }
  }
  /**
   * The model sees a small core + the groups declared for this page. It can
   * expand the surface itself with companion_load_tools; candidate operations
   * may only add groups, never remove one. The full catalog still drives
   * authorization and execution checks.
   */
  let loadedToolNames = new Set<string>(recovered?.state.loadedToolNames ?? []);
  const initialToolNames = resolveCompanionInitialToolNames({
    availableToolNames: definitions.map(definition => definition.name),
    pageKind: notePage?.context?.pageKind ?? null,
    candidateOperations: attention.candidateOperations,
  });
  // The loader itself may be absent when permissions shrink; then the surface is
  // exactly the core + page groups and there is nothing to expand.
  const offeredToolDefinitions = () => definitions
    .filter(definition => initialToolNames.has(definition.name) || loadedToolNames.has(definition.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  let prefetchedFirstStep = preamble.prefetchedFirstStep;
  routeRecorder.record(event, handlerStartedAtMs);


  /**
   * 这一轮开不开思考（判据与理由见 `companion-turn-thinking`）：**整轮定一次**，
   * 不在每个 step 重算——闲聊轮的每一步都该是同一档，否则工具回来看一眼又变慢。
   *
   * 主动参与不再按事件名另开一档：招呼与陪着说话是 conversation 语域，走的正是
   * 「闲聊关思考」这条现役规则；答后再看一眼和页面帮助是提问档，该开就开。
   */
  const turnThinking = companionTurnThinking(attention);
  const responseStrategy = companionResponseStrategy(attention);
  // 这是调用意图，不是上游实际消耗：不支持 none 的模型仍使用最低思考档。
  logger.info({ runId: args.read.runId, requestedDisableThinking: turnThinking.disableThinking,
    providerId: args.provider.id, modelId: args.provider.modelId, basis: turnThinking.basis },
    "companion turn thinking preference resolved; provider applies declared levels");
  // 先显示可观察的工作状态，不把模型内部思维链当作 UI 内容。明确动作轮用任务状态
  // 取代泛化的「正在思考」；status 事件与 assistant.delta/TTS 分开。
  const actionProgressLabel = companionActionProgressLabel(attention, requestedActionTools);
  if (actionProgressLabel) {
    await emitCompanionAssistantStatus({
      workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
      status: "acting", safeLabel: actionProgressLabel,
    });
  } else if (!turnThinking.disableThinking && prefetchedFirstStep === null) {
    // 提问等非动作轮显示 thinking；偏好关思考的闲聊留在 waiting/回复状态。
    // 留下投机的第一步时**不再发这一条**：那一刻答案已经在手里、正文正在下发，
    // 「正在思考…」会晚于首字落库，成了一句假话（闲聊版投机一直就是这么处理的）。
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

  const contextText = companionNumericEvidenceContext(args.baseMessages);
  let stepCount = recovered?.state.stepCount ?? resolveAgentStepCountForResume(meta);
  const resumedStepCount = stepCount;
  let toolCallCount = meta.toolCallCount;
  const invalidArgumentCalls = new Set<string>(recovered?.state.invalidArgumentCalls);
  const rejectedExecutionConstraints = new Set<string>(recovered?.state.rejectedExecutionConstraints);
  /** 每个「工具名 + 参数」指纹已交付过几次成功回执；判据与收口见 `companion-progress-guard.ts`。 */
  const successfulCallReceipts = new Map<string, number>();
  event.verifyUtterance = text => {
    if (visibleSegments.some(segment => segment.trim()))
      throw new CompanionToolNotExecutedError("这轮已经开始连续回复，请接着把当前回复完成。需要分几句交流时，从第一句使用发言能力，避免正文和发言重复。");
    const checked = reviewCompanionStepCorrection({ said: text, contextText, messages, compactedEvidence, turnToolUse: attention.toolUse,
      pageContext: args.read.pageContext, groundedTutorContext: args.read.groundedTutorContext,
      stepCalls: 0, toolCallCount, finalAnswerOnly: false, stepCount, stepBudget: budget.maxSteps ?? Infinity,
      nowMs: Date.now(), deadlineAt, userAskedForAction: false, requestedActionTools: [],
      actionSteerAttempts: 0, lookupClaimSteered: false, quoteCorrectionUsed: false });
    if (checked.unverifiedQuotes.length || checked.unverifiedClaims.length)
      throw new CompanionToolNotExecutedError("这条发言的原文引用或个人读数尚未核对，没有发布。先读取真实来源，或改成有依据的表达后再说。");
  };

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
  /** "让她做件事却没落地"闸每轮至多一次：补一步就够，不把她逼成循环。 */
  let actionSteerAttempts = recovered?.state.actionSteerAttempts ?? 0;
  let quoteCorrectionUsed = recovered?.state.quoteCorrectionUsed ?? false;
  /**
   * "她说查过了、其实没查"单独一条额度（下面闸的注释说为什么不能共用）。
   */
  let lookupClaimSteered = recovered?.state.lookupClaimSteered ?? false;
  /** steer 之后紧跟的那一步换哪个 provider（见下面 stepProvider 的选取）。 */
  let steerSwapToFallback = recovered?.state.steerSwapToFallback ?? false;
  utterancePublished ||= recovered?.state.utterancePublished ?? false;
  if (args.continuationProposalId && (!recovered || recovered.phase === "waiting")) {
    messages = await loadContinuation(event, messages, args.continuationProposalId, deadlineAt,
      recovered?.phase === "waiting" ? { pendingCallId: recovered.pendingCallId!, onExecution: saved => {
        for (const block of saved.blocks ?? []) pushRichBlock(block);
        const route = allowedMainRouteV2Schema.safeParse(saved.route);
        if (route.success) pushRichBlock({ type: "nav", label: (saved.routeLabel ?? "查看已保存的结果").slice(0, 80), route: route.data });
      } } : undefined);
  }
  const workingState = (completedStepCount = stepCount): CompanionRuntimeState => ({
    messages: [...messages], compactedEvidence: [...compactedEvidence], stepCount: completedStepCount, toolCallCount,
    elapsedMs: Math.max(meta.elapsedMs, recovered?.state.elapsedMs ?? 0) + Date.now() - attemptStartedAt,
    visibleSegments: [...visibleSegments], visibleSegmentDelivered: [...visibleSegmentDelivered], richBlocks: [...richBlocks],
    webSearchCalls, historyFoldApplied, invalidArgumentCalls: [...invalidArgumentCalls],
    rejectedExecutionConstraints: [...rejectedExecutionConstraints], degenerateRetried, outputRepairToolCount,
    actionSteerAttempts, quoteCorrectionUsed, lookupClaimSteered, steerSwapToFallback, utterancePublished,
    loadedToolNames: [...loadedToolNames],
  });
  const finishBoundary = (stepId: string, status: "succeeded" | "failed", hash: string | undefined,
    errorCode?: string, result?: Extract<CompanionAgentLoopResult, { status: "completed" }>) => finishStep(event, stepId, status, hash,
      errorCode, encodeCompanionRuntimeCheckpoint(recoveryIdentity, { phase: result ? "settled" : "continue",
        state: workingState(), ...(result ? { result } : {}) }));
  const waitingReceipts = (proposalId: string, calls: AgentTurnResult["toolCalls"], index: number): AgentMessage[] =>
    calls.slice(index).map((call, offset) => ({ role: "tool", toolCallId: call.id,
      content: JSON.stringify(offset === 0 ? { ok: false, status: "waiting_confirmation", proposalId }
        : { ok: false, status: "not_executed", deferredByProposalId: proposalId,
          summary: "前一项正在等待用户确认，这一项尚未执行。决定到达后按当前目标与真实回执继续，不把它当成已完成。" }) }));
  const waitForConfirmation = (proposalId: string, calls: AgentTurnResult["toolCalls"], index: number) => {
    // Close every declared call honestly before a future model request. Later
    // calls remain in the transcript with their original arguments and an
    // explicit non-execution receipt; the Agent can replan after the decision.
    messages.push(...waitingReceipts(proposalId, calls, index));
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
    // 工具面、执行政策与请求装配这三样的判据在 `companion-agent-step-assembly.ts`。
    const { tools: toolsOfferedThisStep, toolChoice: toolChoiceThisStep } = companionStepToolSurface({
      toolDefinitions: offeredToolDefinitions(),
      webSearchAllowedForStep: companionWebSearchAllowedForStep({
        accountEnabled: currentMeta.webSearchEnabled === true,
        constraintsEnabled: event.constraints.webSearchEnabled === true,
        limit: budget.maxWebSearchCalls,
        used: webSearchCalls,
      }),
      finalAnswerOnly,
      requiresTool: userRequiresTool,
      toolCallCount,
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
      && !userAskedForAction && stepCount === resumedStepCount + 1;
    if (readOnlyRequiredStep) {
      logger.info({ runId: args.read.runId, stepCount, basis: "read-required-first-step" },
        "companion read-only required step uses the lowest declared thinking level");
    }
    /**
     * 第一步可能已经有现成的：投机的闲聊版（见上面的 speculative）。
     * 分类器确认没有需要改写历史或补入注意力对象的内容，才复用这版闲聊请求。
     */
    const prefetched = prefetchedFirstStep !== null && stepCount === resumedStepCount + 1 ? prefetchedFirstStep : null;
    if (prefetched) prefetchedFirstStep = null;
    let stepRequest: AgentTurnRequest = assembleCompanionStepRequest({
      turnPolicy: typeof args.baseMessages[0]?.content === "string" ? args.baseMessages[0].content : "",
      runtimePolicy,
      executionGuidance: [responseStrategy.guidance, companionExecutionConstraintGuidance(attention)].filter(Boolean).join("\n"),
      attention,
      messages,
      tools: toolsOfferedThisStep,
      toolChoice: toolChoiceThisStep,
      disableThinking: turnThinking.disableThinking || readOnlyRequiredStep,
      provider: args.provider,
      temperature: responseStrategy.temperature,
      prefetchedRequest: prefetched?.request ?? null,
    });
    const stepId = await persistStep(event, stepCount, auditHash(stepRequest));
    stepCompaction.setStepId(stepId);
    const preparation = new CompanionToolPreparation(definitions.filter(definition =>
      toolsOfferedThisStep.some(tool => tool.name === definition.name)), async (tool, definition, status) => {
      await appendAgentEvent(event, "agent.tool", { tool: {
        toolCallId: tool.id, name: definition.name, toolVersion: definition.toolVersion,
        riskClass: definition.riskClass, status,
        safeLabel: status === "requested"
          ? `正在准备${(COMPANION_AGENT_TOOL_LABELS[definition.name] ?? "这一步").replace(/^正在/, "")}`
          : COMPANION_AGENT_TOOL_LABELS[definition.name] ?? "这一步",
        ...(status === "not_executed" ? { safeSummary: "内容准备中断，这一步没有执行。" } : {}),
      } });
    });
    // 这一步默认走主档；需要恢复时采用正式 companion_fallback 槽。
    // 备用槽可能只有 64k 窗口，装不下时切过去会把一次可恢复的 steering
    // 变成整轮 AGENT_BUDGET_EXCEEDED。装不下就留在主槽重试。
    const pendingSteer = steerSwapToFallback;
    let stepProvider = args.provider;
    if (steerSwapToFallback && typeof args.fallbackProvider?.executeAgentTurn === "function") {
      const fallbackFits = await providerFitsRequest(args.fallbackProvider, stepRequest);
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
    /** 本步是否已经下发过文本（重试判据，每步重置）。 */
    let stepEmitted = false;
    // 投机那一步的字可能已经流出去了：`stepEmitted` 必须照实带过来，
    // 否则重试安全性与坍缩闸都会以为这一步没发过字（那两个判据都以它为准）。
    if (prefetched) stepEmitted = prefetched.emitted;
    const resumingInput = recovered?.phase === "input" && stepCount === resumedStepCount + 1;
    if (resumingInput) {
      const displayed = args.initialVisibleText ?? "";
      const prior = sanitizeCompanionVisibleText(visibleSegments.join(VISIBLE_SEGMENT_SEPARATOR));
      if (displayed.length > prior.length && displayed.startsWith(prior)) {
        const folded = restoreCompactionCheckpoint({ runId: args.read.runId, conversationId: args.read.conversationId,
          request: stepRequest, traces: args.compactionCheckpoints ?? [] });
        const actualRequest = folded ? { ...stepRequest, messages: folded.messages } : stepRequest;
        const stored = await createCompanionAgentStepCheckpointPort(event, stepId).load({ taskId: "companion_agent_model_step", taskVersion: 1,
          inputSnapshotHash: companionAgentModelInputHash({ request: actualRequest, provider: stepProvider, permissionLevel: meta.permissionLevel }),
          workspaceId: args.ctx.workspaceId, userId: args.read.userId });
        if (stored) stepEmitted = true; // Reuse the whole model result, keeping its already delivered prefix once.
        else {
          const suffix = displayed.slice(prior.length).replace(/^\n\n/, "");
          visibleSegments.push(suffix); visibleSegmentDelivered.push(true);
          messages.push({ role: "assistant", content: suffix }, ...companionStepCorrectionMessages({ currentRequest,
            alreadyDisplayed: true, instruction: "执行进程中断，前面这段文字已经显示；它没有新的工具执行回执。保留已确认结果，接着完成当前问题，不从头重说这段前缀。" }));
          stepRequest = { ...stepRequest, messages: [...messages] };
        }
      }
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
      const eagerScheduler = EAGER_TOOL_DISPATCH_ENABLED
        ? createCompanionEagerScheduler({ jobArgs: args, event, deadlineAt: () => deadlineAt, getStepId: () => stepId })
        : null;

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
              (taskSignal) => provider.executeAgentTurn!(folded, taskSignal),
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

      if (prefetched) {
        // The speculative stream has already completed (and may have delivered
        // text). Consume it before choosing any provider transport.
        result = prefetched.result;
      } else if (canStreamThisStep) {
        // 每一步都走真实流式：增量实时交给交付管线（净化 + 校验 + 落库 + SSE 下发）。
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
        const attemptStream = (): Promise<AgentTurnResult> =>
          sendWithBoundedCompaction(stepRequest, (folded) =>
            runModelStepTask(stepProvider, folded, args.ctx.signal, (signal) =>
              runStreamingAgentStep({
                provider: stepProvider,
                stepRequest: folded,
                ctxSignal: signal,
              timeoutMs: providerCallTimeout,
              onProviderDelta: args.onProviderDelta!,
              ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
              separatorBefore: visibleSegmentDelivered.includes(true) ? VISIBLE_SEGMENT_SEPARATOR : "",
              // Action and required-read steps buffer prose until the step's
              // tool outcome is known. Streaming them looked faster, but a
              // required-read step that then gets steered produced two full
              // answers in one bubble (2026-10-17 `today` turn).
              deferPublication: stepRequest.toolChoice === "required",
              onToolCallStarted: preparation.observe,
              // 不给回调时 provider 与这一步**完全不做额外的事**（少传一个键）。
              ...(eagerScheduler
                ? {
                  onToolCallSettled: (slot: { index: number; id: string; name: string; argsText: string }) => {
                    eagerScheduler.offer(slot);
                  },
                }
                : {}),
              // 每一步都攒批，不只终答步。`finalAnswerOnly` 是 `stepCount >= maxSteps`，
              // 也就是"只有被强制收尾的那一步"才算终答——而她**直接答话**（不调工具）
              // 是第 1 步，那时 hold=0，字当场流出去、stepEmitted 置位，
              // 退化闸的 `!stepEmitted` 就永远不成立。实机 2026-09-21 两条三字输入
              // （"小猫？"→"嗯？"、"嘿嘿嘿"→"嗯，我在。"）各带 2 条 delta、
              // 3 小时内 `walking the repair ladder` 日志 0 次，就是这么漏过去的。
              // 代价写在这里，别让下一个人以为是疏忽：**工具步那句开场白也会被攒住**，
              // 短于 12 字的"我先看看你的笔记"不再逐字出现，而是随整段一起补发。
              // 换来的是坍缩闸可达——按用户口径（"说的太短了"是抱怨 #1），这个方向值。
              // 攒批不影响正确性：没下发过的内容仍由 writeTail 在终态补发，
              // "已下发是最终正文的前缀"这条不变量照旧成立。
              holdUntilChars: stepHoldChars({ userAskedForAction }),
              onTextEmitted: () => { stepEmitted = true; },
            })));
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
        const runBuffered = (): Promise<AgentTurnResult> =>
          runWithAbortBudget(
            executeBufferedTurn,
            args.ctx.signal,
            Math.min(providerCallTimeout, Math.max(1, deadlineAt - Date.now())),
          );
        try {
          result = await attemptStream();
        } catch (error) {
          if (!canRetryStream(error)) throw error;
          // 传**错误对象**而不是 message 字符串：序列化器（safeErrorSerializer）
          // 对非 Error 输入一律投影成 `{name:"Error", code:null}`，等于把唯一
          // 能区分的字段（真实类名 / provider_http_<status> / stream_empty）
          // 一并抹掉。传对象才能看出是 HTTP 504 还是"响应体不是 SSE"。
          logger.warn(
            { err: error, stepCount },
            "companion streaming answer failed before any delta",
          );
          // 网关 5xx 是瞬时故障：实测 tokenrhythm→litellm 偶发
          // `504 UPSTREAM_TIMEOUT`（直连压测 10 次撞到 1 次），前两个真实轮次也都
          // 撞上同一形态。缓冲轮对空输出有 3 次重试，流式轮此前**一次即降级**——
          // 于是约一成的轮次白白丢掉"边生成边显示"（症状 ④）。给流式一次原样重试：
          // 只有"一个字都没下发"才走到这里（上面 canRetryStream 已保证），
          // 所以重试不会让客户端看到两段前缀。仍失败才退化成整段取回。
          if (error instanceof ProviderRequestError && error.status >= 500 && canRetryStream(error)) {
            try {
              result = await attemptStream();
            } catch (retryError) {
              if (!canRetryStream(retryError)) throw retryError;
              logger.warn(
                { err: retryError, stepCount },
                "companion streaming retry failed before any delta; retrying with buffered turn",
              );
              result = await runBuffered();
            }
          } else {
            logger.warn(
              { stepCount },
              "companion streaming answer failed for a non-transient reason; retrying with buffered turn",
            );
            result = await runBuffered();
          }
        }
        // 收口（成功路）：**必须**在循环看到 result.toolCalls 之前把在途等完。
        // 否则循环会拿到还停在 "requested"（可重放）的账本行，于是**再跑一遍**——
        // 那是提前派发最不能出的错。close 幂等，抛错路已 close 过也不影响。
        if (eagerScheduler) await eagerScheduler.close(false);
      } else {
        result = await runWithAbortBudget(
          executeBufferedTurn,
          args.ctx.signal,
          providerCallTimeout,
        );
      }
      if (containsCompanionToolProtocol(String(result.content ?? "")))
        throw new CompanionToolOutputRepairError("", String(result.content ?? ""));
      await preparation.finish(result.toolCalls ?? []);
    } catch (error) {
      await preparation.finish([]).catch(preparationError => logger.warn(
        { runId: args.read.runId, err: preparationError }, "companion tool preparation could not be settled"));
      if (eagerScheduler) await eagerScheduler.close(true);
      const outputRepair = error instanceof CompanionToolOutputRepairError ? error
        : error instanceof AgentOutputError && error.code === "arguments_malformed"
          ? new CompanionToolOutputRepairError("", "", "arguments_malformed") : null;
      if (outputRepair && outputRepairToolCount !== toolCallCount && Date.now() < deadlineAt && !args.ctx.signal.aborted) {
        outputRepairToolCount = toolCallCount;
        if (outputRepair.publishedText.length > 0) {
          visibleSegments.push(outputRepair.publishedText);
          visibleSegmentDelivered.push(true);
        }
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
    // B 兜底（2026-09-19 内容质量）：这一步被输出预算砍断、且**一个字都没下发过**时
    // 重试一次——半截话不该是用户拿到的最终答复。已下发的（流式成功，stepEmitted=true）
    // 无法撤回，只能留痕（下方 finishReason 日志）。
    // 2026-10-07：预算已经改成"按模型档案声明"，所以不再"翻倍"（翻倍是对着一个小常数
    // 想出来的办法）；只有这一步确实低于当前可用天花板时才抬到天花板重来，已经在天花板
    // 上就没有可长的空间，只留痕。
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
              (taskSignal) => stepProvider.executeAgentTurn!(retryRequest, taskSignal),
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
    let calls = result.toolCalls ?? [];
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
        provider, request, signal, taskSignal => provider.executeAgentTurn!(request, taskSignal), timeoutMs),
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
    const said: string = String(result.content ?? "");
    const {
      unverifiedClaims, unverifiedQuotes, nothingDueClaim, lookupClaim, steerPlan, correctQuote,
    } = reviewCompanionStepCorrection({
      said,
      contextText,
      compactedEvidence,
      messages,
      turnToolUse: attention.toolUse,
      pageContext: args.read.pageContext,
      groundedTutorContext: args.read.groundedTutorContext,
      stepCalls: calls.length,
      toolCallCount,
      finalAnswerOnly,
      stepCount,
      stepBudget,
      nowMs: Date.now(),
      deadlineAt,
      userAskedForAction,
      requestedActionTools,
      // A required surface (tool_choice=required) that came back with no call
      // is a provider contract miss, not a valid answer. Only enforce on the
      // first step; later steps may legitimately settle after a tool receipt.
      requiresReadReceipt: !notePrefetched && stepCount === resumedStepCount + 1
        && attention.toolUse === "read" && calls.length === 0 && toolCallCount === 0,
      actionSteerAttempts,
      lookupClaimSteered,
      quoteCorrectionUsed,
    });
    if (steerPlan.steer || correctQuote) {
      if (correctQuote) quoteCorrectionUsed = true;
      if (steerPlan.consumeAction) actionSteerAttempts += 1;
      // The correction step may need a tool from a group the first step did not
      // load. Expand the surface for this steer rather than naming a tool the
      // model cannot call.
      const steerNames = resolveCompanionInitialToolNames({
        availableToolNames: definitions.map(definition => definition.name),
        pageKind: notePage?.context?.pageKind ?? null,
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
      if (said.trim().length > 0) {
        // 被 steer 掉的那一步：**只有已经流式下发过的话才留在最终正文里**。
        // 没发出去的那句（被 hold 攒住）如果留下，用户会在同一条消息里先看到
        // "嗯，记住了喵。"再看到纠正后的正文——三遍同义反复就是这么拼出来的
        // （实机 2026-09-22 场景 T，delta 只有 1 批 73 字 = 全程没流式，最后整段补发）。
        // 丢掉它对用户不可见（他本来就没收到），而这句话正是这次要纠正的内容。
        // assistant 消息仍然回灌：模型要看得见自己说过什么，纠正才接得上。
        if (stepEmitted) {
          visibleSegments.push(said);
          visibleSegmentDelivered.push(true);
        }
        messages.push({ role: "assistant", content: said });
      }
      messages.push(...companionStepCorrectionMessages({
        currentRequest,
        alreadyDisplayed: stepEmitted,
        instruction: buildCompanionStepCorrectionInstruction({
          correctQuote,
          unverifiedQuotes,
          unverifiedClaims,
          lookupClaim,
          steerableReadTools,
          steerableActionTools,
          requestedActionTools,
        }),
      }));
      await finishBoundary(stepId, "succeeded", sha256Utf8V1(said));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      logger.warn({ runId: args.read.runId, stepCount, chars: said.trim().length,
        claims: unverifiedClaims.slice(0, 4),
        by: companionSteerCause({ correctQuote, unverifiedClaims, unverifiedQuotes, lookupClaim,
          nothingDueClaim, userAskedForAction }) },
      "companion agent step needs a steer; cause in `by`");
      return { kind: "continue" };
    }
    // 一次纠正的额度限制生成次数，不能把仍不匹配的原文引用降为成功终答。
    const saidHash = sha256Utf8V1(said);
    const quoteGate = judgeCompanionDeliveryGate({ gate: "unverified_quote", landedWrites,
      // A verified quote mismatch must not erase an otherwise complete explanation.
      // The correction step already ran; keep the text and leave a failed trace.
      hasDeliverablePrefix: said.trim().length > 0 });
    if (calls.length === 0 && unverifiedQuotes.length > 0) {
      if (quoteGate.destroysTurn) {
        await finishStep(event, stepId, "failed", saidHash, quoteGate.stepErrorCode);
        throw new AgentOutputError("unverified_quote", "companion quote does not match the available source after correction");
      }
      await finishBoundary(stepId, "failed", saidHash, quoteGate.stepErrorCode);
      logger.warn({ runId: args.read.runId, stepCount }, quoteGate.bypassNote);
    }
    const actionGate = judgeCompanionDeliveryGate({ gate: "action_not_executed", landedWrites });
    if (calls.length === 0 && userAskedForAction && requestedActionTools.length > 0
      && !companionActionResultRecorded(messages, requestedActionTools)) {
      if (actionGate.destroysTurn) {
        await finishStep(event, stepId, "failed", saidHash, actionGate.stepErrorCode);
        throw new AgentOutputError("action_unverified", "requested action has no execution or verified unchanged receipt after correction");
      }
      await finishBoundary(stepId, "failed", saidHash, actionGate.stepErrorCode);
      logger.warn({ runId: args.read.runId, stepCount }, actionGate.bypassNote);
    }
    if (calls.length === 0) {
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
        await finishStep(event, stepId, "failed", undefined, "EMPTY_AGENT_RESPONSE");
        throw new Error("companion agent returned empty final response");
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
      // E：有被丢弃的复读段时上面已经留痕；这个观测项只针对"想丢也丢不了"的
      // 情况——复读段已经流式下发，只能保留（删了会与最终正文分叉）。
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
    // 每步工具数不再有上限（2026-10-16）：旧的 `AGENT_TOOL_CALL_LIMIT` 用一个计数
    // 决定她这一步能问几件事，保证不了正确性。带工具的一步：这一步的 content
    // 是**开场白**（"我先看看你的笔记"），不是终答。
    // 它已经随流式下发（④-b），因此必须留在可见正文里——否则客户端累积的草稿
    // 会与最终 assistant 消息对不上（见 joinVisibleSegmentsDeduped 的说明）。
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
            ...waitingReceipts(proposalId, calls, callIndex)] } }) });
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
        continue;
      }
      // The reduced surface is a declaration, not a suggestion. A tool that
      // was not offered this step must be loaded first; otherwise the model
      // could silently use the full catalog and the prompt savings would be
      // cosmetic. `load_tools` itself must be callable even before loading.
      if (identity.name !== "companion_load_tools"
        && !toolsOfferedThisStep.some(tool => tool.name === identity.name)) {
        const offered = toolsOfferedThisStep.map(tool => tool.name);
        await recordRejectedToolCall(event, stepId, identity, safeArgumentsHash(call.arguments),
          getCompanionAgentTool(identity.name), "not_executed", "这个工具组还没有装载");
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            ok: false,
            status: "not_executed",
            error: `工具 ${identity.name} 不在本步已装载的工具面里。先调用 companion_load_tools 装载对应组；当前可用：${offered.slice(0, 20).join("、")}`,
          }),
        });
        continue;
      }
      const definition = getCompanionAgentTool(identity.name);
      // 唯一的归属边界是"这个工具注册过吗"+ 上面的权限档过滤。
      // 原先还要求它属于本轮选中的那个技能，那正是能力被静默关掉的地方。
      if (!definition) {
        await recordRejectedToolCall(
          event, stepId, identity, safeArgumentsHash(call.arguments),
          null, "blocked", "未注册的工具，操作已阻止",
        );
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: identity.id,
            name: identity.name,
            toolVersion: "unknown",
            // An unresolvable tool is treated as maximally risky in the audit
            // trail rather than understating it as a read.
            riskClass: "irreversible",
            status: "blocked",
            safeLabel: "未注册工具，操作已阻止",
          },
        });
        messages.push({ role: "tool", toolCallId: identity.id, content: JSON.stringify({ ok: false, status: "blocked", error: "unknown or disallowed tool" }) });
        continue;
      }
      const parsedArgs = validateCompanionAgentToolArguments(identity.name, call.arguments);
      if (!parsedArgs.success) {
        const invalidIdentity = `${identity.name}:${safeArgumentsHash(call.arguments)}`;
        const repeatedInvalid = invalidArgumentCalls.has(invalidIdentity);
        invalidArgumentCalls.add(invalidIdentity);
        const schemaFields = new Set(Object.keys(definition.parameters.properties ?? {}));
        logger.warn({ runId: args.read.runId, toolName: identity.name, repeatedInvalid,
          issues: parsedArgs.issues.map(issue => ({
            field: schemaFields.has(issue.path[0] ?? "") ? issue.path[0] : "$input", code: issue.code,
          })) }, "companion tool arguments rejected; schema field metadata only");
        // 40b §3.2：`not_executed` 就是「参数无效」这一格。它据此知道
        // **改参数重来是有意义的**，而 "failed" 会让它以为这个工具本身坏了，
        // 转头去编一个答案。账本与模型现在说的是同一个词。
        const rejected = companionToolFailureFaces({ status: "not_executed", safeSummary: parsedArgs.reason });
        await recordRejectedToolCall(
          event, stepId, identity, safeArgumentsHash(call.arguments),
          definition, "not_executed", parsedArgs.reason,
        );
        await appendAgentEvent(event, "agent.tool", {
          tool: {
            toolCallId: identity.id,
            name: identity.name,
            toolVersion: definition.toolVersion,
            riskClass: definition.riskClass,
            status: rejected.ledgerStatus,
            safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description.slice(0, 240),
            safeSummary: parsedArgs.reason,
          },
        });
        messages.push({
          role: "tool",
          toolCallId: identity.id,
          content: JSON.stringify({ ok: false, status: rejected.modelStatus, error: parsedArgs.reason,
            code: "invalid_arguments", validationIssues: parsedArgs.issues,
            parameters: definition.parameters,
            instruction: "按 validationIssues 修正参数，不重复提交相同无效参数；已经成功的操作不必重做。" }),
        });
        // Validation is pure: the identical invalid input cannot become valid
        // by waiting or spending another model call. This is a no-progress
        // failure, not a step/tool quota; changed arguments remain retryable.
        if (repeatedInvalid) {
          await finishStep(event, stepId, "failed", undefined, "REPEATED_INVALID_TOOL_ARGUMENTS");
          await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
          throw new AgentOutputError("arguments_malformed", "companion repeated identical invalid tool arguments after validation feedback");
        }
        continue;
      }
      const serializedArgs = canonicalJsonV1(parsedArgs.data);
      const argsHash = sha256Utf8V1(serializedArgs);
      if (identity.name === "companion_load_tools") {
        const groups = (parsedArgs.data as { groups?: string[] }).groups ?? [];
        const wanted = resolveCompanionToolGroupNames(groups);
        const loaded = definitions.filter(item => wanted.has(item.name)).map(item => item.name);
        for (const name of loaded) loadedToolNames.add(name);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({
          ok: true,
          data: { loadedGroups: groups, tools: loaded },
          summary: `已装载 ${loaded.length} 个工具`,
        }) });
        await appendAgentEvent(event, "agent.tool", { tool: {
          toolCallId: call.id, name: identity.name, toolVersion: definition.toolVersion,
          riskClass: "read", status: "succeeded", safeLabel: "已装载更多能力",
          safeSummary: `已装载 ${loaded.length} 个工具`,
        } });
        continue;
      }
      const restriction = companionTimeWakeupConstraint(attention, identity.name, parsedArgs.data);
      if (restriction) {
        await recordRejectedToolCall(event, stepId, identity, argsHash, definition, "not_executed", restriction.instruction);
        await appendAgentEvent(event, "agent.tool", { tool: { toolCallId: identity.id, name: identity.name,
          toolVersion: definition.toolVersion, riskClass: definition.riskClass, status: "not_executed",
          safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name], safeSummary: "这轮只按事件触发，没有设置时间。" } });
        messages.push({ role: "tool", toolCallId: identity.id, content: JSON.stringify({ ok: false,
          status: "not_executed", code: "execution_constraint", error: restriction.instruction }) });
        if (rejectedExecutionConstraints.has(restriction.key)) {
          await finishStep(event, stepId, "failed", undefined, "REPEATED_EXECUTION_CONSTRAINT");
          await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
          throw new AgentOutputError("arguments_malformed", "companion repeatedly violated an unchanged execution constraint");
        }
        rejectedExecutionConstraints.add(restriction.key);
        continue;
      }
      // Field/range limits come from the capability's actual schema. A second
      // generic JSON character cap rejects valid escaped Markdown and evidence.
      const record = await ensureAgentToolCall(
        event,
        stepId,
        definition,
        { id: identity.id, arguments: parsedArgs.data },
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
            safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description.slice(0, 240),
            ...(record.safeSummary ? { safeSummary: record.safeSummary } : {}),
            ...(definition.name === "companion_edit_note" && record.status === "succeeded" && record.resultRef ? { noteEdit: companionEditedNoteV1Schema.parse(JSON.parse(record.resultRef)) } : {}),
            ...(definition.name === "companion_write_annotation" && record.status === "succeeded" && record.resultRef ? { noteAnnotation: JSON.parse(record.resultRef) } : {}),
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
          if (companionReplayExhausted(successfulCallReceipts, companionCallFingerprint(definition.name, argsHash))) {
            await finishStep(event, stepId, "failed", undefined, "REPEATED_IDENTICAL_TOOL_CALL");
            await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
            throw new AgentOutputError("no_progress", "companion repeated an identical tool call after its successful receipt");
          }
          if (record.resultPayload) {
            const saved = record.resultPayload;
            for (const block of saved.blocks ?? []) pushRichBlock(block);
            const route = allowedMainRouteV2Schema.safeParse(saved.route);
            if (route.success) pushRichBlock({ type: "nav",
              label: (saved.routeLabel ?? COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.name).slice(0, 80), route: route.data });
            if (definition.name === "agent_web_search" && saved.value.status === "unavailable") event.constraints.webSearchEnabled = false;
            messages.push({ role: "tool", toolCallId: call.id,
              content: JSON.stringify({ ok: true, data: saved.value, summary: saved.safeSummary }) });
            continue;
          }
          const editedNote = definition.name === "companion_edit_note" && record.resultRef
            ? companionEditedNoteV1Schema.parse(JSON.parse(record.resultRef)) : null;
          const editedModelReceipt = editedNote ? { kind: editedNote.kind, noteId: editedNote.noteId, noteVersionId: editedNote.noteVersionId, operation: editedNote.operation, summary: editedNote.summary } : null;
          const createdNote = definition.name === "companion_create_note" ? readCreatedNoteReceipt(record.resultRef) : null;
          if (createdNote) for (const block of createdNoteToolResult(createdNote).blocks ?? []) pushRichBlock(block);
          const searchResult = definition.name === "agent_web_search" ? readWebSearchReceipt(record.resultRef) : null;
          if (searchResult) {
            for (const block of webSearchCitationBlocks(searchResult)) pushRichBlock(block);
            if (searchResult.status === "unavailable") event.constraints.webSearchEnabled = false;
          }
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: JSON.stringify({
              ok: true,
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
      const searchLimitReached = identity.name === "agent_web_search"
        && budget.maxWebSearchCalls != null && webSearchCalls >= budget.maxWebSearchCalls;
      const unavailableSummary = unavailableCompanionToolSummary(identity.name, event.constraints, { searchLimitReached });
      if (unavailableSummary) {
        const unavailable = companionToolFailureFaces({
          status: searchLimitReached && event.constraints.webSearchEnabled === true ? "not_executed" : "unavailable",
          safeSummary: unavailableSummary,
        });
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
            safeLabel: COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description.slice(0, 240),
            safeSummary: unavailable.safeSummary,
          },
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({
            ok: false,
            status: unavailable.modelStatus,
            error: unavailable.safeSummary,
          }),
        });
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
      if (definition.name === "agent_web_search") webSearchCalls++;
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
        continue;
      }
      if (run.kind === "waiting") {
        waitForConfirmation(run.proposalId, calls, callIndex);
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch() });
        return { kind: "settled", result: { status: "waiting_for_confirmation", proposalId: run.proposalId, memoryRefs: [] } };
      }
      // 同一个「工具名 + 参数」本轮已交付过成功回执，这次又是原样调用=原地重放。
      if (companionReplayExhausted(successfulCallReceipts, companionCallFingerprint(definition.name, argsHash))) {
        await finishStep(event, stepId, "failed", undefined, "REPEATED_IDENTICAL_TOOL_CALL");
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta() });
        throw new AgentOutputError("no_progress", "companion repeated an identical tool call after its successful receipt");
      }
      const execution = run.execution;
      if (definition.name === "agent_web_search" && (execution.value as { status?: string })?.status === "unavailable") {
        event.constraints.webSearchEnabled = false;
      }
      await recoverCompanionRunFailureSpanBestEffort({
        workspaceId: args.ctx.workspaceId,
        userId: args.read.userId,
        runId: args.read.runId,
      }, "tool");
      // 富载荷进消息流（方案 29 §4.8，抱怨 #5「连跳到某个笔记都做不到」的收尾）：
      // 她打开/跳转到的落点以前只活在 agent.tool 事件和一行游离在正文之外的 chip 里，
      // 事件有 TTL、chip 不落在正文顺序中，于是回看时"她带我去看的那篇笔记"根本不存在。
      // route 仍然过一遍主进程白名单：它是服务端构造的，但"构造得对"不该靠约定。
      if (execution.route) {
        const parsedRoute = allowedMainRouteV2Schema.safeParse(execution.route);
        if (parsedRoute.success) {
          pushRichBlock({
            type: "nav",
            // 兜底用注册表里的展示名（「正在带你去那个页面」），不是工具描述：
            // 这一块会渲染成「可以接着看这里」那张纸签，描述是写给模型的用法说明。
            label: (execution.routeLabel ?? COMPANION_AGENT_TOOL_LABELS[definition.name] ?? definition.description).slice(0, 80),
            route: parsedRoute.data,
          });
        } else {
          logger.warn(
            { runId: args.read.runId, tool: definition.name },
            "companion agent produced a route outside the allowed main-route schema; nav block dropped",
          );
        }
      }
      for (const block of execution.blocks ?? []) pushRichBlock(block);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        // Read tools budget and paginate their data before serialization. Cutting
        // an encoded envelope corrupts escapes/cursors; the next complete request
        // is governed by its actual token budget instead.
        content: JSON.stringify({ ok: true, data: execution.value, summary: execution.safeSummary }),
      });
    }
    const closingCall = calls.at(-1);
    const closesSilently = args.read.initiativeInput && closingCall?.name === "companion_finish_participation";
    const closesSpeech = closingCall?.name === "companion_publish_utterance"
      && (closingCall.arguments as { final?: boolean } | null)?.final !== false
      && calls.every(call => ["companion_publish_utterance", "companion_write_annotation"].includes(call.name));
    // A committed publication or explicit silent decision is the result itself.
    // Do not spend another model round trip merely to confirm execution ended.
    const succeededCalls = calls.every(call => {
      const receipt = [...messages].reverse().find(message => message.role === "tool" && message.toolCallId === call.id);
      if (!receipt || typeof receipt.content !== "string") return false;
      try { return JSON.parse(receipt.content).ok === true; } catch { return false; }
    });
    const deliveredAnnotation = writingAnnotation && calls.some(call => {
      if (call.name !== "companion_write_annotation" || (call.arguments as { final?: boolean } | null)?.final === false) return false;
      const receipt = [...messages].reverse().find(message => message.role === "tool" && message.toolCallId === call.id);
      try { return receipt && JSON.parse(String(receipt.content)).ok === true; } catch { return false; }
    });
    if (deliveredAnnotation && calls.every(call => ["companion_write_annotation", "companion_publish_utterance"].includes(call.name))) {
      // The independent artifact is already delivered. Optional speech failure cannot turn it into another generation loop.
      const completedResult = { status: "completed" as const, text: utterancePublished ? "" : said.trim(), blocks: richBlocks, memoryRefs: [], writesLanded: landedWrites,
        ...(result.reasoning && result.reasoning.length > 0 ? { reasoning: result.reasoning } : {}) };
      await finishBoundary(stepId, "succeeded", auditHash(messages.slice(-calls.length)), undefined, completedResult);
      return { kind: "settled", result: completedResult };
    }
    if ((closesSilently || closesSpeech) && succeededCalls) {
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
} from "./companion-read-tools.ts";

export type { AgentEventContext };
export { readLatestPageContextRow };

// 步进规划族已搬到 companion-step-plan.ts（B2）。纯搬运：判据、上限、类型一字未改。
import {
  buildCompanionStepCorrectionInstruction,
  companionActionResultRecorded,
  companionStepCorrectionMessages,
  companionWriteToolNames,
  reviewCompanionStepCorrection,
  stepHoldChars,
  type CompanionAgentLoopResult,
} from "./companion-step-plan.ts";
import { companionSteerCause, judgeCompanionDeliveryGate } from "./companion-delivery-gates.ts";

// 事件与步进持久化由 companion-agent-events.ts 承担，也在该模块保存运行态模型恢复点。
import {
  createCompanionAgentStepCheckpointPort,
  appendAgentEvent,
  finishStep,
  persistStep,
  readRunMeta,
  resolveAgentStepCountForResume,
  updateRunMeta,
} from "./companion-agent-events.ts";
