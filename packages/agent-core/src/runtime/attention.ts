import { agentTurnInterpretationProposalV1Schema, agentTurnInterpretationV1Schema,
  type AgentAttentionObjectV1, type AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { getAgentCapability } from "@astella/shared/agent-capability-catalog";

/** Bind only host-supplied identities. Old context explains a pronoun but does
 * not restore an earlier execution instruction or confer new authority. */
export function resolveAgentTurnInterpretation(proposal: unknown, input: {
  requestHash: string; objects: readonly AgentAttentionObjectV1[]; capabilities: readonly string[];
  /** 宿主真正交出去过的那些消息索引；解释不能发明身份，越界的引用直接丢掉。 */
  offerCandidates?: readonly number[];
  currentUserText?: string;
}): AgentTurnInterpretationV1 {
  const parsed = agentTurnInterpretationProposalV1Schema.safeParse(proposal);
  if (!parsed.success) return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: input.requestHash,
    intent: "question", toolUse: "uncertain", subjects: [], goalRelation: "unclear", goalReference: null,
    candidateOperations: [], ambiguities: ["本轮意图尚未核对，需根据当前话语澄清。"], status: "uncertain" });
  const value = parsed.data;
  const ambiguities = [...value.ambiguities];
  let executionConstraints = value.executionConstraints;
  if (executionConstraints?.timeBasedWakeups === "forbid") {
    const quote = executionConstraints.sourceQuote;
    if (!quote?.trim() || !input.currentUserText?.includes(quote)) {
      executionConstraints = { timeBasedWakeups: "unspecified", sourceQuote: null };
      ambiguities.push("时间限制未引用本轮原话，需按当前请求重新核对；历史限制不能冒充本轮指令。");
    }
  }
  const subjects = value.subjects.map(subject => {
    const reference = subject.objectIndex === undefined ? null : input.objects[subject.objectIndex] ?? null;
    if (subject.objectIndex !== undefined && !reference) ambiguities.push("讨论对象尚未找到真实引用。");
    return { description: subject.description, reference };
  });
  // Voice, participation and reminder/attention controls own their domain
  // identities. They do not acquire a missing agent_run merely because the
  // model describes the action with the word "control".
  const domainOperationOnly = value.candidateOperations.length > 0
    && value.candidateOperations.every(name => input.capabilities.includes(name)
      && getAgentCapability(name) && getAgentCapability(name)!.executor !== "goal_control");
  const voiceControlOnly = value.toolUse === "none" && value.candidateOperations.length === 0
    && (value.voiceStyle.decision !== "none" || value.voiceStyle.persistentPreference.action !== "keep");
  const goalRelation = value.goalObjectIndex === undefined && (domainOperationOnly || voiceControlOnly)
    && ["control", "revise", "continue"].includes(value.goalRelation) ? "unrelated" : value.goalRelation;
  const goal = value.goalObjectIndex === undefined ? null : input.objects[value.goalObjectIndex];
  const goalReference = goal?.kind === "agent_run" ? goal : null;
  if (value.goalObjectIndex !== undefined && !goalReference) ambiguities.push("关联任务尚未核对真实身份。");
  if (["continue", "revise", "control", "discuss"].includes(goalRelation) && !goalReference)
    ambiguities.push("所指任务尚未找到真实引用。");
  if (goalRelation === "unclear") ambiguities.push("与任务的关系尚未澄清。");
  const candidateOperations = value.candidateOperations.filter(name => input.capabilities.includes(name));
  if (candidateOperations.length !== value.candidateOperations.length) ambiguities.push("候选操作有尚不可用的能力。");
  // 待收的账只能指向宿主真的给出去过的那几条消息。没给候选（调用方还没接线）就等于
  // 本轮没有账——宁可不做，也不要让一次凭空的索引改写她的历史。
  const offerCandidates = new Set(input.offerCandidates ?? []);
  const pendingOfferIndexes = [...new Set(value.pendingOfferIndexes.filter(index => offerCandidates.has(index)))];
  const voiceStyle = {
    decision: value.voiceStyle.decision === "apply" && value.voiceStyle.instruction
      ? "apply" as const
      : value.voiceStyle.decision === "clarify" ? "clarify" as const : "none" as const,
    instruction: value.voiceStyle.decision === "apply" ? value.voiceStyle.instruction : null,
    persistentPreference: value.voiceStyle.persistentPreference.action === "set" && value.voiceStyle.persistentPreference.dialect
      ? value.voiceStyle.persistentPreference
      : value.voiceStyle.persistentPreference.action === "clear"
        ? { action: "clear" as const, dialect: null }
        : { action: "keep" as const, dialect: null },
  };
  const conversational = value.intent === "conversation" || (value.intent === "question" && value.toolUse === "none");
  const { goalObjectIndex: _index, subjects: _subjects, ...fields } = value;
  return agentTurnInterpretationV1Schema.parse({ ...fields, pendingOfferIndexes, version: 1, requestHash: input.requestHash,
    voiceStyle, ...(executionConstraints ? { executionConstraints } : {}),
    subjects, goalReference: conversational || goalRelation === "unrelated" || goalRelation === "new" ? null : goalReference,
    goalRelation: conversational ? "unrelated" : goalRelation,
    candidateOperations: conversational ? [] : candidateOperations,
    toolUse: conversational ? "none" : ambiguities.length && value.toolUse === "act" ? "uncertain" : value.toolUse,
    ambiguities: [...new Set(ambiguities)], status: ambiguities.length || value.toolUse === "uncertain" ? "uncertain" : "interpreted",
  });
}
