import { agentCapabilityLabel } from "@astella/shared/agent-capabilities";
import type { AgentArtifactRefV1, AgentOperationV1, AgentRunV1 } from "@astella/shared/agent-contracts";
import { AGENT_ARTIFACT_KIND_LABELS_V1 } from "@astella/shared/agent-contracts";
import { useRoomStore } from "../../../app/home/room-store";
import { plainCompanionBubbleText } from "../content/companion-markdown";
import { previewCompanionNote } from "../journal/companion-result-preview";

export const goalStatusText: Record<AgentRunV1["status"], string> = {
  queued: "等待开始", running: "进行中", waiting: "等待生成结果", paused: "已暂停",
  completed: "已完成", failed: "未完成", cancelled: "已停止",
};
export const operationStatusText: Record<AgentRunV1["operations"][number]["status"], string> = {
  accepted: "等待生成", running: "正在生成", succeeded: "已做好", failed: "这次没做成",
  cancelled: "已停止", outcome_unknown: "结果待核对",
};
export function artifactLabel(artifact: AgentArtifactRefV1, run?: AgentRunV1) {
  const label = AGENT_ARTIFACT_KIND_LABELS_V1[artifact.kind];
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
export function goalNextHint(run: AgentRunV1) {
  if (run.operations.some(operation => operation.status === "outcome_unknown")) return "暂时无法确认操作结果，先查看完整记录，避免重复生成。";
  if (run.status === "failed") return "可以调整要求再继续，已经做好的内容会保留。";
  if (run.status === "paused") return "不再推进新步骤，已经启动的生成会收回结果。";
  if (run.status === "cancelled") return "未完成的生成已停止，之前的成果仍能打开。";
  if (run.status === "completed") {
    if (run.operations.some(operation => operation.status === "succeeded" && operation.result?.kind === "artifact" && operation.result.artifact.kind === "note_expansion"))
      return "拓展草稿已留好，翻开后可以修改、挑选，再决定收下哪些。";
    if (run.summary && !run.operations.some(operation => operation.result?.kind === "artifact"))
      return run.artifacts.length ? "这次的答复留在手记里，之前的成果也保留着。" : "这次的答复留在手记里，可以接着和我聊。";
    return "方便时再看，也可以接着和我聊。";
  }
  return "你可以继续读书或聊天，我会把进展留在这里。";
}

/**
 * 气泡/列表/任务页共用的“现在到哪一步”。只讲事实：正在哪个能力、已经留下几份成果，
 * 或这个任务为什么停在这里；不替她发明新的进度措辞。
 */
export function goalProgressLine(run: AgentRunV1) {
  const results = latestGoalArtifacts(run).length;
  const active = run.operations.find(operation => operation.status === "running")
    ?? run.operations.find(operation => operation.status === "accepted");
  if (["running", "queued", "waiting"].includes(run.status)) {
    if (active) return `${operationLabel(active.capability)}${results ? ` · 已做好 ${results} 份` : ""}`;
    const waiting = run.status === "queued" ? "等待开始" : "等待生成结果";
    return results ? `${waiting} · 已做好 ${results} 份` : waiting;
  }
  if (run.status === "completed") return results ? `${results} 份成果已保留` : "答复已留下";
  if (run.status === "failed") return results ? `已保留 ${results} 份成果` : "没有留下成果";
  if (run.status === "paused") return results ? `已暂停 · 已保留 ${results} 份` : "已暂停";
  if (run.status === "cancelled") return results ? `已停止 · 已保留 ${results} 份` : "已停止";
  return goalStatusText[run.status];
}

export function goalUpdatedLabel(run: AgentRunV1) {
  const date = new Date(run.updatedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 任务页是否真的有一个“下一步”要说。
 * 已完成且只有普通成果时，结果和交付说明已经回答了；再用一句泛化提示占一块，
 * 反而把成果压下去。只有待处理、特殊候选/草稿、或纯答复没有成果时才保留。
 */
export function goalHasNextStep(run: AgentRunV1) {
  if (["queued", "running", "waiting", "failed", "paused", "cancelled"].includes(run.status)) return true;
  if (run.operations.some(operation => {
    if (operation.status !== "succeeded" || !operation.result) return false;
    return operation.result.kind === "artifact"
      && ["note_expansion"].includes(operation.result.artifact.kind);
  })) return true;
  return Boolean(run.summary && !run.operations.some(operation => operation.result?.kind === "artifact"));
}

export function openAgentArtifact(artifact: AgentArtifactRefV1, scope: number) {
  const room = useRoomStore.getState();
  if (room.workspaceScopeRevision !== scope) return false;
  room.setActiveNoteRef({ noteId: artifact.noteId, noteVersionId: artifact.noteVersionId,
    learningView: (artifact.kind === "note_overview" || artifact.kind === "note_mind_map") ? "overview" : artifact.kind === "note_expansion" ? "expansion" : "artifact",
    learningResult: { kind: artifact.kind, artifactId: artifact.id, taskId: artifact.jobId, noteVersionId: artifact.noteVersionId } });
  room.invoke("open-notebook");
  return true;
}

export function previewAgentArtifact(artifact: AgentArtifactRefV1, scope: number, goalRunId: string, title: string, origin?: HTMLElement) {
  if (useRoomStore.getState().workspaceScopeRevision !== scope) return false;
  previewCompanionNote({ noteId: artifact.noteId, noteVersionId: artifact.noteVersionId, title, artifact, goalRunId }, origin);
  return false;
}

export function operationLabel(capability: string) {
  return agentCapabilityLabel(capability) ?? "处理学习内容";
}
