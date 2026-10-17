import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";

export function companionExecutionConstraintGuidance(attention: Pick<AgentTurnInterpretationV1, "executionConstraints">): string {
  return attention.executionConstraints?.timeBasedWakeups === "forbid"
    ? "本轮执行边界：不创建定时提醒、定时唤醒或内部定时重评。事件订阅和取消已有时间仍可执行；关注计划的 nextReviewAt、自身重评的 at 必须为 JSON null，不改用其他时间安排绕过这条限制。"
    : "";
}

/** Restricts execution after semantic interpretation; it neither hides tools
 * nor confers permission. Cancelling a wake remains available. */
export function companionTimeWakeupConstraint(
  attention: Pick<AgentTurnInterpretationV1, "executionConstraints">,
  name: string, args: Record<string, unknown>,
): { key: string; instruction: string } | null {
  if (attention.executionConstraints?.timeBasedWakeups !== "forbid") return null;
  const field = name === "companion_arrange_attention" ? "nextReviewAt"
    : name === "companion_schedule_wake" ? "at"
      : name === "companion_schedule_reminder" ? "fireAtLocal" : null;
  if (!field || args[field] === null || args[field] === undefined) return null;
  return { key: `timeBasedWakeups:${name}:${field}`,
    instruction: name === "companion_schedule_reminder"
      ? "本轮禁止定时唤醒，没有创建提醒。保留已完成的操作，不改用其他时间安排绕过限制。"
      : `本轮只允许事件触发，不设置定时唤醒或内部定时重评。将 ${field} 设为 JSON null；保留事件订阅，不改用其他安排绕过限制。` };
}
