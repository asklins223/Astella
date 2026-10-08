import { ArrowUpRight } from "lucide-react";
import type { AgentArtifactRefV1, AgentOperationV1 } from "@astella/shared/agent-contracts";
import { openAgentCardOperation } from "./agent-goal-presentation";

/** A failed or running batch is a task to inspect, not a finished result. */
export function CompanionCardTasks({ operations, artifacts, scope, onOpen }: {
  operations: readonly AgentOperationV1[]; artifacts: readonly AgentArtifactRefV1[];
  scope: number; onOpen: () => void;
}) {
  const tasks = operations.filter(operation => operation.execution.kind === "card_generation"
    && !artifacts.some(artifact => artifact.kind === "card_candidates" && artifact.id === operation.execution.id)
    && operation.result?.kind !== "no_cards_recommended");
  if (!tasks.length) return null;
  return <div className="companion-goal-journal__results" aria-label="学习卡生成任务">
    {tasks.map((operation, index) => <button type="button" key={operation.operationId}
      onClick={() => { if (openAgentCardOperation(operation, scope)) onOpen(); }}>
      <span>{["accepted", "running"].includes(operation.status) ? "查看学习卡生成进度" : "查看学习卡生成任务"}{tasks.length > 1 ? ` · 第 ${index + 1} 批` : ""}</span>
      <ArrowUpRight size={16} />
    </button>)}
  </div>;
}
