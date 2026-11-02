import { sql } from "drizzle-orm";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { decodeCompanionToolResult } from "../agent/companion-runtime-checkpoint.ts";
import type { VerifiedDocumentRedirect } from "../../agent/external-capabilities.ts";

/** Only durable, successful reads in this scoped run can establish a redirect.
 * The caller still checks that its original root URL is currently authorized. */
export async function readCompanionDocumentRedirects(scope: AgentScopeV1, runId: string): Promise<VerifiedDocumentRedirect[]> {
  const rows = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{
    arguments: { url?: unknown }; result_payload: unknown;
  }>(sql`SELECT arguments,result_payload FROM companion_agent_tool_calls
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND run_id=${runId}
      AND name IN ('web.read_document','agent_read_public_document') AND status='succeeded'
    ORDER BY created_at,id`));
  return Array.from(rows).flatMap(row => {
    const result = decodeCompanionToolResult(row.result_payload);
    return typeof row.arguments.url === "string" && result?.value.status === "succeeded"
      && typeof result.value.url === "string" && typeof result.value.contentHash === "string"
      ? [{ requestedUrl: row.arguments.url, url: result.value.url }] : [];
  });
}
