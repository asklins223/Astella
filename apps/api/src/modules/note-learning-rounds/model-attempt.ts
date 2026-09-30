import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { RoundServiceError, type NoteLearningRoundV1, type RoundScopeV1 } from "./round/round-service.ts";

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
  // 这一次预留的墙钟。**200s 那个值是在"产物是一小段 JSON"的时候定的**，2026-09-28 连着
  // 抬了两次，数字都来自真窗口实测而不是估的：
  //
  //   200s → 讲解 + 核对就吃掉 163s，产物分到 36.6s 超时 → 抬到 420s
  //   420s → 富笔记（IndexTTS，71 块）上讲解 ≈ 270s、核对 ≈ 150s，产物又只剩 ≈ 90s，
  //          生成一整页（可到两万 token）依然超时（`step exceeded 89999ms`）→ 抬到 780s
  //
  // 780s 装得下实测的 ≈ 620s 三段，也仍在**这一轮 1800s 的总预算之内**——留出一次
  // 重来的余量。装不下时**如实**按（剩余墙钟）截断，不假装还有时间。
  //
  // 注意它和 `maxModelCalls` 必须一起看：调用数够、墙钟不够的话，先撞的永远是墙钟，
  // 于是"还有调用余量"这件事会变成一句没有意义的话（这正是 900s 与 16 次那一版的教训）。
  const durationMs = Math.max(1, Math.floor(Math.min(780, round.budgets.maxWallClockSeconds - Number(used.seconds)) * 1000));
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
