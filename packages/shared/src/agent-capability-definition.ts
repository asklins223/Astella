import type { z } from "zod";
import { companionAgentToolDefinitionV1Schema, type CompanionAgentToolDefinitionV1 } from "./contracts/companion-agent-contracts.ts";
import { agentToolParameters } from "./agent-tool-parameters.ts";

export interface AgentCapabilityDeclaration {
  readonly definition: CompanionAgentToolDefinitionV1;
  readonly argumentSchema: z.ZodType<Record<string, unknown>>;
  readonly presentation: { readonly label: string; readonly methodStep?: string; readonly discovery?: string };
}

/** All surfaces derive model parameters, validation and presentation from this
 * declaration. The shared catalog stays browser-safe and carries no executor. */
export function defineAgentCapability(
  name: string, description: string, riskClass: CompanionAgentToolDefinitionV1["riskClass"],
  requiresConfirmation: boolean, argumentSchema: z.ZodType<Record<string, unknown>>,
  presentation: AgentCapabilityDeclaration["presentation"],
  limits: { maxInputChars?: number; maxOutputChars?: number } = {},
): AgentCapabilityDeclaration {
  return { definition: companionAgentToolDefinitionV1Schema.parse({
    version: 1, toolVersion: "1.0.0", name, description, riskClass, requiresConfirmation,
    parameters: agentToolParameters(argumentSchema), maxInputChars: limits.maxInputChars ?? 4000,
    maxOutputChars: limits.maxOutputChars ?? 4000,
  }), argumentSchema, presentation };
}
