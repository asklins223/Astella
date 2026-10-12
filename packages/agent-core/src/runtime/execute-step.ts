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
  /** Every call the model actually made this step runs. A step is not a ticket quota. */
  capabilities: { invoke(call: AgentTurnResult["toolCalls"][number]): Promise<unknown> };
}

/** Checkpoint the model response before any capability can commit an effect. */
export async function executeAgentStep<TCheckpoint, TResult>(ports: AgentStepPorts<TCheckpoint, TResult>): Promise<TResult> {
  ports.signal?.throwIfAborted();
  const prepared = await ports.state.prepare(await ports.context.prepare());
  const response = prepared.response ?? await ports.model.execute(prepared.request, prepared.checkpoint);
  if (!prepared.response) await ports.state.saveResponse(prepared.checkpoint, response);
  const results: AgentTurnRequest["messages"] = [];
  for (const call of response.toolCalls) {
    ports.signal?.throwIfAborted();
    results.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(await ports.capabilities.invoke(call)) });
  }
  ports.signal?.throwIfAborted();
  return ports.state.apply(prepared.checkpoint, response, results);
}
