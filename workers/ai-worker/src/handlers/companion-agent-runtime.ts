import { CompanionToolNotExecutedError } from "./companion-tool-result.ts";
import { isCompanionParticipationClosure } from "./companion-participation-output.ts";
import { sql } from "drizzle-orm";
import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
import { isCompanionAutonomousTool } from "@astella/shared/companion-autonomy";
import { companionEditedNoteV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import type { CompanionAgentLoopArgs } from "../contracts/companion-agent-loop.ts";
import { executeTurn } from "@astella/agent-core";
import {
  auditHash,
  boundedToolCallIdentity,
  companionStepRequiresTool,
  ensureAgentToolCall,
  executeCompanionAgentTurnWithToolChoiceFallback,
  loadContinuation,
  recordRejectedToolCall,
  safeArgumentsHash,
  steerableToolNames,
  updateToolCall,
} from "./companion-tool-call-ledger.ts";
import {
  COMPANION_AGENT_CONTRACT_VERSION,
  companionAgentCapabilitySnapshotV1Schema,
  COMPANION_AGENT_TOOL_LABELS,
  allowedMainRouteV2Schema,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
  type CompanionAgentToolStatus,
  type CompanionContentBlockV1,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";

import { COMPANION_TOOL_INTENT_TIMEOUT_MS, interpretCompanionTurn } from "./companion-tool-intent.ts";
import { companionAttentionObjects } from "./companion-attention.ts";
import { companionTurnThinking } from "./companion-turn-thinking.ts";
import { companionActionProgressLabel } from "./companion-action-progress.ts";
import { companionResponseStrategy } from "./companion-response-strategy.ts";
import { startCompanionSpeculativeFirstSteps } from "./companion-speculative-flights.ts";
import {
  findDuplicateSegment,
  joinVisibleSegmentsDeduped,
  VISIBLE_SEGMENT_SEPARATOR,
} from "./companion-visible-segments.ts";
import { boundedStepSender } from "./companion-compaction.ts";
import { compactActiveToolContext, createWorkingStateSummarizer } from "./companion-active-context-compaction.ts";
import { renderPendingOffersAsRecords } from "./companion-context-handoff.ts";
import { runCompanionAgentModelStep } from "./companion-agent-task.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import {
  resolveCompanionAgentBudget,
  resolveProviderCallTimeout,
} from "../lib/handler-timeout-config.ts";
import { AgentOutputError, CompanionAgentBudgetExceededError } from "../lib/non-retryable-errors.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";
import { currentWorkerWorkspaceTransaction, withWorkerWorkspaceTransaction } from "../db.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import {
  emitCompanionAssistantStatus,
  recoverCompanionRunFailureSpanBestEffort,
} from "./companion-dialogue-store.ts";
import { looksTruncatedReply, companionStepOutputCeiling } from "./companion-dialogue-content.ts";
import { unavailableCompanionToolSummary } from "./companion-tool-outcome.ts";
import { companionNumericEvidenceContext } from "./companion-context-evidence.ts";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";
import { runCompanionToolExecution } from "./companion-tool-execution-run.ts";
import { CompanionToolPreparation } from "./companion-tool-preparation.ts";
import { companionExecutionPolicy } from "./companion-execution-policy.ts";
import { repairDegenerateCompanionAnswer } from "./companion-answer-repair.ts";
import { assembleCompanionStepRequest, companionStepPolicyText, companionStepToolSurface, companionWebSearchAllowedForStep } from "./companion-agent-step-assembly.ts";
import { companionInitiativeInterpretationFields, renderCompanionInitiativeObservation } from "./companion-initiative-observation.ts";
import { createdNoteToolResult, readCreatedNoteReceipt, userForbidsNoteLibraryRead } from "./companion-note-authoring.ts";
import { EagerDispatchScheduler } from "./companion-eager-scheduler.ts";
import {
  EAGER_TOOL_DISPATCH_ENABLED,
  EAGER_DISPATCH_ELIGIBLE_TOOLS,
  eagerDispatchOne,
} from "./companion-eager-dispatch-config.ts";
import { eagerCommitRecheck, type StreamToolCallSlot } from "./companion-eager-dispatch.ts";
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

