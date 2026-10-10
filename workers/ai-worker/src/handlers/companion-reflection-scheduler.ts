/**
 * 后台反思的**调度 tick**（方案 50 §9.1）。
 *
 * 与记忆整理那一位兄弟同一形状：「哪些会话段落够格回顾」是跨用户的计数，
 * RLS 下 worker 读不到别人的行，所以那一问在库里（0400 的
 * `astella_enqueue_companion_reflection`）。本文件只负责**把那个函数定期叫醒**。
 *
 * ## 每分钟检查持久唤醒
 *
 * 普通反思仍按真实已落定片段与既有间隔判门；自身记事的到点重评按持久时间入队。
 * tick 不承担人的通知、不拦实时消息，也不凭时间经过制造成长。未变化不重新排队。
 *
 * ## 为什么成功才推进本地时间戳
 *
 * 与 `companion-memory-organize-scheduler.ts` 同一理由：DB 抖动时下一轮立刻重试，
 * 而不是把本次检查白等掉。
 */
import { sql } from "drizzle-orm";

import { db } from "../db.ts";
import { logger } from "../lib/logger.ts";

const TICK_INTERVAL_MS = 60 * 1000;
let lastTickAt = 0;

export async function tickCompanionReflectionScheduler(): Promise<void> {
  const now = Date.now();
  if (now - lastTickAt < TICK_INTERVAL_MS) return;
  try {
    const rows = await db.execute<{ enqueued: number }>(sql`
      SELECT public.astella_enqueue_companion_reflection() + public.astella_enqueue_companion_self_wakes() AS enqueued
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
