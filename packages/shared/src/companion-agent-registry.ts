import { agentCapabilityCatalog, getAgentCapability, validateAgentCapabilityArguments } from "./agent-capability-catalog.ts";
import { isVisionGatedCompanionTool, type CompanionAgentPermissionLevel,
  type CompanionAgentToolDefinitionV1, type CompanionAgentToolExecutionConstraints } from "./contracts/companion-agent-contracts.ts";

const conversationCapabilities = agentCapabilityCatalog.filter(entry => entry.surfaces.includes("conversation"));
export const COMPANION_AGENT_TOOL_DEFINITIONS: readonly CompanionAgentToolDefinitionV1[] =
  Object.freeze(conversationCapabilities.map(entry => entry.definition));
export const COMPANION_AGENT_TOOL_NAMES: readonly string[] = Object.freeze(conversationCapabilities.map(entry => entry.definition.name));
export const COMPANION_AGENT_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(conversationCapabilities.map(entry => [entry.definition.name, entry.presentation.label])),
);

/** Exposure is a view of the project catalog, filtered by current permissions
 * and data-egress policy, never a second collection of tool definitions. */
export function resolveAllCompanionAgentTools(
  permission: CompanionAgentPermissionLevel,
  constraints: CompanionAgentToolExecutionConstraints = {},
): CompanionAgentToolDefinitionV1[] {
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter(definition =>
    (!isVisionGatedCompanionTool(definition.name) || constraints.visionEnabled === true)
    && (definition.name !== "agent_web_search" || constraints.webSearchEnabled === true)
    && (permission !== "read_only" || definition.riskClass === "read"));
}
export function getCompanionAgentTool(toolName: string): CompanionAgentToolDefinitionV1 | null {
  const entry = getAgentCapability(toolName);
  return entry?.surfaces.includes("conversation") ? entry.definition : null;
}
export function validateCompanionAgentToolArguments(toolName: string, args: unknown) {
  return validateAgentCapabilityArguments(toolName, args, "conversation");
}