type AgentMessage = AgentTurnRequest["messages"][number];

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
  const deadlineAt = Math.min(handlerDeadlineAt, contractDeadlineAt);
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
  const availableDefinitions = resolveAllCompanionAgentTools(meta.permissionLevel, event.constraints).filter(definition => {
    if (definition.name === "companion_publish_utterance" && completeNoteReply) return false;
    if (definition.name === "companion_write_annotation" && !writingAnnotation) return false;
    if (definition.name === "companion_finish_participation" && !args.read.initiativeInput) return false;
    return !args.read.initiativeInput || isCompanionAutonomousTool(definition.name)
      || (definition.riskClass === "read" && !["companion_open_page", "companion_open_note", "companion_open_card"].includes(definition.name));
  });
  // 空工具面只有一种来路：权限档读不出来（合法档位下读类工具总在）。这时**不说**才是坏事——
  // 她会一脸无辜地答"我手上没有这个入口"，用户看到的是她突然不会用工具，而不是账号状态有问题。
  if (availableDefinitions.length === 0)
    throw new Error(`companion tool surface resolved empty for permission "${String(meta.permissionLevel)}"`);
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
      onReceipt: (receipt) => logger.info({ runId: args.read.runId,
        providerId: args.provider.id, modelId: args.provider.modelId, ...receipt },
      "companion interpretation settled; failure metadata contains no conversation or provider text"),
    });
  const attentionPromise = attentionResult.then(async (attention) => {
    // Persist any explicit account preference before the speculative stream's release gate opens.
    const voicePreferenceWrite = await args.onTurnInterpretation?.(attention);
    return voicePreferenceWrite ? { ...attention, voicePreferenceWrite } : attention;
  });

  const dialogueHistory = args.baseMessages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content } as AgentMessage));
  /**
   * 主动参与按**对话**装配（2026-10-13）：历史就是真实的 user/assistant 回合，宿主报告的时刻
   * 是一条带 hostObservation 的 system 观察消息，排在历史之后。原来这两样被压成一个 JSON 块、
   * 历史塞进 `recentDialogue` 字段，她读到的是"关于这段聊天的材料"，接不出上一句是谁说的、
   * 隔了多久——那正是"像个人一样接着聊"最需要的两层。
   *
   * 回放的是 role+content 两份纯文本（`companion-context-handoff.ts:312` 已经把工具与思考句柄
   * 剥掉），不带上一轮运行的句柄；观察消息压在末尾，避免出现"以 assistant 结尾"的那一类
   * provider 要求。跨运行句柄的旧错误来自把上一轮当本轮草稿，不是来自历史本身。
   */
  let messages = [...dialogueHistory];
  const initiativeObservation = args.read.initiativeInput
    ? { role: "system" as const, hostObservation: true as const,
      content: renderCompanionInitiativeObservation(args.read.initiativeInput) }
    : null;
  const currentRequest = initiativeObservation
    ?? [...messages].reverse().find((message) => message.role === "user");
  if (!currentRequest) throw new Error("companion turn is missing its current user request");
  if (initiativeObservation) messages.push(initiativeObservation);

  /**
   * 两条投机（闲聊形状 + 提问形状）现在就出发，分类器不等。发与收的细节、
   * 入场条件与"为什么走流式"都写在 `companion-speculative-flights.ts`；
   * 攒住/作废由 `runStreamingAgentStep` 的 `releaseGate` 执行，留哪一版在下面定。
   */
  const speculativeFlights = startCompanionSpeculativeFirstSteps({
    provider: args.provider,
    ctxSignal: args.ctx.signal,
    onProviderDelta: args.onProviderDelta,
    ...(args.onReasoningDelta ? { onReasoningDelta: args.onReasoningDelta } : {}),
    attention: attentionPromise,
    cachedInterpretation,
    turnPolicy: typeof args.baseMessages[0]?.content === "string" ? args.baseMessages[0].content : "",
    permissionLevel: meta.permissionLevel,
    stepBudget: budget.maxSteps ?? Infinity,
    messages,
    deadlineAt,
    availableTools: availableDefinitions
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
    webSearchAllowed: meta.webSearchEnabled === true && event.constraints.webSearchEnabled === true
      && (budget.maxWebSearchCalls == null || budget.maxWebSearchCalls > 0) && webSearchServiceAvailable(),
    toolCallCount: meta.toolCallCount,
  });
  const attention = await attentionPromise;
  /**
   * 把她自己那些"用户这句没接的收尾"降级成记录（判据与实测见 `renderPendingOffersAsRecords`）。
   *
   * 索引空间就是这里的 `messages`：分类器那侧按"去掉 system 之后"的位置编号，这一份也是，
   * 所以中间不需要换算——换算一次就是两套编号，迟早对不上。
   *
   * 位置在投机那步**之后**是故意的：投机的请求早已按未改写的消息发出去了，只有
   * `shouldKeepSpeculativeFirstStep` 保证"有待收的账就整版作废"，两者才不会各说一套。
   * 交接快照里存的仍是改写前的基线；重试时同一份 `turn_interpretation` 已落库，
   * 降级按同样的索引重放一次，输出逐字一致。
   */
  messages = renderPendingOffersAsRecords(messages, attention.pendingOfferIndexes);
  let prefetchedFirstStep = await speculativeFlights.settle({
    attention, runId: args.read.runId, deadlineAt, handlerStartedAtMs,
  });
  const toolIntent = attention.toolUse === "none" ? false : attention.toolUse === "uncertain" ? null : true;
  const userRequiresTool = companionStepRequiresTool(toolIntent);
  const userAskedForAction = attention.toolUse === "act";
  /**
   * 工具面只由声明决定：权限档 + 数据外发政策，也就是 `resolveAllCompanionAgentTools`
   * 给出的那一份（它自己的注释：Exposure is a view of the project catalog, filtered by
   * current permissions and data-egress policy）。**本轮意图不再参与筛选。**
   *
   * 原来这里按 `attention.toolUse === "act"` 才留写类工具，于是分类器的一次猜测成了
   * 能力总闸。2026-10-09 线上：用户说「生成一片新笔记…然后开启共享」，共享没有对应能力，
   * 分类器因此记下一条歧义，`resolveAgentTurnInterpretation` 把 act 降成 uncertain
   * （agent-core/runtime/attention.ts:40），于是 `companion_create_note` 整批被摘——
   * **一个做不到的请求否掉了做得到的那个**。她照着自己那一份工具清单如实回答"我手上没有
   * 新建笔记的入口"，下一轮单句请求时工具又在了，于是当众改口。本地 159 轮里 28.2% 的轮次
   * 写类工具为空，另有 5 轮分类器自己点名了写操作却被摘。
   *
   * 摘工具从来没能真正拦住误写：要不要动数据由 `riskClass`、`requiresConfirmation`
   * 与提案确认门在执行侧判（`companion-tool-execution.ts` 还会复核这轮是否真的给过）。
   * 意图仍然有用，它管的是开不开思考、闲聊还是办事的语气，见下面。
   */
  const definitions = availableDefinitions;
  const toolDefinitions = definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  // steer 时要**点名**该调哪个工具：小模型对"你去调用工具"这种泛指不敏感，
  // 对"调用 companion_search_notes"会照做（只列读类，且限 10 个免得提示比正文还长）。
  const steerableReadTools = steerableToolNames(definitions, "lookup");
  // action 那一支以前没有名字可点（只有泛指文案），实机 2026-09-22 场景 T 就是在这儿翻车的：
  // 用户说「以后别主动催我复习」，她两步都只回"我记下了"，`companion_set_boundary` 一次没调。
  const steerableActionTools = steerableToolNames(definitions, "action");
  // 只点名本轮解释**自己指出**的那些写操作。`companionActionResultRecorded` 拿这份判
  // "她声称的动作是否已有回执"，把全部写工具塞进去等于让任意一次写替这次声称作证。
  // 一个都没点名时留空：纠正指令会退回 `steerableActionTools`（见 step-plan 那条 fallback），
  // 宁可多 steer 一次，也不要放过一句没做过的事。
  const requestedActionTools = attention.candidateOperations.filter(name => definitions.some(
    definition => definition.name === name && definition.riskClass !== "read"));
  const providerCapabilities = args.provider.getCapabilities?.();
  const providerCapabilityFingerprint = sha256Utf8V1(canonicalJsonV1({
    capabilityFingerprint: providerCapabilities?.fingerprint ?? null,
    toolMode: providerCapabilities?.toolMode ?? null,
    contextWindowTokens: providerCapabilities?.contextWindowTokens ?? null,
    providerId: args.provider.id,
    modelId: args.provider.modelId,
    tools: toolDefinitions.map((tool) => tool.name),
  }));
  const capabilitySnapshot = companionAgentCapabilitySnapshotV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    level: meta.permissionLevel,
    offeredTools: definitions.map(({ name, toolVersion, riskClass }) => ({ name, toolVersion, riskClass })),
  });
  await updateRunMeta(event, {
    permissionLevel: meta.permissionLevel,
    permissionSnapshot: capabilitySnapshot,
    turnInterpretation: attention,
    budgetSnapshot: budget,
    providerCapabilityFingerprint,
    elapsedMsDelta: elapsedDelta(),
    // 装配回执随预算一起落库（44 §3.3）。没有它，`budget_omitted` 只存在于日志。
    ...args.contextReceipts?.runMetaPatch(),
  });

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
  // 历史摘要与当前工具工作状态在请求压力出现时压缩；原始交接快照、步骤
  // 与工具账本保留完整证据，恢复时可重新读取。
  let compactionRequest: AgentTurnRequest | null = null;
  let compactionProvider = args.provider;
  let historyFoldApplied = false;
  const sendWithBoundedCompaction = boundedStepSender({
    beginRequest: request => {
      compactionRequest = request as AgentTurnRequest;
      args.contextReceipts?.beginRequest(auditHash(request));
    },
    fold: async replay => {
      // replayFold indexes the original history. Once folded, those positions
      // no longer identify the same messages and must never be reused.
      const history = historyFoldApplied ? null : args.replayFold?.(replay) ?? null;
      if (history) historyFoldApplied = true;
      const pressure = args.contextReceipts?.latestPressure();
      if (!compactionRequest || !pressure) {
        if (history) messages = [...history.messages];
        return history;
      }
      try {
        const active = await compactActiveToolContext({
          request: { ...compactionRequest, messages: [...history?.messages ?? replay] },
          targetInputTokens: pressure.targetTokens,
          maxOutputTokens: companionStepOutputCeiling(compactionProvider),
          ...(compactionProvider.countTextTokens ? { countTokens: (text: string) => compactionProvider.countTextTokens!(text) } : {}),
          summarize: createWorkingStateSummarizer(compactionProvider,
            { signal: args.ctx.signal, deadlineAt }),
        });
        const folded = active ?? history;
        if (folded) messages = [...folded.messages];
        return folded;
      } catch (error) {
        if (args.ctx.signal.aborted) throw error;
        logger.warn({ runId: args.read.runId, err: error }, "active tool context compaction failed; preserving original evidence");
        if (history) messages = [...history.messages];
        return history;
      }
    },
    hasAttempt: () => args.contextReceipts?.hasCompactionAttempt() ?? false,
    // 额度在每次重发之前消耗（companion-compaction.ts 的两条重发路径都会调）；
    // 折成功与折不动都算用掉本轮那一次，闸随后按 over_trigger_line 放行。
    consumeAttempt: () => args.contextReceipts?.consumeCompactionAttempt(),
    ...(args.compactionCooldown ? { cooldown: args.compactionCooldown } : {}),
    onCompacted: (receipt) => {
      const pressure = args.contextReceipts?.latestPressure() ?? null;
      args.compactionTrace?.record({
        ...receipt,
        modelId: pressure?.modelId ?? null,
        inputTokens: pressure?.inputTokens ?? null,
        triggerTokens: pressure?.triggerTokens ?? null,
        hardInputTokens: pressure?.hardInputTokens ?? null,
        reason: pressure?.reason ?? null,
        at: new Date().toISOString(),
      });
      logger.warn({ runId: args.read.runId, stepCount, ...receipt },
        "context pressure folded the replay tail already covered by a verified summary");
    },
  });
  const contextText = companionNumericEvidenceContext(args.baseMessages);
  if (args.continuationProposalId) {
    messages = await loadContinuation(event, messages, args.continuationProposalId, deadlineAt);
  }
  let stepCount = resolveAgentStepCountForResume(meta);
  const resumedStepCount = stepCount;
  let toolCallCount = meta.toolCallCount;
  event.verifyUtterance = text => {
    if (visibleSegments.some(segment => segment.trim()))
      throw new CompanionToolNotExecutedError("这轮已经开始连续回复，请接着把当前回复完成。需要分几句交流时，从第一句使用发言能力，避免正文和发言重复。");
    const checked = reviewCompanionStepCorrection({ said: text, contextText, messages, turnToolUse: attention.toolUse,
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
  const visibleSegments: string[] = [];
  /** 与 visibleSegments 一一对应：该段是否已经流式下发过（E 去重的安全性判据）。 */
  const visibleSegmentDelivered: boolean[] = [];
  /** 本轮工具结果带出的富块（nav / quote…），随终态消息落进 `companion_messages.blocks`。 */
  const richBlocks: CompanionContentBlockV1[] = [];
  let webSearchCalls = 0;
  const richBlockKeys = new Set<string>();
  const pushRichBlock = (block: CompanionContentBlockV1) => {
    const key = canonicalJsonV1(block);
    if (richBlockKeys.has(key)) return;
    richBlockKeys.add(key);
    richBlocks.push(block);
  };
  if (meta.toolCallCount > 0) {
    for (const result of await readCompanionWebSearchReceipts({ workspaceId: args.ctx.workspaceId, userId: args.read.userId }, args.read.runId)) {
      webSearchCalls++;
      for (const block of webSearchCitationBlocks(result)) pushRichBlock(block);
      if (result.status === "unavailable") event.constraints.webSearchEnabled = false;
    }
  }
  /** 退化回复闸每轮至多触发一次（2026-09-19 深夜，tokenrhythm 退化窗口实测）。 */
  let degenerateRetried = false;
  /** "让她做件事却没落地"闸每轮至多一次：补一步就够，不把她逼成循环。 */
  let actionSteerAttempts = 0;
  let quoteCorrectionUsed = false;
  /**
   * "她说查过了、其实没查"单独一条额度（下面闸的注释说为什么不能共用）。
   */
  let lookupClaimSteered = false;
  /** steer 之后紧跟的那一步换哪个 provider（见下面 stepProvider 的选取）。 */
  let steerSwapToFallback = false;
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
  /** No default step cap. An explicit deployment policy remains auditable. */
  const stepBudget = budget.maxSteps ?? Infinity;
  return executeTurn<CompanionAgentLoopResult>({
    signal: args.ctx.signal, now: Date.now,
    limits: () => ({ maxSteps: stepBudget - resumedStepCount, deadlineAt }),
    budgetError: () => new CompanionAgentBudgetExceededError("companion agent step budget exceeded"),
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
    // The last allowed step withholds tools so the model must answer instead of
    // opening another tool round. Without this the loop could exhaust its step
    // budget with a tool call and throw "step budget exceeded" — the user would
    // lose the whole turn with no assistant.final. It also guarantees a write
    // tool can never be proposed on the final step, so a confirmation always
    // leaves at least one step to report the result back.
    const finalAnswerOnly = stepCount >= stepBudget;
    // 工具面、执行政策与请求装配这三样的判据在 `companion-agent-step-assembly.ts`。
    const { tools: toolsOfferedThisStep, toolChoice: toolChoiceThisStep } = companionStepToolSurface({
      toolDefinitions,
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
      toolCount: toolDefinitions.length,
      stepBudget,
      finalAnswerOnly,
      attentionIntent: attention.intent,
      offeredToolNames: toolsOfferedThisStep.map((tool) => tool.name),
      writingAnnotation,
      completeNoteReply,
    });
    /**
     * 第一步可能已经有现成的：投机的闲聊版（见上面的 speculative）。
     * 分类器确认没有需要改写历史或补入注意力对象的内容，才复用这版闲聊请求。
     */
    const prefetched = prefetchedFirstStep !== null && stepCount === resumedStepCount + 1 ? prefetchedFirstStep : null;
    if (prefetched) prefetchedFirstStep = null;
    let stepRequest: AgentTurnRequest = assembleCompanionStepRequest({
      turnPolicy: typeof args.baseMessages[0]?.content === "string" ? args.baseMessages[0].content : "",
      runtimePolicy,
      executionGuidance: responseStrategy.guidance,
      attention,
      messages,
      tools: toolsOfferedThisStep,
      toolChoice: toolChoiceThisStep,
      disableThinking: turnThinking.disableThinking,
      provider: args.provider,
      temperature: responseStrategy.temperature,
      prefetchedRequest: prefetched?.request ?? null,
    });
    const stepId = await persistStep(event, stepCount, auditHash(stepRequest));
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
    // 当前用户要求主/备用均固定 DeepSeek，选择备用槽不再意味着换成另一种模型。
    let stepProvider = steerSwapToFallback
      && typeof args.fallbackProvider?.executeAgentTurn === "function"
      ? args.fallbackProvider
      : args.provider;
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
    const runModelStepTask = (
      provider: AIProvider,
      request: AgentTurnRequest,
      signal: AbortSignal,
      execute: (taskSignal: AbortSignal) => Promise<AgentTurnResult>,
      timeoutMs = resolveProviderCallTimeout("companion_agent"),
    ): Promise<AgentTurnResult> => {
      const taskTimeoutMs = Math.min(timeoutMs, deadlineAt - Date.now());
      if (taskTimeoutMs <= 0) {
        throw new CompanionAgentBudgetExceededError("companion agent deadline exceeded before model step");
      }
      return runCompanionAgentModelStep({
        job: args.ctx,
        runId: args.read.runId,
        stepId,
        userId: args.read.userId,
        permissionLevel: meta.permissionLevel,
        request,
        provider,
        signal,
        timeoutMs: taskTimeoutMs,
        currentActiveTransaction: currentWorkerWorkspaceTransaction,
        verifyAttempt: async attempt => {
          if (!(await isJobLeaseActive({ ...args.ctx, leaseToken: attempt.leaseToken }))) return false;
          await withWorkerWorkspaceTransaction({ workspaceId: args.ctx.workspaceId, userId: args.read.userId },
            tx => assertCompanionContextSourcesCurrent(tx, { workspaceId: args.ctx.workspaceId, userId: args.read.userId }, args.read.runId));
          return true;
        },
        checkpoint: createCompanionAgentStepCheckpointPort(event, stepId),
        execute,
      });
    };
    let result;
      const eagerScheduler = EAGER_TOOL_DISPATCH_ENABLED
        ? new EagerDispatchScheduler({
          dispatch: (slot: StreamToolCallSlot) => eagerDispatchOne(event, stepId, slot, deadlineAt, {
            ...args,
            // 提交前复查（40b §4.1-1 / A76）：取消、租约失效、权限撤销与
            // 账号世代变化都会把这一格挡在提交之外。带副作用的一律落
            // `outcome_unknown` —— **不假回滚**（§3.2）。
            //
            // 为什么在这里现查而不是看循环开头那份快照：这两件事之间可能过去
            // 好几秒（流式一整轮），用户点取消就是在这中间发生的。
            commitGuard: async () => {
              const recheck = eagerCommitRecheck({
                // 撤权/世代变化：与循环开头那次同一条判据现查一遍。
                revoked: await readRunMeta(event).then(
                  (meta) => !meta.globalEnabled || meta.currentAccountEpoch !== args.read.accountEpoch,
                ),
                cancelled: event.ctx.signal.aborted,
                leaseLost: !isJobLeaseActive({ ...args.ctx, leaseToken: args.ctx.leaseToken }),
                // 白名单里目前全是只读工具，所以带副作用的这一支还不会走到。
                // 留着这个参数是有意的：白名单将来放宽时，这里**已经是**正确的形状，
                // 不需要再改一次（40b §1.5「补救机制的退出条件要事先写清」）。
                hasSideEffect: false,
              });
              if (!recheck.commit) {
                throw new Error(`eager dispatch commit recheck: ${recheck.status}`);
              }
            },
          }),
          decision: {
            eligibleTools: EAGER_DISPATCH_ELIGIBLE_TOOLS,
            // 确认门（A58）：第 N 格要用户确认时，第 N+1 格的只读也不能提前跑。
            // 不传这一项时判据认不出确认门，等于赌序号缺口里是空的。
            requiresConfirmation: (name: string) =>
              getCompanionAgentTool(name)?.requiresConfirmation === true,
          },
          onError: (slot: { name: string; index: number }, error: unknown) => logger.warn(
            { runId: args.read.runId, tool: slot.name, index: slot.index, err: error },
            "companion eager tool dispatch failed",
          ),
        })
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
        && !utterancePublished
        && typeof stepProvider.chatCompletionStream === "function"
        && (finalAnswerOnly || stepRequest.tools.length === 0 || stepProvider.chatCompletionStreamToolCalls === true);
      compactionProvider = stepProvider;

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
              // Action steps stream tool progress while keeping prose private
              // until the completed call and its actual outcome are known.
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
      await preparation.finish(result.toolCalls ?? []);
    } catch (error) {
      await preparation.finish([]).catch(preparationError => logger.warn(
        { runId: args.read.runId, err: preparationError }, "companion tool preparation could not be settled"));
      if (eagerScheduler) await eagerScheduler.close(true);
      // 归因：run 预算耗尽（含 handler abort —— 它的 signal 就是 args.ctx.signal）
      // 必须与 provider 故障区分开，否则运维无法从错误码看出"真超时"。
      const deadlineExceeded = Date.now() >= deadlineAt || args.ctx.signal.aborted;
      await finishStep(
        event,
        stepId,
        "failed",
        undefined,
        deadlineExceeded ? "AGENT_DEADLINE_EXCEEDED" : "PROVIDER_UNAVAILABLE",
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
        await finishStep(event, stepId, "succeeded", sha256Utf8V1(""));
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
    // Repair incomplete drafts first. Every surviving explanation then takes
    // complete delivery guards; a repaired draft cannot bypass them.
    if (result.finishReason === "length") {
      // A capped response is incomplete even if it contains a tool call. Do not
      // dispatch more actions or publish it as a successful final answer.
      const prefix = typeof result.content === "string" ? result.content : "";
      if (!stepEmitted && prefix.length > 0 && args.onProviderDelta) {
        const separator = visibleSegmentDelivered.some(Boolean) ? VISIBLE_SEGMENT_SEPARATOR : "";
        if (!(await args.onProviderDelta(separator + prefix))) {
          throw new CompanionStreamStoppedError("companion incomplete output delivery stopped");
        }
      }
      await finishStep(event, stepId, "failed", sha256Utf8V1(prefix), "AGENT_BUDGET_EXCEEDED");
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      throw new AgentOutputError("output_truncated", "companion answer reached its output ceiling");
    }
    if (finalAnswerOnly && calls.length > 0) {
      await finishStep(event, stepId, "failed", undefined, "AGENT_TOOL_CALL_LIMIT");
      throw new CompanionAgentBudgetExceededError("configured step limit reached before task completion");
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
      actionSteerAttempts,
      lookupClaimSteered,
      quoteCorrectionUsed,
    });
    if (steerPlan.steer || correctQuote) {
      if (correctQuote) quoteCorrectionUsed = true;
      if (steerPlan.consumeAction) actionSteerAttempts += 1;
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
      await finishStep(event, stepId, "succeeded", sha256Utf8V1(said));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      logger.warn(
        {
          runId: args.read.runId,
          stepCount,
          chars: said.trim().length,
          claims: unverifiedClaims.slice(0, 4),
          // 五种起因分开报（39b §9.6）。`by` 是唯一的区分口径——正文那句曾经写死成
          // "answered an action request"，于是 `unverified-numbers`（编了没出处的数）
          // 和 `promise-shape`（承诺了没做事）也被读成"动作请求"，按日志归因会归错。
          by: correctQuote ? "unverified-quotes"
            : unverifiedClaims.length > 0 ? "unverified-numbers"
            : unverifiedQuotes.length > 0 ? "unverified-quotes"
            : lookupClaim ? (nothingDueClaim ? "claimed-nothing-due" : "claimed-lookup")
            : userAskedForAction ? "action-request" : "promise-shape",
        },
        "companion agent step needs a steer; cause in `by`",
      );
      return { kind: "continue" };
    }
    // 一次纠正的额度限制生成次数，不能把仍不匹配的原文引用降为成功终答。
    if (calls.length === 0 && unverifiedQuotes.length > 0) {
      await finishStep(event, stepId, "failed", sha256Utf8V1(said), "UNVERIFIED_QUOTE");
      throw new AgentOutputError("unverified_quote", "companion quote does not match the available source after correction");
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
      await finishStep(event, stepId, "succeeded", sha256Utf8V1(text));
      await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
        ...args.contextReceipts?.runMetaPatch() });
      return { kind: "settled", result: { status: "completed", text, blocks: richBlocks, memoryRefs: [] } };
    }
    if (budget.maxToolCallsPerStep !== null && calls.length > budget.maxToolCallsPerStep) {
      await finishStep(event, stepId, "failed", undefined, "AGENT_TOOL_CALL_LIMIT");
      throw new Error("too many tool calls in one agent step");
    }
    // 带工具的一步：这一步的 content 是**开场白**（"我先看看你的笔记"），不是终答。
    // 它已经随流式下发（④-b），因此必须留在可见正文里——否则客户端累积的草稿
    // 会与最终 assistant 消息对不上（见 joinVisibleSegmentsDeduped 的说明）。
    if (stepEmitted && typeof result.content === "string" && result.content.length > 0) {
      visibleSegments.push(result.content);
      visibleSegmentDelivered.push(true);
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
    for (const call of calls) {
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
          content: JSON.stringify({ ok: false, status: rejected.modelStatus, error: parsedArgs.reason }),
        });
        continue;
      }
      const serializedArgs = canonicalJsonV1(parsedArgs.data);
      const argsHash = sha256Utf8V1(serializedArgs);
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
          await finishStep(event, stepId, "waiting");
          await updateRunMeta(event, {
            stepCount,
            toolCallCount,
            elapsedMsDelta: elapsedDelta(),
            status: "waiting_for_confirmation",
            waitingProposalId: record.proposalId,
          });
          return { kind: "settled", result: { status: "waiting_for_confirmation", proposalId: record.proposalId, memoryRefs: [] } };
        }
        if (record.status === "succeeded") {
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
      if (record.isNew && budget.maxToolCalls !== null && toolCallCount >= budget.maxToolCalls) {
        await updateToolCall(event, operationCallId, {
          status: "blocked",
          safeSummary: "已达到本次 Agent 的工具调用上限",
        });
        await finishStep(event, stepId, "failed", undefined, "AGENT_BUDGET_EXCEEDED");
        throw new CompanionAgentBudgetExceededError("companion agent tool budget exceeded");
      }
      // Only a first-time call consumes budget: a replay was already counted
      // when the fence row was created (readRunMeta derives toolCallCount from
      // GREATEST(run column, COUNT(tool calls))).
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
        await finishStep(event, stepId, "waiting");
        await updateRunMeta(event, { stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
          ...args.contextReceipts?.runMetaPatch(), status: "waiting_for_confirmation", waitingProposalId: run.proposalId });
        return { kind: "settled", result: { status: "waiting_for_confirmation", proposalId: run.proposalId, memoryRefs: [] } };
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
    await finishStep(event, stepId, "succeeded", auditHash(messages.slice(-calls.length)));
    await updateRunMeta(event, {
      stepCount, toolCallCount, elapsedMsDelta: elapsedDelta(),
      // 收尾这一次带上预算读数：它是**最后一次真实发送**的口径（44 §4）。
      ...args.contextReceipts?.runMetaPatch(),
    });
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
      return { kind: "settled", result: { status: "completed", text: utterancePublished ? "" : said.trim(), blocks: richBlocks, memoryRefs: [] } };
    }
    if ((closesSilently || closesSpeech) && succeededCalls) {
      return { kind: "settled", result: { status: "completed", text: "", blocks: richBlocks, memoryRefs: [] } };
    }
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
  companionStepCorrectionMessages,
  reviewCompanionStepCorrection,
  stepHoldChars,
  type CompanionAgentLoopResult,
} from "./companion-step-plan.ts";

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
