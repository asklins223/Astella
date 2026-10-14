/**
 * 「这个人此刻在不在正式作答」——伴星能不能出声的唯一判据（doc 34 L12 / L15）。
 *
 * 主动交流准备、提交与语音投递共用这一条判据，避免只在界面隐藏内容，
 * 或在不同服务各写一份 SQL 后逐渐分叉。
 *
 * 判据来自最近仍在活动的 Run、当前题目的 `learning_task_variants.purpose`
 * （`formal | facet | diagnostic | practice`）与 `learning_runs.phase`。
 * 只认**正在作答的那六个阶段**：`recoverable_error` 不算——那一刻人不在答题，
 * 挡她反而让她更找不到北。只看 active_task_id 对应的有效题目版本，
 * 避免拿历史题目挡住伴星。
 */
import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { queryRows, type AgentSqlExecutor } from "@astella/agent-host";

/** 共享的作答阶段判据，避免各条伴星输出路径分叉。 */
export const FORMAL_ANSWER_PHASES = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
] as const;

/** 学习 Run 最长只有数分钟；异常遗留的 active/paused 不能永久静音伴星。 */
export const FORMAL_ANSWER_ACTIVITY_WINDOW_MINUTES = 10;

type WorkerTx = Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0];

/**
 * 「这个人此刻正在正式作答哪一题」——判据与**题目身份**一起给。
 *
 * 为什么把身份也带出来：伴星那句"要不要记账"的判据与"要不要挡她"的判据必须是
 * 同一条（39d W2-6 写 `learning_exposures_v2` 时要拿到**这一题冻结的那一版**
 * objective_id/objective_revision，另写一份 SQL 就会与静音判据分叉）。
 * 快照用 LEFT JOIN LATERAL 取最新一版：没有快照时这一行仍然成立（静音照旧生效），
 * 只是拿不到目标身份——需要身份的那一侧自己判空。
 */
export interface FormalAnswerTarget {
  readonly runId: string;
  readonly taskId: string;
  readonly objectiveId: string | null;
  readonly objectiveRevision: number | null;
  readonly cardId: string | null;
  readonly cardRevision: number | null;
  readonly taskPrompt: string | null;
  readonly publicSummary: string | null;
  readonly canonicalAnswer: string | null;
}

export async function findFormalAnswerTarget(
  tx: AgentSqlExecutor,
  scope: { workspaceId: string; userId: string },
): Promise<FormalAnswerTarget | null> {
  const rows = await queryRows<{
    run_id: string; task_id: string; objective_id: string | null; objective_revision: number | null;
    card_id: string | null; card_revision: number | null; task_prompt: string | null;
    public_summary: string | null; canonical_answer: string | null;
  }>(tx, sql`
    SELECT r.id AS run_id, r.active_task_id AS task_id, t.prompt AS task_prompt,
           snap.objective_id, snap.objective_revision, snap.card_id, snap.card_revision,
           snap.target->>'publicSummary' AS public_summary,
           coalesce(
             snap.canonical_answer->'unit'->>'text',
             -- 结构化答案（units 数组）那一支要先判类型再展开：jsonb_array_elements
             -- 拿到对象会直接报错，而 canonical_answer 两种形状都真实存在。
             -- （注释里不能出现反引号：它在 sql 模板字符串内部会终止字面量。）
             CASE WHEN jsonb_typeof(snap.canonical_answer->'units') = 'array'
                  THEN (SELECT string_agg(unit->>'text', ' ')
                          FROM jsonb_array_elements(snap.canonical_answer->'units') AS unit)
             END
           ) AS canonical_answer
      FROM (
        SELECT workspace_id, user_id, id, active_task_id, phase, updated_at
          FROM learning_runs
         WHERE workspace_id = ${scope.workspaceId}
           AND user_id = ${scope.userId}
         ORDER BY updated_at DESC, created_at DESC, id DESC
         LIMIT 1
      ) r
      JOIN learning_task_variants v ON v.task_id = r.active_task_id
      LEFT JOIN learning_tasks t ON t.id = r.active_task_id
      LEFT JOIN LATERAL (
        SELECT s.objective_id, s.objective_revision, s.card_id, s.card_revision, s.target, s.canonical_answer
          FROM learning_target_snapshots_v2 s
         WHERE s.run_id = r.id AND s.workspace_id = r.workspace_id
         ORDER BY s.frozen_at DESC, s.id DESC
         LIMIT 1
      ) snap ON true
     WHERE v.workspace_id = r.workspace_id
       AND v.user_id = r.user_id
       AND v.status = 'active'
       AND v.purpose = 'formal'
       AND r.phase IN (${sql.join(FORMAL_ANSWER_PHASES.map((phase) => sql`${phase}`), sql`, `)})
       AND r.updated_at > now() - (${FORMAL_ANSWER_ACTIVITY_WINDOW_MINUTES} * interval '1 minute')
     LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    runId: row.run_id,
    taskId: row.task_id,
    objectiveId: row.objective_id ?? null,
    objectiveRevision: row.objective_revision ?? null,
    cardId: row.card_id ?? null,
    cardRevision: row.card_revision ?? null,
    taskPrompt: row.task_prompt ?? null,
    publicSummary: row.public_summary ?? null,
    canonicalAnswer: row.canonical_answer ?? null,
  };
}

/** 只读判据：需要它的调用方决定暂停主动交流、语音或两者。 */
export async function isFormalAnswerInProgress(
  tx: WorkerTx,
  scope: { workspaceId: string; userId: string },
): Promise<boolean> {
  return (await findFormalAnswerTarget(tx, scope)) !== null;
}

export type CompanionVoiceDeliveryDecision =
  | "delivered"
  | "feature_disabled"
  | "formal_answer_in_progress";

/**
 * 这一段回复**该不该变成语音**（文字始终照常下发）。
 *
 * 顺序是有意义的：功能旗标关掉是"这条能力不存在"，正式作答是"存在但这一刻不许打扰"——
 * 两者的日志与排查方向完全不同，合成一个 reason 就把线索抹平了。
 */
export function decideCompanionVoiceDelivery(args: {
  voiceDialogueEnabled: boolean;
  formalAnswerInProgress: boolean;
}): CompanionVoiceDeliveryDecision {
  if (!args.voiceDialogueEnabled) return "feature_disabled";
  if (args.formalAnswerInProgress) return "formal_answer_in_progress";
  return "delivered";
}
