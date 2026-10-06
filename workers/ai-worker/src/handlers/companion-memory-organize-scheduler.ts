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
 * 与同目录兄弟调度器一致：**成功才推进本地时间戳**，DB 抖动时下一轮立刻重试。
 */
import { sql } from "drizzle-orm";

import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const TICK_INTERVAL_MS = 60 * 60 * 1000;
let lastTickAt = 0;

export async function tickCompanionMemoryOrganizeScheduler(): Promise<void> {
  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return;
  try {
    const rows = await db.execute<{ enqueued: number }>(sql`
      SELECT public.astella_enqueue_companion_memory_organize() AS enqueued
    `);
    lastTickAt = now;
    const enqueued = Number((Array.isArray(rows) ? rows : [])[0]?.enqueued ?? 0);
    if (enqueued > 0) {
      logger.info({ enqueued }, "companion memory organize jobs enqueued");
    }
  } catch (err) {
    // 不推进 lastTickAt：下一轮立刻重试。这与「兜底清理」类调度器相反，
    // 理由是那个文件头写着的 2026-10-02 事故——持续失败又没有节流会打满日志。
    logger.warn(
      { err },
      "companion memory organize enqueue failed; retrying next tick",
    );
  }
}