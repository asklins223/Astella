import type { AgentExecutionRefV1, AgentInputRefV1, AgentOperationResultV1, AgentScopeV1 } from "@astella/shared/agent-contracts";
import { readOperationArtifactReceipt } from "./artifact-receipt.ts";
import type { AgentSqlExecutor } from "./store.ts";

export interface OperationReceiptRequest { capability: string; execution: AgentExecutionRefV1; scope: AgentScopeV1; inputs: readonly AgentInputRefV1[] }
export type OperationReceiptV1 = { kind: "result"; result: AgentOperationResultV1 } | { kind: "failed" } | { kind: "pending" };
/** Only a saved, scope-bound artifact is a result. Retired card engines have no receipt reader. */
export async function readOperationResultReceipt(tx: AgentSqlExecutor, request: OperationReceiptRequest): Promise<OperationReceiptV1> {
  if (request.execution.kind !== "job") return { kind: "pending" };
  const artifact = await readOperationArtifactReceipt(tx, { ...request, jobId: request.execution.id });
  return artifact ? { kind: "result", result: { kind: "artifact", artifact } } : { kind: "pending" };
}
