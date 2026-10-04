import { sql } from "drizzle-orm";
import { queryRows, type AgentSqlExecutor } from "@ailearn/agent-host";
import type { AgentScopeV1 } from "@ailearn/shared/agent-contracts";

interface CompanionProfile { name: string; speakingStyle: string; personalityTags: string[]; examples: { text: string }[] }
/** Learning inherits approved collaboration preferences, never old chat tasks or unrelated task memory. */
export async function loadAgentLearningContext(tx: AgentSqlExecutor, scope: AgentScopeV1) {
  const [persona] = await queryRows<{ profile: CompanionProfile | null }>(tx,
    sql`SELECT profile FROM companion_persona_profiles WHERE user_id=${scope.userId}`);
  const memories = await queryRows<{ content: string; applies_when: string | null }>(tx, sql`
    SELECT content,applies_when FROM assistant_memory_items WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND kind='preference' AND user_confirmed=true AND candidate=false
      AND epistemic_status NOT IN ('disputed','superseded') AND scope IN ('global','workspace')
      AND budget_tier IN ('resident','active') AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
      AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now())
    ORDER BY pinned DESC,importance DESC,updated_at DESC,id LIMIT 4`);
  return { persona: persona?.profile ?? null, preferences: memories.map(memory => ({ kind: "preference",
    content: memory.content.slice(0,200), appliesWhen: memory.applies_when?.slice(0,200) ?? null })) };
}
