import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";

/**
 * A short, user-facing progress label for a clearly classified action.
 * This is an observable task status, never model reasoning or a completion claim.
 */
export function companionActionProgressLabel(
  attention: Pick<AgentTurnInterpretationV1, "toolUse" | "ambiguities"> & {
    readonly candidateOperations: readonly string[];
  },
  availableActionTools: readonly string[],
): string | null {
  if (attention.toolUse !== "act" || attention.ambiguities.length > 0 || availableActionTools.length === 0) {
    return null;
  }

  if (availableActionTools.includes("notes.write.create")) return "我先整理笔记内容…";
  if (availableActionTools.includes("notes.write.edit")) return "我先检查笔记，再按你说的调整…";
  return "我开始处理你刚才交代的事…";
}
