import { COMPANION_HOST_PROTOCOL_V8, COMPANION_IDENTITY_BOUNDARY_V4, type AgentTurnRequest } from "@astella/shared";
import { COMPANION_VOICE_EXPRESSION_PROTOCOL_V1 } from "@astella/shared/voice-expression-tags";
import { companionStepRuntimePolicy } from "../handlers/companion-step-plan.ts";

export const dialogueLayerConditions = ["bare", "protocol", "full"] as const;
export type DialogueLayerCondition = typeof dialogueLayerConditions[number];
const identity = "你是书房里的 AI 伴星，名字叫伴星。使用简体中文，与用户交流。";

/** Synthetic diagnostic only. There is no import from a production caller.
 * Protocol adds a group of policies, not one isolated rule. All native messages
 * and effective generation parameters stay identical across the three layers. */
export function buildDialogueLayerRequests(full: AgentTurnRequest, runtime: {
  permissionLevel: string; stepBudget: number;
}): Record<DialogueLayerCondition, AgentTurnRequest> {
  if (!full.systemPrompt.trim() || full.messages.at(-1)?.role !== "user")
    throw new Error("Complete turn policy and current native user message required");
  return {
    bare: { ...structuredClone(full), systemPrompt: identity },
    protocol: { ...structuredClone(full), systemPrompt: [identity, COMPANION_HOST_PROTOCOL_V8,
      COMPANION_IDENTITY_BOUNDARY_V4, COMPANION_VOICE_EXPRESSION_PROTOCOL_V1,
      companionStepRuntimePolicy({ ...runtime, toolCount: 0,
        finalAnswerOnly: false, attentionIntent: "conversation" })].join("\n\n") },
    full: structuredClone(full),
  };
}
