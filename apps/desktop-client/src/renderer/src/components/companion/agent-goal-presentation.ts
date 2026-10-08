import { agentCapabilityLabel } from "@astella/shared/agent-capabilities";
import type { AgentArtifactRefV1, AgentRunV1 } from "@astella/shared/agent-contracts";
import { useRoomStore } from "../../app/room-store";
import { plainCompanionBubbleText } from "./companion-markdown";

export const goalStatusText: Record<AgentRunV1["status"], string> = {
  queued: "等待开始", running: "进行中", waiting: "等待生成结果", paused: "已暂停",
  completed: "已完成", failed: "未完成", cancelled: "已停止",
};
export const operationStatusText: Record<AgentRunV1["operations"][number]["status"], string> = {
  accepted: "等待生成", running: "正在生成", succeeded: "已做好", failed: "这次没做成",
  cancelled: "已停止", outcome_unknown: "结果待核对",
};
export function artifactLabel(artifact: AgentArtifactRefV1, run?: AgentRunV1) {
  const label = { note_mind_map: "思维导图", note_overview: "速看", note_dynamic_artifact: "互动演示", note_expansion: "拓展草稿", card_candidates: "待审核学习卡" }[artifact.kind];
  if (!run || new Set(run.inputs.map(input => input.noteId)).size < 2) return label;
  const index = run.inputs.findIndex(input => input.noteId === artifact.noteId && input.noteVersionId === artifact.noteVersionId);
  return index < 0 ? label : `笔记 ${index + 1} 的${label}`;
}
export function artifactBatchLabel(artifact: AgentArtifactRefV1, run: AgentRunV1) {
  const batches = run.artifacts.filter(item => item.kind === artifact.kind
    && item.noteId === artifact.noteId && item.noteVersionId === artifact.noteVersionId);
  const index = batches.findIndex(item => item.id === artifact.id);
  const label = artifactLabel(artifact, run);
  return batches.length > 1 && index >= 0 ? `${label} · 第 ${index + 1} 批` : label;
}
export function latestGoalArtifacts(run: AgentRunV1) {
  const latest = new Map<string, AgentArtifactRefV1>();
  for (const artifact of run.artifacts) latest.set(`${artifact.kind}:${artifact.noteId}:${artifact.noteVersionId}`, artifact);
  return [...latest.values()];
}
export function goalTitle(run: AgentRunV1) {
  const text = plainCompanionBubbleText(run.goal).replace(/\s+/g, " ");
  return text.length > 42 ? `${text.slice(0,42)}…` : text;
}
export function goalHeadline(run: AgentRunV1) {
  if (run.status === "failed") return run.artifacts.length ? "做好的先留给你" : "这次还没做成";
  if (run.status === "completed") return "交给我的事做好了";
  if (run.status === "paused") return "等你想继续的时候";
  if (run.status === "cancelled") return "这件事先停在这里";
  if (run.artifacts.length) return "已经有成果了";
  return run.status === "waiting" ? "正在等待生成结果" : run.status === "queued" ? "这件事已接下" : "这件事正在进行";
}
export function goalNextHint(run: AgentRunV1) {
  if (run.operations.some(operation => operation.status === "outcome_unknown")) return "暂时无法确认操作结果，先查看完整记录，避免重复生成。";
  if (run.modelCalls >= run.maxModelCalls && run.status !== "completed") return "这次处理额度已用完，成果保留。可以重新交代一个更小的目标。";
  if (run.status === "failed") return "可以调整要求再继续，已经做好的内容会保留。";
  if (run.status === "paused") return "不再推进新步骤，已经启动的生成会收回结果。";
  if (run.status === "cancelled") return "未完成的生成已停止，之前的成果仍能打开。";
  if (run.status === "completed") {
    if (run.operations.some(operation => operation.status === "succeeded" && operation.result?.kind === "artifact" && operation.result.artifact.kind === "card_candidates"))
      return "候选卡已准备好，打开审核台挑选；你决定收下哪些，再保存到卡组。";
    if (run.operations.some(operation => operation.status === "succeeded" && operation.result?.kind === "artifact" && operation.result.artifact.kind === "note_expansion"))
      return "拓展草稿已留好，翻开后可以修改、挑选，再决定收下哪些。";
    if (run.operations.some(operation => operation.status === "succeeded" && operation.result?.kind === "no_cards_recommended"))
      return "这次没有推荐生成学习卡，原因已留在手记里。可以调整要求再聊。";
    if (run.summary && !run.operations.some(operation => operation.result?.kind === "artifact"))
      return run.artifacts.length ? "这次的答复留在手记里，之前的成果也保留着。" : "这次的答复留在手记里，可以接着和我聊。";
    return "方便时再看，也可以接着和我聊。";
  }
  return "你可以继续读书或聊天，我会把进展留在这里。";
}
export function openAgentArtifact(artifact: AgentArtifactRefV1, scope: number) {
  const room = useRoomStore.getState();
  if (room.workspaceScopeRevision !== scope) return false;
  if (artifact.kind === "card_candidates") {
    room.setActiveNoteRef({ noteId: artifact.noteId, noteVersionId: artifact.noteVersionId });
    room.setActiveCardGenerationRunId(artifact.id);
    room.invoke("open-card-generation");
    return true;
  }
  room.setActiveNoteRef({ noteId: artifact.noteId, noteVersionId: artifact.noteVersionId,
    learningView: (artifact.kind === "note_overview" || artifact.kind === "note_mind_map") ? "overview" : artifact.kind === "note_expansion" ? "expansion" : "artifact",
    learningResult: { kind: artifact.kind, artifactId: artifact.id, taskId: artifact.jobId, noteVersionId: artifact.noteVersionId } });
  room.invoke("open-notebook");
  return true;
}

export function operationLabel(capability: string) {
  return agentCapabilityLabel(capability) ?? "处理学习内容";
}
