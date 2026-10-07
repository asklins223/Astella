import { agentTurnInterpretationProposalV1Schema, agentTurnInterpretationV1Schema,
  type AgentAttentionObjectV1, type AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";

/** Bind only host-supplied identities. Old context explains a pronoun but does
 * not restore an earlier execution instruction or confer new authority. */
export function resolveAgentTurnInterpretation(proposal: unknown, input: {
  requestHash: string; objects: readonly AgentAttentionObjectV1[]; capabilities: readonly string[];
  /** 宿主真正交出去过的那些消息索引；解释不能发明身份，越界的引用直接丢掉。 */
  offerCandidates?: readonly number[];
}): AgentTurnInterpretationV1 {
  const parsed = agentTurnInterpretationProposalV1Schema.safeParse(proposal);
  if (!parsed.success) return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash: input.requestHash,
    intent: "question", toolUse: "uncertain", subjects: [], goalRelation: "unclear", goalReference: null,
    candidateOperations: [], ambiguities: ["本轮意图尚未核对，需根据当前话语澄清。"], status: "uncertain" });
  const value = parsed.data;
  const ambiguities = [...value.ambiguities];
  const subjects = value.subjects.map(subject => {
    const reference = subject.objectIndex === undefined ? null : input.objects[subject.objectIndex] ?? null;
    if (subject.objectIndex !== undefined && !reference) ambiguities.push("讨论对象尚未找到真实引用。");
    return { description: subject.description, reference };
  });
  const goal = value.goalObjectIndex === undefined ? null : input.objects[value.goalObjectIndex];
  const goalReference = goal?.kind === "agent_run" ? goal : null;
  if (value.goalObjectIndex !== undefined && !goalReference) ambiguities.push("关联任务尚未核对真实身份。");
  if (["continue", "revise", "control", "discuss"].includes(value.goalRelation) && !goalReference)
    ambiguities.push("所指任务尚未找到真实引用。");
  if (value.goalRelation === "unclear") ambiguities.push("与任务的关系尚未澄清。");
  const candidateOperations = value.candidateOperations.filter(name => input.capabilities.includes(name));
  if (candidateOperations.length !== value.candidateOperations.length) ambiguities.push("候选操作有尚不可用的能力。");
  // 待收的账只能指向宿主真的给出去过的那几条消息。没给候选（调用方还没接线）就等于
  // 本轮没有账——宁可不做，也不要让一次凭空的索引改写她的历史。
  const offerCandidates = new Set(input.offerCandidates ?? []);
  const pendingOfferIndexes = [...new Set(value.pendingOfferIndexes.filter(index => offerCandidates.has(index)))];
  const conversational = value.intent === "conversation" || (value.intent === "question" && value.toolUse === "none");
  const { goalObjectIndex: _index, subjects: _subjects, ...fields } = value;
  return agentTurnInterpretationV1Schema.parse({ ...fields, pendingOfferIndexes, version: 1, requestHash: input.requestHash,
    subjects, goalReference: conversational || value.goalRelation === "unrelated" || value.goalRelation === "new" ? null : goalReference,
    goalRelation: conversational ? "unrelated" : value.goalRelation,
    candidateOperations: conversational ? [] : candidateOperations,
    toolUse: conversational ? "none" : ambiguities.length && value.toolUse === "act" ? "uncertain" : value.toolUse,
    ambiguities: [...new Set(ambiguities)].slice(0, 6), status: ambiguities.length || value.toolUse === "uncertain" ? "uncertain" : "interpreted",
  });
}
