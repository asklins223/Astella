import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAgentStore, createAgentMethodStore, startAgentNoteOperation, queryRows,
  AgentStoreError, type AgentSqlExecutor } from "@astella/agent-host";
import { agentInputRefV1Schema, type AgentScopeV1 } from "@astella/shared/agent-contracts";
import type { AgentDirectRequestV1 } from "@astella/shared/agent-request-contracts";
import { withWorkspaceTransaction } from "../db/client.ts";
import { requireAiExecutionConsent } from "../lib/ai-execution-consent.ts";

const ports = { transaction: withWorkspaceTransaction, id: randomUUID };
export const agentMethodStore = createAgentMethodStore(ports);
export const agentStore = createAgentStore({ ...ports,
  assertExecutionAllowed: requireAiExecutionConsent,
  ensureIdentity: async (tx, scope) => { await tx.execute(sql`INSERT INTO user_companion_account_state(user_id) VALUES(${scope.userId}) ON CONFLICT(user_id) DO NOTHING`); },
  acceptDirectCapability: async (tx, scope, run, call) => {
    const ref = agentInputRefV1Schema.parse({ kind: "note_version", ...call.arguments });
    return startAgentNoteOperation(tx, scope, run, call, ref);
  },
});

/** The original domain request is frozen before accepting its real operation.
 * Existing domain endpoints keep their job/run receipt and presentation. */
export async function startDomainAgentRequest(scope: AgentScopeV1, directRequest: AgentDirectRequestV1, goal: string) {
  const sourceId = "requestId" in directRequest.request ? directRequest.request.requestId : undefined;
  if (!sourceId) throw new AgentStoreError(400, "request_id_required", "请重新提交这次请求。");
  const requestId = sourceId;
  const run = await agentStore.create(scope, { requestId, goal, directRequest,
    inputs: [{ kind: "note_version", noteId: directRequest.noteId, noteVersionId: directRequest.request.noteVersionId }] });
  const operation = run.operations.find(operation => operation.capability === directRequest.capability);
  if (!operation) throw new AgentStoreError(500, "operation_missing", "这次请求暂时没有取得执行回执。");
  return { run, operation };
}

export async function agentRunForDomainExecution(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string): Promise<string | undefined> {
  const [row] = await queryRows<{ run_id: string }>(tx, sql`SELECT run_id FROM agent_operations
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND job_id=${id} LIMIT 1`);
  return row?.run_id;
}
