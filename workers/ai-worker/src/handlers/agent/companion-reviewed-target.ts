import { sql, type SQL } from "drizzle-orm";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";

/** Check the reviewed target in the mutation itself, so later edits cannot be deleted. */
export function reviewedTargetMatches(event: AgentEventContext, toolCallId: string | undefined, currentState: SQL): SQL {
  if (!toolCallId) return sql`false`;
  return sql`EXISTS(SELECT 1 FROM companion_agent_tool_calls c JOIN companion_action_proposals p ON p.id=c.proposal_id
    WHERE c.run_id=${event.read.runId} AND c.tool_call_id=${toolCallId} AND p.status='accepted' AND p.decision='confirm'
      AND p.payload->>'kind'='agent_tool_review' AND p.payload->'expectedTarget'=${currentState}
      AND astella_companion_tool_confirmed_v1(c.run_id,c.tool_call_id))`;
}
