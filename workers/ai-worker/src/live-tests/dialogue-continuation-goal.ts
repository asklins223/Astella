import type { AgentTurnRequest } from "@astella/shared";
import { COMPANION_CASUAL_POLICY_BASE_V1, COMPANION_CASUAL_POLICY_V2,
  COMPANION_DIALOGUE_CONTINUATION_GOAL_V1 } from "../handlers/companion-conversation-policy.ts";

/** Same text enabled by the user after this historical diagnostic. */
export const dialogueContinuationGoal = COMPANION_DIALOGUE_CONTINUATION_GOAL_V1;

export function continuationGoalRequest(request: AgentTurnRequest): AgentTurnRequest {
  if (request.systemPrompt.includes(COMPANION_CASUAL_POLICY_V2))
    throw new Error("Dialogue goal already active; cannot claim an inactive baseline");
  const policy = COMPANION_CASUAL_POLICY_BASE_V1;
  if (request.messages.at(-1)?.role !== "user" || request.systemPrompt.split(policy).length !== 2)
    throw new Error("Exactly one existing casual execution policy required");
  return { ...structuredClone(request), systemPrompt: request.systemPrompt.replace(policy, `${policy}\n${dialogueContinuationGoal}`) };
}
