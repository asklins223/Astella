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
}): "none" | "medium" | "high" | undefined {
  if (input.repairing || input.deepened || input.mode === "direct_thinking") return "high";
  // Evidence or tool progress raises the same loop; it never removes tools.
  if (input.toolCallCount > 0) return "high";
  return input.resourcePath === "chat" ? "none" : "high";
}

export const COMPANION_CASUAL_TURN_GUIDANCE = "按用户当前目标自然接话，按当前人格表达，不附知识检查清单、任务前言或执行汇报。称呼、问候和礼貌用语表达交流意图，不必据时钟纠正；只回应对方说过或实际观察到的近况，不替他补写经历、身体状态或生活安排。不要为了找事做而读取或改动资料。若实际需要多步推理、核对信息或操作，仍可使用本轮工具；操作完成必须以真实回执为准。";
