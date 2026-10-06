import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAgentStore, createAgentMethodStore, startAgentNoteOperation, invokeCardGenerationCapability,
  AgentStoreError, queryRows, type AgentSqlExecutor, type AgentOperationStore } from "@astella/agent-host";
import { agentInputRefV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import type { AgentDirectRequestV1 } from "@astella/shared/agent-request-contracts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkspaceTransaction, type ApiTransaction } from "../db/client.ts";

const ports = { transaction: withWorkspaceTransaction, id: randomUUID };
export const agentMethodStore = createAgentMethodStore(ports);
export const agentStore = createAgentStore({ ...ports,
  ensureIdentity: async (tx, scope) => { await tx.execute(sql`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`); },
  acceptDirectCapability: async (tx, scope, run, call) => {
    const operationStore: AgentOperationStore<ApiTransaction> = { scope, invoke: action => action(tx, run) };
    if (call.name === "card_generation_generate") return invokeCardGenerationCapability(operationStore, call);
    const ref = agentInputRefV1Schema.parse({ kind: "note_version", ...call.arguments });
    return startAgentNoteOperation(tx, scope, run, call, ref);
  },
});

/** The original domain request is frozen before accepting its real operation.
 * Existing domain endpoints keep their job/run receipt and presentation. */
export async function startDomainAgentRequest(scope: AgentScopeV1, directRequest: AgentDirectRequestV1, goal: string,
  idempotencyKey?: string) {
  const sourceId = directRequest.capability === "card_generation_generate" ? idempotencyKey : directRequest.request.requestId;
  if (!sourceId) throw new AgentStoreError(400, "request_id_required", "请重新提交这次请求。");
  const hash = sha256Utf8V1(`${directRequest.capability}:${sourceId}`);
  const requestId = directRequest.capability === "card_generation_generate"
    ? `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}` : sourceId;
  const run = await agentStore.create(scope, { requestId, goal, directRequest,
    inputs: [{ kind: "note_version", noteId: directRequest.noteId, noteVersionId: directRequest.request.noteVersionId }] });
  const operation = run.operations.find(operation => operation.capability === directRequest.capability);
  if (!operation) throw new AgentStoreError(500, "operation_missing", "这次请求暂时没有取得执行回执。");
  return { run, operation };
}

export async function agentRunForDomainExecution(tx: AgentSqlExecutor, scope: AgentScopeV1, kind: "job" | "card_generation", id: string): Promise<string | undefined> {
  const [row] = await queryRows<{ run_id: string }>(tx, sql`SELECT run_id FROM agent_operations
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
    AND ${kind === "job" ? sql`job_id=${id}` : sql`card_generation_run_id=${id}`} LIMIT 1`);
  return row?.run_id;
}
