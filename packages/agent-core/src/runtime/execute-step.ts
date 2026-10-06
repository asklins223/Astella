import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

export interface AgentStepPorts<TCheckpoint, TResult> {
  signal?: AbortSignal;
  context: { prepare(): Promise<AgentTurnRequest> };
  state: {
    prepare(request: AgentTurnRequest): Promise<{ checkpoint: TCheckpoint; request: AgentTurnRequest; response: AgentTurnResult | null }>;
    saveResponse(checkpoint: TCheckpoint, response: AgentTurnResult): Promise<void>;
    apply(checkpoint: TCheckpoint, response: AgentTurnResult, results: AgentTurnRequest["messages"]): Promise<TResult>;
  };
  model: { execute(request: AgentTurnRequest, checkpoint: TCheckpoint): Promise<AgentTurnResult> };
  capabilities: { maxCalls: number; invoke(call: AgentTurnResult["toolCalls"][number], allowed: boolean): Promise<unknown> };
}

/** Checkpoint the model response before any capability can commit an effect. */
export async function executeAgentStep<TCheckpoint, TResult>(ports: AgentStepPorts<TCheckpoint, TResult>): Promise<TResult> {
  ports.signal?.throwIfAborted();
  const prepared = await ports.state.prepare(await ports.context.prepare());
  const response = prepared.response ?? await ports.model.execute(prepared.request, prepared.checkpoint);
  if (!prepared.response) await ports.state.saveResponse(prepared.checkpoint, response);
  const results: AgentTurnRequest["messages"] = [];
  for (const [index, call] of response.toolCalls.entries()) {
    ports.signal?.throwIfAborted();
    const value = await ports.capabilities.invoke(call, index < ports.capabilities.maxCalls);
    results.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(value) });
  }
  ports.signal?.throwIfAborted();
  return ports.state.apply(prepared.checkpoint, response, results);
}
