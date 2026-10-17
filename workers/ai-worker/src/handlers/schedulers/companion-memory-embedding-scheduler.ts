/**
 * Periodic compensation for memory rows whose embedding write was missed or
 * failed. Ready rows are also sampled daily so a provider/model change is
 * detected by the job's current-model comparison.
 *
 * 「谁该补、怎么排队」整段住在 `astella_enqueue_companion_memory_embedding_repair()`
 * （迁移 0431）：这一轮是**跨账号**扫描后代每个账号入队，worker 裸池上没有
 * `app.user_id`，那条 INSERT 会被 0098 的 jobs 策略直接拒掉。
 */
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { logger } from "../../lib/logger.ts";
import { createTickThrottle } from "./tick-throttle.ts";

const TICK_INTERVAL_MS = 30 * 60 * 1000;
const throttle = createTickThrottle(TICK_INTERVAL_MS);

export async function tickCompanionMemoryEmbeddingScheduler(executor: typeof db = db): Promise<void> {
  const now = Date.now();
  if (!throttle.due(now)) return;
  try {
    const rows = await executor.execute<{ enqueued: number }>(sql`
      SELECT public.astella_enqueue_companion_memory_embedding_repair() AS enqueued
    `);
    throttle.succeed(now);
    const enqueued = Number((Array.isArray(rows) ? rows : [])[0]?.enqueued ?? 0);
    if (enqueued > 0) logger.info({ enqueued }, "companion memory embedding retry jobs enqueued");
  } catch (err) {
    // 这条以前只 warn：调度器的 SQL 引用了 `jobs.created_at`（没这列）加上策略拒绝，
    // 连错 6 小时 4,425 次也没人看见，向量表一直是 0 行。补偿路径坏掉是**事故**，
    // 不是可以下轮再说的抖动。
    throttle.fail(now);
    logger.error({ err }, "companion memory embedding scheduler failed; retrying with backoff");
  }
}

export function resetCompanionMemoryEmbeddingSchedulerForTest(): void {
  throttle.reset();
}
