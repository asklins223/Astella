import type { AgentTurnInterpretationV1 } from "@astella/shared/agent-contracts";
import type { CompanionEntryMode } from "./companion-entry-mode.ts";

export type CompanionTurnWorkload = "casual" | "adaptive";

/** One workload label for the opening. Thinking stays at the model default;
 * companion_deepen and a repair are the only host raises. */
export function resolveCompanionTurnWorkload(input: {
  mode: CompanionEntryMode;
  attention: Pick<AgentTurnInterpretationV1, "resourceDecision">;
  requiresGrounding: boolean;
}): CompanionTurnWorkload {
  return input.mode === "direct_fast" && !input.requiresGrounding ? "casual" : "adaptive";
}

export function companionStepReasoning(input: {
  mode: CompanionEntryMode; resourcePath?: "chat" | "work"; deepened: boolean;
  repairing: boolean; evidenceRepair?: boolean; readOnlyRequiredStep: boolean; toolCallCount: number;
}): "none" | "low" | "medium" | "high" | "max" | undefined {
  // Resolve to each provider's highest supported level. On a high/max model,
  // requesting high again would make an explicit deepen call a no-op.
  if (input.deepened || input.mode === "direct_thinking") return "max";
  // A missed read or search has to follow a specific tool instruction.
  // A missed write only needs one tool call; high effort spent the whole step
  // deliberating the argument (23s, 725 tokens, for saving one umbrella color).
  if (input.repairing && input.evidenceRepair) return "high";
  if (input.repairing) return "low";
  // Ordinary steps, including the opening and the step after a tool receipt,
  // leave the effort unset. The provider then uses the model profile default.
  // On MiMo that default enables thinking; only an explicit none turns it off.
  return undefined;
}

export const COMPANION_CASUAL_TURN_GUIDANCE = "按用户当前目标自然接话，按当前人格表达，不附知识检查清单、任务前言或执行汇报。称呼、问候和礼貌用语表达交流意图，不必据时钟纠正；只回应对方说过或实际观察到的近况，不替他补写经历、身体状态或生活安排。不要为了找事做而读取或改动资料。若实际需要多步推理、核对信息或操作，仍可使用本轮工具；操作完成必须以真实回执为准。";
