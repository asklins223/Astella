/**
 * 后台记忆整理的**调度 tick**（40 §4.6.3）。
 *
 * ## 为什么它只做一件事
 *
 * 「哪些 (workspace_id, user_id) 够格整理」是跨用户的计数，RLS 下 worker
 * 读不到别人的行，所以这一问在数据库侧（0361 的
 * `astella_enqueue_companion_memory_organize`，SECURITY DEFINER）。
 * 本文件只负责**把那个函数定期叫醒**，并把结果记成一行计数。
 *
 * 真正「这一轮跑不跑、跑几条、怎么处置」在 worker 侧
 * （`companion-memory-organize.ts`），用的是同一份判据
 * （`memoryOrganizationGate`）。两处各判一次是有意的：
 * DB 侧少投（省掉不必要的 job），worker 侧多判一次（租约与积压可能在这几分钟里变了）。
 *
 * ## 为什么是 1 小时
 *
 * 阈值本身是「30 天」或「7 天 + 30 条」，一小时的分辨率已经绰绰有余；
 * 再密只是多几次函数调用。再疏则「攒够了却等一天」——对一个每天都在
 * 说话的���来说，一天之后她才整理，看起来像没生效。
 *
 * 与同目录兄弟调度器共用 `tick-throttle.ts`：成功才推进周期，DB 抖动下一拍重试，
 * 连败则指数退避到一个完整周期为止。
 */
import { sql } from "drizzle-orm";

import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { createTickThrottle } from "./tick-throttle.ts";

const TICK_INTERVAL_MS = 60 * 60 * 1000;
const throttle = createTickThrottle(TICK_INTERVAL_MS);

export async function tickCompanionMemoryOrganizeScheduler(): Promise<void> {
  const now = Date.now();
  if (!throttle.due(now)) return;
  try {
    const rows = await db.execute<{ enqueued: number }>(sql`
      SELECT public.astella_enqueue_companion_memory_organize() AS enqueued
    `);
    throttle.succeed(now);
    const enqueued = Number((Array.isArray(rows) ? rows : [])[0]?.enqueued ?? 0);
    if (enqueued > 0) {
      logger.info({ enqueued }, "companion memory organize jobs enqueued");
    }
  } catch (err) {
    // 不推进周期：下一拍先重试一次；连败则指数退避，最长退到一个完整周期。
    // 以前连败也每拍撞（主循环 500ms～5s），一次 42501 就能把日志和 CPU 打满——
    // 正是 2026-10-02 那场事故的形状。
    throttle.fail(now);
    logger.warn(
      { err },
      "companion memory organize enqueue failed; retrying with backoff",
    );
  }
}