import { sql } from "drizzle-orm";
import { companionToolConfirmationStage, getCompanionAgentTool, proposedLearningActionPayloadV1Schema,
  validateCompanionAgentToolArguments } from "@astella/shared";
import type { ApiTransaction } from "../../db/client.ts";
import { CompanionConversationError } from "./turn/turn-service.ts";

/** Confirm this frozen call, never raise the user's general permission level. */
export async function acceptCompanionToolReview(tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  proposal: { id: string; agent_run_id: string | null; agent_tool_call_id: string | null },
  payload: unknown, decisionKeyHash: string): Promise<boolean> {
  const parsed = proposedLearningActionPayloadV1Schema.safeParse(payload);
  if (!parsed.success || parsed.data.kind !== "agent_tool_review") return false;
  const review = parsed.data;
  const definition = getCompanionAgentTool(review.toolName);
  const validated = definition ? validateCompanionAgentToolArguments(definition.name, review.arguments) : null;
  if (!definition || !validated?.success || companionToolConfirmationStage(definition, review.arguments) !== review.confirmationStage)
    throw new CompanionConversationError("ACTION_STALE", 409, "reviewed tool arguments are no longer valid");
  const rows = await tx.execute(sql`
    SELECT c.id FROM companion_agent_tool_calls c JOIN companion_turn_runs r ON r.id=c.run_id
    WHERE c.run_id=${proposal.agent_run_id}::uuid AND c.tool_call_id=${proposal.agent_tool_call_id}
      AND c.proposal_id=${proposal.id}::uuid AND c.name=${review.toolName}
      AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
      AND c.arguments=${JSON.stringify(validated.data)}::jsonb AND c.status='waiting_confirmation'
      AND r.status='waiting_for_confirmation' AND r.waiting_proposal_id=${proposal.id}::uuid
      AND r.cancel_requested_at IS NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') tool
        WHERE tool->>'name'=c.name) FOR UPDATE OF c,r`);
  if (!rows.length) throw new CompanionConversationError("ACTION_STALE", 409, "review no longer belongs to a waiting tool call");
  await tx.execute(sql`UPDATE companion_action_proposals SET status='accepted',decision='confirm',decided_at=now(),
    decision_key_hash=${decisionKeyHash},updated_at=now() WHERE id=${proposal.id}::uuid`);
  return true;
}
