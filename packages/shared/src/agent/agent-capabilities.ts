export { agentGoalToolManifest, noteAgentCapabilityManifest, cardAgentCapabilityManifest,
  methodAgentCapabilityManifest, basicAgentCapabilityManifest, externalAgentCapabilityManifest,
  agentGoalDeliveryManifest } from "./agent-capability-manifests.ts";
import { agentCapabilityCatalog, getAgentCapability, type AgentCapabilityEntry } from "./agent-capability-catalog.ts";

export const agentGoalExecutionManifest = agentCapabilityCatalog.filter(entry => entry.surfaces.includes("goal"));
export const agentGoalCapabilityManifest = agentGoalExecutionManifest.filter(entry => entry.executor !== "delivery");

export function resolveAgentGoalExecutionManifest(context: {
  notes: readonly { noteId: string; noteVersionId: string }[];
  methods: readonly { methodId: string; revision: number }[];
}): AgentCapabilityEntry[] {
  return agentGoalExecutionManifest.flatMap(entry => {
    const values = entry.requires === "frozenNote"
      ? { noteId: context.notes.map(note => note.noteId), noteVersionId: context.notes.map(note => note.noteVersionId) }
      : entry.requires === "confirmedMethod"
        ? { methodId: context.methods.map(method => method.methodId), expectedRevision: context.methods.map(method => method.revision) }
        : null;
    if (values && Object.values(values).some(list => !list.length)) return [];
    if (!values) return [entry];
    const parameters = entry.definition.parameters;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    // Model hints do not grant authority: the executor validates scope and the
    // paired material/method version again immediately before use.
    return [{ ...entry, definition: { ...entry.definition, parameters: { ...parameters, properties: {
      ...properties, ...Object.fromEntries(Object.entries(values).map(([name, allowed]) =>
        [name, { ...properties[name], enum: [...new Set(allowed)] }])),
    } } } }];
  });
}
export function agentCapabilityLabel(name: string): string | undefined {
  return getAgentCapability(name)?.presentation.label;
}
