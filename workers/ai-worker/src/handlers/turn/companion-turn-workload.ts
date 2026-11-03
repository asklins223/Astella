import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { CompanionEntryMode } from "./companion-entry-mode.ts";

export type CompanionTurnWorkload = "casual" | "adaptive";

/** Fast opening by default. The agent deepens itself through companion_deepen
 * when the task actually needs it; no separate routing model selects cost. */
export function resolveCompanionTurnWorkload(input: {
  mode: CompanionEntryMode;
  attention: Pick<AgentTurnInterpretationV1, "resourceDecision">;
  requiresGrounding: boolean;
}): CompanionTurnWorkload {
  return input.mode === "direct_fast" && !input.requiresGrounding ? "casual" : "adaptive";
}

export function companionStepReasoning(input: {
  mode: CompanionEntryMode; resourcePath?: "chat" | "work"; deepened: boolean;
  repairing: boolean; readOnlyRequiredStep: boolean; toolCallCount: number;
  /** A retained opening has independent evidence and expression checks. */
  reviewedOpening?: boolean;
}): "none" | "low" | "medium" | "high" | "max" | undefined {
  // Resolve to each provider's highest supported level. On a high/max model,
  // requesting high again would make an explicit deepen call a no-op.
  if (input.deepened || input.mode === "direct_thinking") return "max";
  if (input.repairing) return "high";
  // The independently settled evidence contract requires actual reads before
  // an answer. Tool discovery/retrieval can use a declared non-reasoning level;
  // explicit thinking and repairs above always retain precedence.
  if (input.readOnlyRequiredStep) return "none";
  // A receipt is evidence, not a reason to spend high effort on every saved
  // note or confirmation. The agent can deepen when that evidence needs work.
  if (input.toolCallCount > 0) return "low";
  if (input.reviewedOpening && input.resourcePath === "chat") return "none";
  return input.resourcePath === "chat" ? "low" : "high";
}

export const COMPANION_CASUAL_TURN_GUIDANCE = "按用户当前目标自然接话，按当前人格表达，不附知识检查清单、任务前言或执行汇报。称呼、问候和礼貌用语表达交流意图，不必据时钟纠正；只回应对方说过或实际观察到的近况，不替他补写经历、身体状态或生活安排。不要为了找事做而读取或改动资料。若实际需要多步推理、核对信息或操作，仍可使用本轮工具；操作完成必须以真实回执为准。";
