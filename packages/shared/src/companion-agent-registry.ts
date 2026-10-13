import { agentCapabilityCatalog, getAgentCapability, validateAgentCapabilityArguments } from "./agent-capability-catalog.ts";

/** 声明原文（含 sceneGuidance）的唯一读口；这一面只是它的视图，不另存一份。 */
export { getAgentCapability };
import { isVisionGatedCompanionTool, type CompanionAgentPermissionLevel,
  type CompanionAgentToolDefinitionV1, type CompanionAgentToolExecutionConstraints } from "./contracts/companion-agent-contracts.ts";

const conversationCapabilities = agentCapabilityCatalog.filter(entry => entry.surfaces.includes("conversation"));
export const COMPANION_AGENT_TOOL_DEFINITIONS: readonly CompanionAgentToolDefinitionV1[] =
  Object.freeze(conversationCapabilities.map(entry => entry.definition));
export const COMPANION_AGENT_TOOL_NAMES: readonly string[] = Object.freeze(conversationCapabilities.map(entry => entry.definition.name));
export const COMPANION_AGENT_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(conversationCapabilities.map(entry => [entry.definition.name, entry.presentation.label])),
);
/** 只有 6 条能力写了 discovery（这一句是「用户能做什么」的短说法）。 */
export const COMPANION_AGENT_TOOL_DISCOVERY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(conversationCapabilities
    .filter(entry => entry.presentation.discovery)
    .map(entry => [entry.definition.name, entry.presentation.discovery as string])),
);

/**
 * 「文案工作」的唯一名单：这一轮的字要落进用户的笔记或卡片里。
 *
 * 为什么要单列：账号里存的长期方言是给**陪说话**用的。她顺着方言写进笔记正文、
 * 卡片内容里，就是用户看到的文字风格异常；念出来同样别扭。讲解一个概念、闲聊、
 * 读资料都不在这一列——那些正是可以带口音的场合。
 */
export const COMPANION_DOCUMENT_AUTHORING_TOOLS: readonly string[] = Object.freeze([
  "companion_edit_note", "companion_create_note", "companion_write_annotation", "agent_start_goal",
]);

export function companionTurnWritesDocumentContent(candidateOperations: readonly string[]): boolean {
  return candidateOperations.some(name => COMPANION_DOCUMENT_AUTHORING_TOOLS.includes(name));
}

/** Exposure is a view of the project catalog, filtered by current permissions
 * and data-egress policy, never a second collection of tool definitions. */
export function resolveAllCompanionAgentTools(
  permission: CompanionAgentPermissionLevel,
  constraints: CompanionAgentToolExecutionConstraints = {},
): CompanionAgentToolDefinitionV1[] {
  if (!["read_only", "guided", "full"].includes(permission)) return [];
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter(definition =>
    (!isVisionGatedCompanionTool(definition.name) || constraints.visionEnabled === true)
    && (definition.name !== "agent_web_search" || constraints.webSearchEnabled === true)
    && (constraints.noteLibraryReadEnabled !== false
      || !["companion_search_notes", "companion_read_note"].includes(definition.name))
    );
}
export function getCompanionAgentTool(toolName: string): CompanionAgentToolDefinitionV1 | null {
  const entry = getAgentCapability(toolName);
  return entry?.surfaces.includes("conversation") ? entry.definition : null;
}
export function validateCompanionAgentToolArguments(toolName: string, args: unknown) {
  return validateAgentCapabilityArguments(toolName, args, "conversation");
}
