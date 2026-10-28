import { isCompanionAutonomousTool, AgentRole, type AgentTurnRequest } from "@astella/shared";
import { composeAgentContext } from "@astella/agent-core";
import { companionContextAssemblyCapacity } from "../handlers/context/companion-context-receipts.ts";
import { companionStepRuntimePolicy } from "../handlers/turn/companion-step-plan.ts";
import { companionResponseStrategy } from "../handlers/turn/companion-response-strategy.ts";

/** A no-tool casual request for dialogue probes. The production loop has no
 * speculative first step; this only reproduces the casual reply shape offline. */
export function buildCasualFirstStepRequest(args: {
  turnPolicy: string;
  permissionLevel: string;
  stepBudget: number;
  messages: AgentTurnRequest["messages"];
  maxTokens: number;
  tools?: AgentTurnRequest["tools"];
}): AgentTurnRequest {
  const tools = args.tools?.filter(tool => isCompanionAutonomousTool(tool.name)
    || tool.name === "companion_persona_write") ?? [];
  const contextSources = new Map([
    ["turn", { scope: { kind: "policy" as const }, content: args.turnPolicy }],
    ["execution", { scope: { kind: "policy" as const }, content: companionStepRuntimePolicy({
      permissionLevel: args.permissionLevel,
      toolCount: tools.length,
      stepBudget: args.stepBudget,
      finalAnswerOnly: false,
      attentionIntent: "conversation",
    }) }],
  ]);
  return {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: composeAgentContext({ maxCharacters: companionContextAssemblyCapacity([...contextSources.values()].map(source => source.content)), sources: [
      { id: "turn", authority: "policy", required: true },
      { id: "execution", authority: "policy", required: true },
    ] }, contextSources).systemPrompt,
    messages: [...args.messages],
    tools,
    disableThinking: true,
    maxTokens: args.maxTokens,
    temperature: companionResponseStrategy({ intent: "conversation", toolUse: "none" }).temperature,
  };
}
