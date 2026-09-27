import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { RoundServiceError, type NoteLearningRoundV1, type RoundScopeV1 } from "./round-service.ts";

export type RoundModelAttempt = { id: string; maxCalls: number; deadlineAt: number };
/** Caller holds the round lock. Reservations cover retries and survive crashes. */
export async function reserveRoundModelAttempt(tx: ApiTransaction, scope: RoundScopeV1,
  round: NoteLearningRoundV1, modelId: string): Promise<RoundModelAttempt> {
  await tx.execute(sql`UPDATE note_learning_round_model_attempts SET status = 'failed',
    model_calls = reserved_calls, finished_at = expires_at
    WHERE round_id = ${round.roundId} AND workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId} AND status = 'running' AND expires_at <= now()`);
  const rows = await tx.execute(sql`SELECT
    coalesce(sum(CASE WHEN status = 'running' THEN reserved_calls ELSE model_calls END), 0)::int AS calls,
    count(*) FILTER (WHERE status = 'running')::int AS running,
    coalesce(sum(extract(epoch FROM (coalesce(finished_at, now()) - started_at))), 0)::float AS seconds
    FROM note_learning_round_model_attempts WHERE round_id = ${round.roundId}
      AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}`);
  const used = rows[0] as unknown as { calls: number; running: number; seconds: number };
  if (Number(used.running)) throw new RoundServiceError("teaching_in_progress", "这一轮正在准备讲解，稍后会接回已有内容");
  const remaining = round.budgets.maxModelCalls - Number(used.calls);
  if (remaining < 1 || Number(used.seconds) >= round.budgets.maxWallClockSeconds) {
    throw new RoundServiceError("round_budget_exhausted", "这一轮的生成预算已用完；已经拿到的内容不受影响，可以继续读或先结束");
  }
  const durationMs = Math.max(1, Math.floor(Math.min(200, round.budgets.maxWallClockSeconds - Number(used.seconds)) * 1000));
  const attempt = { id: randomUUID(), maxCalls: Math.min(4, remaining), deadlineAt: Date.now() + durationMs };
  await tx.execute(sql`INSERT INTO note_learning_round_model_attempts
    (id, workspace_id, user_id, round_id, model_id, reserved_calls, expires_at)
    VALUES (${attempt.id}, ${scope.workspaceId}, ${scope.userId}, ${round.roundId}, ${modelId},
      ${attempt.maxCalls}, now() + (${durationMs + 30_000} * interval '1 millisecond'))`);
  return attempt;
}

export async function finishRoundModelAttempt(tx: ApiTransaction, scope: RoundScopeV1,
  attempt: RoundModelAttempt, calls: number, success: boolean): Promise<void> {
  const result = await tx.execute(sql`UPDATE note_learning_round_model_attempts
    SET status = ${success ? "succeeded" : "failed"}, model_calls = ${Math.min(attempt.maxCalls, calls)}, finished_at = now()
    WHERE id = ${attempt.id} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'running' AND (${!success} OR expires_at > now()) RETURNING id`);
  if (!result.length && success) throw new RoundServiceError("stale_revision", "这次生成的尝试已过期，刷新后接回当前内容");
}
