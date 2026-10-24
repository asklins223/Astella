import { agentTurnInterpretationV1Schema } from "@astella/shared/agent-contracts";
import {
  COMPANION_AGENT_CONTRACT_VERSION,
  companionAgentCapabilitySnapshotV1Schema,
  resolveAllCompanionAgentTools,
  resolveCompanionInitialToolNames,
  type AgentTurnRequest,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { companionStepRequiresTool, steerableToolNames } from "../tools/companion-tool-call-ledger.ts";
import { renderPendingOffersAsRecords } from "../context/companion-context-handoff.ts";
import { bindHistoryForCompaction } from "../context/companion-history-pressure-compaction.ts";
import { startCompanionSpeculativeFirstSteps } from "../agent/companion-speculative-flights.ts";
import { loadCompanionRuntimeCheckpoint } from "../agent/companion-runtime-checkpoint.ts";
import { updateRunMeta, readRunMeta } from "../agent/companion-agent-events.ts";
import { companionExecutionPolicy } from "../agent/companion-execution-policy.ts";
import { webSearchServiceAvailable } from "../../agent/web-search.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import { explicitCompanionProductRequest, explicitlyRequestsUtterances } from "../tools/companion-tool-intent.ts";
import { companionRequestRequirements } from "./companion-request-requirements.ts";

/**
 * 回合前段：投机器出发、注意力落定、历史绑定、工具面与能力快照（44 §3.3 装配回执）。
 *
 * 为什么搬出来（2026-10-15 神文件棘轮）：这一段回答「这一轮**装什么**」——投机形状、
 * 注意力、工具面、能力快照；循环回答「这些步**怎么走**」。它只写两处运行时状态
 * （messages 的待收账降级、updateRunMeta 回执），其余全是取值与快照，彼此无时序纠缠。
 * 纯搬运：判据、投机入场条件与工具面装配一字未改；messages 用访问器接进去。
 */
export interface CompanionTurnPreambleDeps {
  loopArgs: CompanionAgentLoopArgs;
  event: AgentEventContext;
  meta: Awaited<ReturnType<typeof readRunMeta>>;
  budget: ReturnType<typeof companionExecutionPolicy>;
  availableDefinitions: ReturnType<typeof resolveAllCompanionAgentTools>;
  dialogueHistory: AgentTurnRequest["messages"];
  recovered: Awaited<ReturnType<typeof loadCompanionRuntimeCheckpoint>>;
  attentionPromise: Promise<ReturnType<typeof agentTurnInterpretationV1Schema.parse>>;
  cachedInterpretation: ReturnType<typeof agentTurnInterpretationV1Schema.parse> | null;
  handlerStartedAtMs: number;
  deadlineAt: number;
  elapsedMsDelta: number;
  getMessages: () => AgentTurnRequest["messages"];
  setMessages: (messages: AgentTurnRequest["messages"]) => void;
}

export async function settleCompanionTurnPreamble(deps: CompanionTurnPreambleDeps) {
  const {
    provider, ctx, onProviderDelta, onReasoningDelta, baseMessages, read, contextReceipts, historyForCompaction,
  } = deps.loopArgs;
  const { event } = deps;
  const pageKind = (read.pageContext as { context?: { pageKind?: string } } | null)?.context?.pageKind ?? null;
  /**
   * Speculation must use the same reduced surface as the formal first step.
   * It starts before the classifier lands, so it cannot see candidate groups;
   * core + page groups is the honest superset for a clean turn. A prefetched
   * tool call from a candidate group is admitted by the runtime afterwards.
   */
  const speculativeNames = resolveCompanionInitialToolNames({
    availableToolNames: deps.availableDefinitions.map(definition => definition.name),
    pageKind,
    hasImageAttachments: Boolean(read.userImageAttachments?.length),
  });
  const speculativeTools = deps.availableDefinitions
    .filter(definition => speculativeNames.has(definition.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));

  /**
   * 两条投机（闲聊形状 + 提问形状）现在就出发，分类器不等。发与收的细节、
   * 入场条件与"为什么走流式"都写在 `companion-speculative-flights.ts`；
   * 攒住/作废由 `runStreamingAgentStep` 的 `releaseGate` 执行，留哪一版在下面定。
   */
  const speculativeFlights = startCompanionSpeculativeFirstSteps({
    allowSpeculation: !read.userImageAttachments?.length && !explicitCompanionProductRequest(read.userText).newNote
      && !explicitCompanionProductRequest(read.userText).artifact && !companionRequestRequirements(read.userText).characters
      && !explicitlyRequestsUtterances(read.userText),
    provider: provider,
    ctxSignal: ctx.signal,
    onProviderDelta: deps.recovered ? undefined : onProviderDelta,
    ...(onReasoningDelta ? { onReasoningDelta: onReasoningDelta } : {}),
    attention: deps.attentionPromise,
    cachedInterpretation: deps.cachedInterpretation,
    turnPolicy: typeof baseMessages[0]?.content === "string" ? baseMessages[0].content : "",
    permissionLevel: deps.meta.permissionLevel,
    stepBudget: deps.budget.maxSteps ?? Infinity,
    messages: deps.getMessages(),
    deadlineAt: deps.deadlineAt,
    availableTools: speculativeTools,
    webSearchAllowed: deps.meta.webSearchEnabled === true && event.constraints.webSearchEnabled === true
      && (deps.budget.maxWebSearchCalls == null || deps.budget.maxWebSearchCalls > 0) && webSearchServiceAvailable(),
    toolCallCount: deps.meta.toolCallCount,
    releaseRouter: deps.loopArgs.releaseRouter,
  });
  const attention = await deps.attentionPromise;
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
  if (!deps.recovered) deps.setMessages(renderPendingOffersAsRecords(deps.getMessages(), attention.pendingOfferIndexes));
  // The current host observation was appended after the frozen dialogue. It
  // must remain in the request, but is not part of the historical binding.
  const historyBinding = bindHistoryForCompaction(historyForCompaction, deps.dialogueHistory,
    deps.getMessages().slice(0, deps.dialogueHistory.length));
  let prefetchedFirstStep = await speculativeFlights.settle({
    attention, runId: read.runId, deadlineAt: deps.deadlineAt, handlerStartedAtMs: deps.handlerStartedAtMs,
  });
  const toolIntent = attention.toolUse === "none" ? false : attention.toolUse === "uncertain" ? null : true;
  const userRequiresTool = companionStepRequiresTool(toolIntent,
    attention.toolUse === "read" ? attention.candidateOperations : undefined);
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
  const definitions = deps.availableDefinitions;
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
  const providerCapabilities = provider.getCapabilities?.();
  const providerCapabilityFingerprint = sha256Utf8V1(canonicalJsonV1({
    capabilityFingerprint: providerCapabilities?.fingerprint ?? null,
    toolMode: providerCapabilities?.toolMode ?? null,
    contextWindowTokens: providerCapabilities?.contextWindowTokens ?? null,
    providerId: provider.id,
    modelId: provider.modelId,
    tools: toolDefinitions.map((tool) => tool.name),
  }));
  const capabilitySnapshot = companionAgentCapabilitySnapshotV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    level: deps.meta.permissionLevel,
    offeredTools: definitions.map(({ name, toolVersion, riskClass }) => ({ name, toolVersion, riskClass })),
  });
  await updateRunMeta(event, {
    permissionLevel: deps.meta.permissionLevel,
    permissionSnapshot: capabilitySnapshot,
    turnInterpretation: attention,
    budgetSnapshot: deps.budget,
    providerCapabilityFingerprint,
    elapsedMsDelta: deps.elapsedMsDelta,
    // 装配回执随预算一起落库（44 §3.3）。没有它，`budget_omitted` 只存在于日志。
    ...contextReceipts?.runMetaPatch(),
  });

  return {
    attention,
    prefetchedFirstStep,
    historyBinding,
    userRequiresTool,
    userAskedForAction,
    definitions,
    toolDefinitions,
    steerableReadTools,
    steerableActionTools,
    requestedActionTools,
    capabilitySnapshot,
  };
}
