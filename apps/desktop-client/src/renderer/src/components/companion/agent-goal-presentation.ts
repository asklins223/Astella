import type { AgentArtifactRefV1, AgentRunV1 } from "@ailearn/shared/agent-contracts";
import { useRoomStore } from "../../app/room-store";
import { plainCompanionBubbleText } from "./companion-markdown";

export const goalStatusText: Record<AgentRunV1["status"], string> = {
  queued: "接下来了", running: "正在整理", waiting: "正在生成", paused: "先放一放",
  completed: "做好了", failed: "还差一点", cancelled: "已经停下",
};
export const operationStatusText: Record<AgentRunV1["operations"][number]["status"], string> = {
  accepted: "等待生成", running: "正在生成", succeeded: "已做好", failed: "这次没做成",
  cancelled: "已停止", outcome_unknown: "正在核对结果",
};
export function artifactLabel(artifact: AgentArtifactRefV1, run?: AgentRunV1) {
  const label = artifact.kind === "note_overview" ? "速看" : "互动演示";
  if (!run || new Set(run.inputs.map(input => input.noteId)).size < 2) return label;
  const index = run.inputs.findIndex(input => input.noteId === artifact.noteId && input.noteVersionId === artifact.noteVersionId);
  return index < 0 ? label : `笔记 ${index + 1} 的${label}`;
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
  return run.status === "waiting" ? "我在把它整理出来" : "这件事交给我了";
}
export function goalNextHint(run: AgentRunV1) {
  if (run.modelCalls >= run.maxModelCalls && run.status !== "completed") return "这次处理额度已用完，成果保留。可以重新交代一个更小的目标。";
  if (run.operations.some(operation => operation.status === "outcome_unknown")) return "结果还在核对，先不重复生成。";
  if (run.status === "failed") return "可以调整要求再继续，已经做好的内容会保留。";
  if (run.status === "paused") return "不再推进新步骤，已经启动的生成会收回结果。";
  if (run.status === "cancelled") return "未完成的生成已停止，之前的成果仍能打开。";
  if (run.status === "completed") return "方便时再看，也可以接着和我聊。";
  return "你可以继续读书或聊天，我会把进展留在这里。";
}
export function openAgentArtifact(artifact: AgentArtifactRefV1, scope: number) {
  const room = useRoomStore.getState();
  if (room.workspaceScopeRevision !== scope) return false;
  room.setActiveNoteRef({ noteId: artifact.noteId, noteVersionId: artifact.noteVersionId,
    learningView: artifact.kind === "note_overview" ? "overview" : "artifact",
    learningResult: { kind: artifact.kind, artifactId: artifact.id, taskId: artifact.jobId } });
  room.invoke("open-notebook");
  return true;
}
