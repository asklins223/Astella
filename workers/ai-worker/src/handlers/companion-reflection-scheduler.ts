/**
 * 后台反思的**调度 tick**（方案 50 §9.1）。
 *
 * 与记忆整理那一位兄弟同一形状：「哪些会话段落够格回顾」是跨用户的计数，
 * RLS 下 worker 读不到别人的行，所以那一问在库里（0400 的
 * `astella_enqueue_companion_reflection`）。本文件只负责**把那个函数定期叫醒**。
 *
 * ## 为什么按小时、为什么不按"用户说完一句就回顾"
 *
 * 回顾需要**一段已经结束的相处**：末尾得是她已经交付出去的一句话，不然她是在
 * 用户还没说完的时候给自己下结论。门里的间隔（24 小时同一会话一次）也是同一目的——
 * 让一段相处先落定。低频用户不会因为"不常打开"而永远排不到：判据看的是
 * 段落累计，不是定时器有没有响过。
 *
 * ## 为什么成功才推进本地时间戳
 *
 * 与 `companion-memory-organize-scheduler.ts` 同一理由：DB 抖动时下一轮立刻重试，
 * 而不是把这一小时白等掉。
 */
import { sql } from "drizzle-orm";

import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const TICK_INTERVAL_MS = 60 * 60 * 1000;
let lastTickAt = 0;

export async function tickCompanionReflectionScheduler(): Promise<void> {
  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return;
  try {
    const rows = await db.execute<{ enqueued: number }>(sql`
      SELECT public.astella_enqueue_companion_reflection() AS enqueued
    `);
    lastTickAt = now;
    const enqueued = Number((Array.isArray(rows) ? rows : [])[0]?.enqueued ?? 0);
    if (enqueued > 0) logger.info({ enqueued }, "companion reflection jobs enqueued");
  } catch (err) {
    logger.warn({ err }, "companion reflection enqueue failed; retrying next tick");
  }
}

/** 测试与手动触发用的复位口：不推进时间戳就没法在同一个进程里连跑两轮。 */
export function resetCompanionReflectionSchedulerTick(): void {
  lastTickAt = 0;
}
