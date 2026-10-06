import { calculateAgentExpression } from "@astella/agent-core";
import { AgentStoreError } from "@astella/agent-host";
import { basicAgentCapabilityManifest } from "@astella/shared/agent-capabilities";
import type { AgentWorkerAdvanceStore } from "./store.ts";

/** Both hosts validate and execute the same pure calculation capability. */
export function executeBasicCapability(call: {name:string;arguments:Record<string,unknown>}) {
  const entry = basicAgentCapabilityManifest.find(m=>m.definition.name===call.name);
  if (!entry) throw new AgentStoreError(400,"unknown_capability","当前没有这项能力。");
  const input = entry.argumentSchema.parse(call.arguments) as {expression:string;variables?:{name:string;value:number}[]};
  return {status:"succeeded" as const,...calculateAgentExpression(input.expression,input.variables)};
}

export async function invokeBasicCapability(store:AgentWorkerAdvanceStore,call:{name:string;arguments:Record<string,unknown>}) {
  return store.invoke(()=>Promise.resolve(executeBasicCapability(call)));
}
