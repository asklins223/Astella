/** Retired experiment: source binding for offline recorded diagnostics only. */
import { resolveAgentTurnInterpretation } from "@astella/agent-core";
import { agentTurnInterpretationProposalV1Schema, type AgentAttentionObjectV1 } from "@astella/shared/agent-contracts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { agentDialogueFrameProposalV1Schema } from "./companion-dialogue-contracts.ts";

const diagnosticProposal = agentTurnInterpretationProposalV1Schema.extend({ dialogueFrame: agentDialogueFrameProposalV1Schema.optional() });

export function resolveDiagnosticCompanionTurn(proposal: unknown, input: {
  requestHash: string; objects: readonly AgentAttentionObjectV1[]; capabilities: readonly string[];
  offerCandidates?: readonly number[];
  dialogueSources?: readonly { index: number; role: string; content: string }[];
  currentMessageIndex?: number;
}) {
  const parsed = diagnosticProposal.safeParse(proposal);
  if (!parsed.success) return { ...resolveAgentTurnInterpretation(null, input), dialogueFrame: undefined };
  const { dialogueFrame: frame, ...current } = parsed.data;
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
  return { ...resolveAgentTurnInterpretation(current, input), dialogueFrame };
}
