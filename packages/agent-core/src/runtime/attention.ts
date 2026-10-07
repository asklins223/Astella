import { agentTurnInterpretationProposalV1Schema, agentTurnInterpretationV1Schema,
  type AgentAttentionObjectV1, type AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";

/** Bind only host-supplied identities. Old context explains a pronoun but does
 * not restore an earlier execution instruction or confer new authority. */
export function resolveAgentTurnInterpretation(proposal: unknown, input: {
  requestHash: string; objects: readonly AgentAttentionObjectV1[]; capabilities: readonly string[];
  /** 宿主真正交出去过的那些消息索引；解释不能发明身份，越界的引用直接丢掉。 */
  offerCandidates?: readonly number[];
  /** Only these exact host-provided user records may support dialogue state. */
  dialogueSources?: readonly { index: number; role: string; content: string }[];
  currentMessageIndex?: number;
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
  const { goalObjectIndex: _index, subjects: _subjects, dialogueFrame: frame, ...fields } = value;
  const sources = new Map(input.dialogueSources?.map(source => [source.index, source]));
  const bindEvidence = (evidence: {messageIndex:number;quote:string}) => {
    const source = sources.get(evidence.messageIndex);
    return source?.role === "user" && source.content.includes(evidence.quote)
      ? {...evidence,sourceSha256:sha256Utf8V1(source.content)} : null;
  };
  const currentEvidence = frame && frame.evidence.messageIndex === input.currentMessageIndex
    ? bindEvidence(frame.evidence) : null;
  const state = frame?.userState.flatMap(item => {
    const evidence = bindEvidence(item);
    return evidence ? [{topic:item.topic,aspect:item.aspect,relation:item.relation,...evidence,
      ...(item.relevance ? {relevance:item.relevance} : {}),
      ...(item.aspect === "progress" && item.progress ? {progress:item.progress} : {})}] : [];
  }) ?? [];
  // Preserve the latest user testimony for each stated topic/aspect. Assistant
  // guesses cannot enter this map. Other aspects (e.g. deadline) stay separate.
  const latestState = new Map<string,typeof state[number]>();
  for (const item of state.sort((a,b) => a.messageIndex-b.messageIndex)) {
    const key=`${item.topic.normalize("NFKC").toLowerCase()}\0${item.aspect}`;
    if(item.aspect === "progress" && item.progress) {
      latestState.delete(key);
      if(item.progress.work !== "unknown") latestState.set(`${key}:work`,item);
      if(item.progress.handoff !== "unknown") latestState.set(`${key}:handoff`,item);
      if(item.progress.work === "unknown" && item.progress.handoff === "unknown") {
        if(item.relation === "correction") {
          latestState.delete(`${key}:work`);latestState.delete(`${key}:handoff`);
        }
        latestState.set(key,item);
      }
    } else latestState.set(key,item);
  }
  // One source can support both phases. If a later source replaces only one,
  // the surviving source must not carry its now superseded phase alongside it.
  const userState = [...new Set(latestState.values())].map(item => {
    if (item.aspect !== "progress" || !item.progress) return item;
    const key = `${item.topic.normalize("NFKC").toLowerCase()}\0${item.aspect}`;
    return {...item,progress:{
      work: latestState.get(`${key}:work`) === item ? item.progress.work : "unknown" as const,
      handoff: latestState.get(`${key}:handoff`) === item ? item.progress.handoff : "unknown" as const,
    }};
  });
  const dialogueFrame = frame && currentEvidence
    ? {purpose:frame.purpose,evidence:currentEvidence,userState} : undefined;
  return agentTurnInterpretationV1Schema.parse({ ...fields, pendingOfferIndexes, version: 1, requestHash: input.requestHash,
    ...(dialogueFrame ? {dialogueFrame} : {}),
    subjects, goalReference: conversational || value.goalRelation === "unrelated" || value.goalRelation === "new" ? null : goalReference,
    goalRelation: conversational ? "unrelated" : value.goalRelation,
    candidateOperations: conversational ? [] : candidateOperations,
    toolUse: conversational ? "none" : ambiguities.length && value.toolUse === "act" ? "uncertain" : value.toolUse,
    ambiguities: [...new Set(ambiguities)].slice(0, 6), status: ambiguities.length || value.toolUse === "uncertain" ? "uncertain" : "interpreted",
  });
}
