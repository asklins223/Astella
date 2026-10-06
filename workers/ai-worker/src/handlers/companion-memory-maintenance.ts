/**
 * 桌宠记忆衰减维护 tick（22-real-desktop-pet-memory-context-prd-tdd.md §10.6）。
 *
 * 通过 SECURITY DEFINER 函数 astella_run_companion_memory_maintenance() 执行，
 * 避免 Worker 受 RLS 限制无法跨用户扫描。默认每日一次。
 *
 * 多副本守卫：一次维护是否已完成由数据库中的日期键原子记录，不能只依赖进程内
 * 节流或事务级 advisory lock（后者只能互斥，不能阻止同一天稍后再次执行）。
 */

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

let lastMaintenanceAt = 0;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 下面两个兜底清理的节流间隔。
 *
 * ## 为什么需要（2026-10-02 实测事故）
 *
 * 这两个查询原先**完全没有节流**——上面那次每日维护有 `lastMaintenanceAt`，
 * 它们没有，而同目录所有兄弟调度器都有（30s ~ 60min）。于是 DB 一旦报错
 * （这次是 0345/0346 漏授 `astella_worker`，`42501 permission denied`），
 * 失败就被 catch 成一条 WARN，下一 tick 再来一次，永不停止。
 *
 * 而 worker 的 tick 退避是坏的：`index.ts` 在 `claimJobs` 成功后无条件
 * `currentPollMs = POLL_MS`，紧接着才 ×2，所以封顶在 1000ms，`POLL_MAX_MS`
 * （5000）永远到不了。实测这条循环稳定在 **1 次/秒**，跑了 18 小时：
 * worker 日志 13 万条 WARN / 43.8 MB，postgres 侧 62,753 条 ERROR。
 *
 * ## 为什么间隔是「到点就跑」而不是「成功才推进」
 *
 * 本文件的 `tickCompanionMemoryMaintenance` 与 proposal-expiry 那类调度器
 * 不同：它们是「成功后推进 `lastXAt`」，DB 抖动时下一轮立刻重试——那在 30s
 * 节流下只是 30s 一次重试，可以接受。而这里是**兜底清理**，正确性取决于
 * 「有没有到期行」，落后一两个小时无害（到期行还在，下一轮照删）。
 * 若这里也「成功后推进」，持续失败就等于没有节流——正是这次事故的形态。
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanupAt = 0;

export async function tickCompanionMemoryMaintenance(): Promise<void> {
  const now = Date.now();
  // 进程内节流只用于减少查询；数据库日期键才是跨副本的一次性正确性门。
  // 只有 SQL 成功返回后才推进本地时间戳，DB 故障会在下一轮重试。
  if (now - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
    try {
      const rows = await db.execute<{ maintained: number }>(sql`
        SELECT public.astella_run_companion_memory_maintenance() AS maintained
      `);
      lastMaintenanceAt = now;
      const maintained = Number((Array.isArray(rows) ? rows : [])[0]?.maintained ?? 0);
      if (maintained > 0) {
        logger.info({ maintained }, "companion memory maintenance completed");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "companion memory maintenance failed",
      );
    }
  }

  // §10.5 关系状态衰减也由同一个 SECURITY DEFINER 函数在同一日期门内完成，
  // 避免记忆归档与关系衰减出现不同步的“每日”语义。

  // 两个兜底清理共用一道 1 小时的门（理由见 CLEANUP_INTERVAL_MS）。
  // 时间戳**在查询前**推进：到点就跑，不等查询结果。持续失败时最坏情况是
  // 每小时两条 WARN，而不是每个 tick 两条。
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  // 回收区到期清理（0345）。它**不在**上面那个日期门里：
  // 那道门是「每日一次」，而清理的正确性取决于「有没有到期行」，
  // 每天查一次已经足够——但它与衰减是两件事，混进同一个计数会让
  // 「今天维护了多少」这个读数同时包含两件不相干的事。
  // 失败不影响衰减：清理是兜底，不是业务路径。
  try {
    const purged = await db.execute<{ purged: number }>(sql`
      SELECT public.astella_purge_expired_companion_memory() AS purged
    `);
    const count = Number((Array.isArray(purged) ? purged : [])[0]?.purged ?? 0);
    if (count > 0) logger.info({ purged: count }, "expired companion memory recycled rows purged");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion memory recycle-bin purge failed",
    );
  }

  // 归档保留上限（0346 / A74「归档也受保留上限」）。
  // 它是**淘汰**而不是拒绝移入——拒绝会让归档满了之后连删记忆都做不到。
  try {
    const evicted = await db.execute<{ evicted: number }>(sql`
      SELECT public.astella_enforce_companion_memory_retention() AS evicted
    `);
    const count = Number((Array.isArray(evicted) ? evicted : [])[0]?.evicted ?? 0);
    if (count > 0) logger.info({ evicted: count }, "archived companion memory retention sweep evicted rows");
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "companion memory retention sweep failed",
    );
  }
}

/** 测试用：重置进程内节流（生产代码不要调用）。 */
export function resetCompanionMemoryMaintenanceThrottleForTest(): void {
  lastMaintenanceAt = 0;
  lastCleanupAt = 0;
}
