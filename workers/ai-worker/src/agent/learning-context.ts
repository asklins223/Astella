import { sql } from "drizzle-orm";
import { queryRows, listAgentMethods, type AgentSqlExecutor } from "@ailearn/agent-host";
import type { AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { resolveCompanionPersonaProfile } from "@ailearn/shared/pet-persona-presets";
import {
  ADOPTABLE_EPISTEMIC_STATUSES,
  ADOPTABLE_PREFERENCE_SCOPES,
  AGENT_PREFERENCE_LIMIT,
  adoptAgentPreferences,
  type AgentPreferenceRow,
} from "./learning-preferences.ts";

interface CompanionProfile { name: string; speakingStyle: string; personalityTags: string[]; examples: { text: string }[] }

/** 白名单拼成 SQL 的 IN 列表——词表只有 `learning-preferences.ts` 那一处定义。 */
const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql`${value}`), sql`, `);

/**
 * Learning inherits approved collaboration preferences, never old chat tasks or unrelated task memory.
 *
 * 三条边界值得留在代码里：
 *
 *   - `user_confirmed AND NOT candidate` 两条都要留着。0267 的铺开函数把副本的
 *     `candidate` 硬写成 false，跨空间副本因此天生「非候选」，真正挡住模型推断的
 *     只有 `user_confirmed`。
 *   - `workspace_id` + `user_id` 照旧，不跨空间读。账号级规则靠 0267 的铺开与 0268
 *     的副本同步进来，所以空间内内容不会因为这一行被提升成账号级。
 *   - 来源抑制（`assistant_memory_source_suppressions`）是**写端**守卫，删记忆时
 *     写下墓碑。读侧判它会把 `restoreDeletedMemory` 明确保留墓碑的那条恢复路径
 *     （用户从回收区把这条放回来）变成永久消失。
 */
export async function loadAgentLearningContext(tx: AgentSqlExecutor, scope: AgentScopeV1) {
  const [persona] = await queryRows<{ profile: CompanionProfile | null }>(tx,
    sql`SELECT profile FROM companion_persona_profiles WHERE user_id=${scope.userId}`);
  const rows = await queryRows<AgentPreferenceRow>(tx, sql`
    SELECT id,revision,scope,content,applies_when,epistemic_status FROM assistant_memory_items
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND kind='preference' AND user_confirmed=true AND candidate=false
      AND epistemic_status IN (${inList(ADOPTABLE_EPISTEMIC_STATUSES)})
      AND scope IN (${inList(ADOPTABLE_PREFERENCE_SCOPES)})
      AND budget_tier IN ('resident','active') AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
      AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now())
    ORDER BY pinned DESC,importance DESC,updated_at DESC,id LIMIT ${AGENT_PREFERENCE_LIMIT}`);
  // 账号没写过人格档案时给系统默认人格，而不是 null：正式学习也由"某个人"来做，
  // 而不是一个没有性格的通用助手（用户 2026-10-05 的决定）。
  return { persona: resolveCompanionPersonaProfile(persona?.profile ?? null), preferences: adoptAgentPreferences(rows),
    methods: (await listAgentMethods(tx,scope,true)).map(method => ({ methodId: method.methodId, revision: method.revision,
      title: method.title, appliesWhen: method.appliesWhen })) };
}
