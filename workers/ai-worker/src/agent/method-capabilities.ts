import { readAgentMethod, listAgentMethods, AgentStoreError } from "@ailearn/agent-host";
import { methodAgentCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import type { AgentWorkerAdvanceStore } from "./store.ts";

export async function invokeMethodCapability(store: AgentWorkerAdvanceStore, call: { name: string; arguments: Record<string, unknown> }) {
  const entry = methodAgentCapabilityManifest.find(entry => entry.definition.name === call.name);
  if (!entry) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  const input = entry.argumentSchema.parse(call.arguments) as { methodId: string; expectedRevision: number };
  return store.invoke(async (tx, run) => {
    const catalog = await listAgentMethods(tx,store.scope,true);
    if (!catalog.some(method => method.methodId===input.methodId && method.revision===input.expectedRevision))
      throw new AgentStoreError(422,"method_unavailable","这个方法现在不能采用，请核对当前材料与做法。");
    const method = await readAgentMethod(tx, store.scope,input.methodId,input.expectedRevision,
      { kind: "agent_goal", id: run.id, revision: run.revision, sourceKey: `goal:${run.id}:${run.revision}:${input.methodId}` });
    if (!method) throw new AgentStoreError(422,"method_unavailable","这个方法的版本或依据已变化。");
    return { status: "succeeded", methodId: method.methodId, revision: method.revision,
      title: method.title, appliesWhen: method.appliesWhen, steps: method.steps, exceptions: method.exceptions,
      instruction: "本方法仅作合作指引；读取新材料，遵守当前目标与权限，不复用旧产物或旧授权。" };
  });
}
