import { agentGoalToolManifest, noteAgentCapabilityManifest, cardAgentCapabilityManifest,
  methodAgentCapabilityManifest, basicAgentCapabilityManifest, externalAgentCapabilityManifest,
  agentGoalDeliveryManifest } from "./agent-capability-manifests.ts";
import { companionCapabilityManifest } from "./companion-capability-manifest.ts";
import type { AgentCapabilityDeclaration } from "./agent-capability-definition.ts";

export type AgentCapabilitySurface = "conversation" | "goal";
export type AgentCapabilityExecutor = "companion" | "goal_control" | "note" | "card" | "method" | "basic" | "external" | "delivery";
export interface AgentCapabilityEntry extends AgentCapabilityDeclaration {
  readonly executor: AgentCapabilityExecutor;
  readonly surfaces: readonly AgentCapabilitySurface[];
  readonly requires: "frozenNote" | "confirmedMethod" | null;
}

const groups: readonly { entries: readonly AgentCapabilityDeclaration[]; executor: AgentCapabilityExecutor;
  surfaces: readonly AgentCapabilitySurface[]; requires: AgentCapabilityEntry["requires"] }[] = [
  { entries: agentGoalToolManifest, executor: "goal_control", surfaces: ["conversation"], requires: null },
  { entries: basicAgentCapabilityManifest, executor: "basic", surfaces: ["conversation", "goal"], requires: null },
  { entries: externalAgentCapabilityManifest, executor: "external", surfaces: ["conversation", "goal"], requires: null },
  { entries: companionCapabilityManifest, executor: "companion", surfaces: ["conversation"], requires: null },
  { entries: noteAgentCapabilityManifest, executor: "note", surfaces: ["goal"], requires: "frozenNote" },
  { entries: cardAgentCapabilityManifest, executor: "card", surfaces: ["goal"], requires: "frozenNote" },
  { entries: methodAgentCapabilityManifest, executor: "method", surfaces: ["goal"], requires: "confirmedMethod" },
  { entries: [agentGoalDeliveryManifest], executor: "delivery", surfaces: ["goal"], requires: null },
];

/** The only project capability index. Domain files contain declarations;
 * conversation/goal lists are projections, not independent registrations. */
export const agentCapabilityCatalog: readonly AgentCapabilityEntry[] = Object.freeze(groups.flatMap(group =>
  group.entries.map(entry => Object.freeze({ ...entry, executor: group.executor, surfaces: group.surfaces, requires: group.requires }))));
const capabilitiesByName = new Map<string, AgentCapabilityEntry>();
for (const entry of agentCapabilityCatalog) {
  if (capabilitiesByName.has(entry.definition.name)) throw new Error(`Duplicate Agent capability: ${entry.definition.name}`);
  capabilitiesByName.set(entry.definition.name, entry);
}
export function getAgentCapability(name: string): AgentCapabilityEntry | undefined { return capabilitiesByName.get(name); }
/**
 * 这一步的工具面上真的有这些工具时，才把它们自带的场景指引拼出来（方案 50 §7）。
 *
 * 顺序按传进来的工具面走，并去重：好几条导航能力共用同一段措辞，重复进 prompt
 * 只是占预算。判据是**工具面**（由声明装配），不是本轮被猜成什么意图——
 * 面里没有编辑工具时，那段块序号规程就不该出现在一次招呼的请求里。
 */
export function collectAgentCapabilitySceneGuidance(
  toolNames: readonly string[], permissionLevel: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of toolNames) {
    const guidance = capabilitiesByName.get(name)?.sceneGuidance;
    if (!guidance) continue;
    for (const line of [...(guidance.shared ?? []),
      ...(permissionLevel === "full" ? guidance.full ?? [] : guidance.guided ?? [])]) {
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}
export function validateAgentCapabilityArguments(name: string, args: unknown, surface?: AgentCapabilitySurface):
  { success: true; data: Record<string, unknown> } | { success: false; reason: string } {
  const entry = getAgentCapability(name);
  if (!entry || (surface && !entry.surfaces.includes(surface)))
    return { success: false, reason: "这个工具的参数要求没有登记，这一步没有执行" };
  const parsed = entry.argumentSchema.safeParse(args);
  return parsed.success ? { success: true, data: parsed.data }
    : { success: false, reason: "这一步要填的内容没有对上，没有执行" };
}
