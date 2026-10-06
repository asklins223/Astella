import { sql } from "drizzle-orm";
import {
  MAX_NO_PROGRESS_ATTEMPTS,
  decideCompactionAttempt,
  recordCompactionAttempt,
  type CompactionCooldownDecision, type CompactionCooldownState,
} from "@astella/agent-core";
import type { ContextPressureReasonV1 } from "@astella/shared/context-budget-contracts";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/**
 * 方案 44 §5.4 后半：压缩的失败冷却与无进展状态，落在数据库上。
 *
 * 纯判定在 agent-core（`compaction-cooldown.ts`），这里只做存取与范围校验——
 * 冷却是**跨轮次**的记忆，必须能活过一次 turn，否则「同一失败输入每轮重触发」照旧。
 */

export interface CompactionStateKey {
  conversationId: string;
  /** 来源版本：摘要的 coverage_source_hash，或消息范围的哈希。 */
  sourceHash: string;
  providerId: string;
  modelId: string;
}

interface CompactionStateRow extends Record<string, unknown> {
  attempts: number;
  no_progress_streak: number;
  last_reason: string | null;
  last_input_tokens: string | null;
  last_attempt_at: Date | string | null;
}

function toState(row: CompactionStateRow | undefined): CompactionCooldownState | null {
  if (!row) return null;
  return {
    attempts: Number(row.attempts ?? 0),
    noProgressStreak: Number(row.no_progress_streak ?? 0),
    lastReason: (row.last_reason as ContextPressureReasonV1 | null) ?? null,
    lastInputTokens: row.last_input_tokens === null ? null : Number(row.last_input_tokens),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at) : null,
  };
}

/**
 * 读一份失败状态。范围校验在会话与本人上——冷却记录也是私人数据，
 * 跨用户读到别人的失败历史等于泄露「他曾经发不过什么」。
 */
export async function readCompactionCooldownState(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  key: CompactionStateKey,
): Promise<CompactionCooldownState | null> {
  const rows = await queryRows<CompactionStateRow>(tx, sql`
    SELECT attempts, no_progress_streak, last_reason,
           last_input_tokens::text AS last_input_tokens, last_attempt_at
    FROM agent_context_compaction_state
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND conversation_id = ${key.conversationId}
      AND source_hash = ${key.sourceHash}
      AND provider_id = ${key.providerId} AND model_id = ${key.modelId}
  `);
  return toState(rows[0]);
}

/**
 * 记一次尝试的结果（UPSERT），返回**这一行现在**的状态。
 *
 * ## 计数必须在 SQL 里自增，不能读出来在 JS 里加完再写回
 *
 * 原来的形状是「SELECT 读 → JS 里算 next → UPSERT 写 next 的绝对值」。唯一索引挡住了
 * 「各插一行」，但挡不住**同一行上的丢失更新**：两次并发的尝试都读到 attempts=0，
 * 都算出 1，都写 1，计数被抹平。
 *
 * 后果不是「少记一次」：`MAX_COMPACTION_ATTEMPTS` 的全部意义就是「反复失败会停下来」，
 * 计数被抹平意味着一个重试的系统会一直以为自己还有额度，于是每轮都折、每轮都等，
 * 情况一点没变——正是 §5.4 明令禁止的那条路。并发不是假设：闸拦下之后 fold + 重发
 * 可能与下一次心跳重叠，两个 job 也可能拿到同一个 run。
 *
 * 所以 `attempts` 走 `agent_context_compaction_state.attempts + 1`，由数据库算；
 * 无进展判定同样在 SQL 里对照**行上真实的** `last_input_tokens`，而不是那份可能已经
 * 过期的读。纯判定（`recordCompactionAttempt`）仍留给调用方读状态时用——它决定
 * 「这一轮该不该折」，而「记一次」必须由数据库说了算。
 */
export async function recordCompactionAttemptState(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  key: CompactionStateKey,
  input: { inputTokens: number; reason: ContextPressureReasonV1; at: Date },
): Promise<CompactionCooldownState> {
  // `Date` 对象要在这里转成字符串再进参数：drizzle 的字符串参数序列化器不接受
  // Date 实例，会抛 `The "string" argument must be of type string`。这条路径此前
  // **从未在真实数据库上跑过**，所以它一直没被发现（0385 冷却状态写不进去）。
  const attemptedAt = input.at.toISOString();
  const rows = await queryRows<CompactionStateRow>(tx, sql`
    INSERT INTO agent_context_compaction_state
      (workspace_id, user_id, conversation_id, source_hash, provider_id, model_id,
       attempts, no_progress_streak, last_reason, last_input_tokens, last_attempt_at, updated_at)
    VALUES
      (${scope.workspaceId}, ${scope.userId}, ${key.conversationId}, ${key.sourceHash},
       ${key.providerId}, ${key.modelId}, 1, 0,
       ${input.reason}, ${input.inputTokens}, ${attemptedAt}::timestamptz, now())
    ON CONFLICT (workspace_id, user_id, conversation_id, source_hash, provider_id, model_id)
    DO UPDATE SET attempts = agent_context_compaction_state.attempts + 1,
                  no_progress_streak = CASE
                    WHEN agent_context_compaction_state.attempts = 0 THEN 0
                    WHEN EXCLUDED.last_input_tokens < agent_context_compaction_state.last_input_tokens
                      THEN 0
                    ELSE LEAST(agent_context_compaction_state.no_progress_streak + 1, ${MAX_NO_PROGRESS_ATTEMPTS} + 1)
                  END,
                  last_reason = EXCLUDED.last_reason,
                  last_input_tokens = EXCLUDED.last_input_tokens,
                  last_attempt_at = EXCLUDED.last_attempt_at,
                  updated_at = now()
    RETURNING attempts, no_progress_streak, last_reason,
              last_input_tokens::text AS last_input_tokens, last_attempt_at
  `);
  if (rows[0]) return toState(rows[0])!;
  // 拿不到 RETURNING（例如 RLS 过滤掉了刚写的行）时退回读一次，至少不留空状态。
  return (await readCompactionCooldownState(tx, scope, key))
    ?? recordCompactionAttempt({ state: null, ...input });
}

/** 一次「该不该折」的完整判定：读状态 → 纯判定。调用方在真正折完后再写回。 */
export async function decideStoredCompactionAttempt(
  tx: AgentSqlExecutor,
  scope: AgentScopeV1,
  key: CompactionStateKey,
  now: Date,
): Promise<CompactionCooldownDecision> {
  return decideCompactionAttempt({ state: await readCompactionCooldownState(tx, scope, key), now });
}
