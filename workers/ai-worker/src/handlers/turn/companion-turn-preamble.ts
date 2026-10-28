import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import {
  COMPANION_AGENT_CONTRACT_VERSION,
  COMPANION_DOMAIN_ACTIONS,
  companionDomainOperation,
  companionAgentCapabilitySnapshotV1Schema,
  resolveAllCompanionAgentTools,
  type AgentTurnRequest,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { companionStepRequiresTool, steerableToolNames } from "../tools/companion-tool-call-ledger.ts";
import { renderPendingOffersAsRecords } from "../context/companion-context-handoff.ts";
import { bindHistoryForCompaction } from "../context/companion-history-pressure-compaction.ts";
import { loadCompanionRuntimeCheckpoint } from "../agent/companion-runtime-checkpoint.ts";
import { updateRunMeta, readRunMeta } from "../agent/companion-agent-events.ts";
import { companionExecutionPolicy } from "../agent/companion-execution-policy.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import type { CompanionAgentLoopArgs } from "../../contracts/companion-agent-loop.ts";
import { companionRequestsAction } from "./companion-step-plan.ts";

/**
 * 回合前段：注意力落定、历史绑定、工具面与能力快照（44 §3.3 装配回执）。
 *
 * 它只写两处运行时状态（messages 的待收账降级、updateRunMeta 回执），其余全是
 * 取值与快照。工具面只由声明决定，不按本轮意图裁剪。
 */
export interface CompanionTurnPreambleDeps {
  loopArgs: CompanionAgentLoopArgs;
  event: AgentEventContext;
  meta: Awaited<ReturnType<typeof readRunMeta>>;
  budget: ReturnType<typeof companionExecutionPolicy>;
  availableDefinitions: ReturnType<typeof resolveAllCompanionAgentTools>;
  dialogueHistory: AgentTurnRequest["messages"];
  recovered: Awaited<ReturnType<typeof loadCompanionRuntimeCheckpoint>>;
  /** The turn's attention record, already settled by the entry. */
  attention: AgentTurnInterpretationV1;
  elapsedMsDelta: number;
  getMessages: () => AgentTurnRequest["messages"];
  setMessages: (messages: AgentTurnRequest["messages"]) => void;
}

export async function settleCompanionTurnPreamble(deps: CompanionTurnPreambleDeps) {
  const { contextReceipts, historyForCompaction } = deps.loopArgs;
  const { event } = deps;
  const attention = deps.attention;
  /**
   * 把她自己那些"用户这句没接的收尾"降级成记录（判据与实测见 `renderPendingOffersAsRecords`）。
   * 索引空间就是这里的 `messages`，中间不需要换算——换算一次就是两套编号，迟早对不上。
   * 交接快照里存的仍是改写前的基线；重试时同一份记录按同样的索引重放一次，输出逐字一致。
   */
  if (!deps.recovered) deps.setMessages(renderPendingOffersAsRecords(deps.getMessages(), attention.pendingOfferIndexes));
  // The current host observation was appended after the frozen dialogue. It
  // must remain in the request, but is not part of the historical binding.
  const historyBinding = bindHistoryForCompaction(historyForCompaction, deps.dialogueHistory,
    deps.getMessages().slice(0, deps.dialogueHistory.length));
  const toolIntent = attention.toolUse === "none" ? false : attention.toolUse === "uncertain" ? null : true;
  const userAskedForAction = companionRequestsAction(attention, deps.availableDefinitions);
  const userRequiresTool = userAskedForAction || companionStepRequiresTool(toolIntent,
    attention.toolUse === "read" ? attention.candidateOperations : undefined);
  const reminderListAsked = attention.candidateOperations.includes("attention.read.reminders");
  /**
   * 工具面只由声明决定：权限档 + 数据外发政策，也就是 `resolveAllCompanionAgentTools`
   * 给出的那一份（它自己的注释：Exposure is a view of the project catalog, filtered by
   * current permissions and data-egress policy）。**本轮意图不再参与筛选。**
   *
   * 摘工具从来没能真正拦住误写：要不要动数据由 `riskClass`、`requiresConfirmation`
   * 与提案确认门在执行侧判（`companion-tool-execution.ts` 还会复核这轮是否真的给过）。
   */
  const definitions = deps.availableDefinitions;
  const toolDefinitions = definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }));
  const steerableReadTools = steerableToolNames(definitions, "lookup");
  const steerableActionTools = steerableToolNames(definitions, "action");
  // 只点名本轮解释**自己指出**的那些写操作；一个都没点名时留空。
  const writeOperationNames = new Set(definitions
    .filter(definition => definition.riskClass !== "read")
    .flatMap(definition => [definition.name, ...(COMPANION_DOMAIN_ACTIONS[definition.name as keyof typeof COMPANION_DOMAIN_ACTIONS] ?? [])
      .map(action => companionDomainOperation(definition.name, action) ?? definition.name)]));
  const requestedActionTools = [...new Set(attention.candidateOperations.filter(name => writeOperationNames.has(name)))];
  const providerCapabilities = deps.loopArgs.provider.getCapabilities?.();
  const providerCapabilityFingerprint = sha256Utf8V1(canonicalJsonV1({
    capabilityFingerprint: providerCapabilities?.fingerprint ?? null,
    toolMode: providerCapabilities?.toolMode ?? null,
    contextWindowTokens: providerCapabilities?.contextWindowTokens ?? null,
    providerId: deps.loopArgs.provider.id,
    modelId: deps.loopArgs.provider.modelId,
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
    ...contextReceipts?.runMetaPatch(),
  });

  return {
    attention,
    historyBinding,
    userRequiresTool,
    userAskedForAction,
    definitions,
    toolDefinitions,
    steerableReadTools,
    steerableActionTools,
    requestedActionTools,
    reminderListAsked,
    capabilitySnapshot,
  };
}
