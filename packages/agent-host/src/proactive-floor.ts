import { sql, type SQL } from "drizzle-orm";

/**
 * 「上一次主动开口是什么时候」的唯一读数（2026-10-16）。
 *
 * ## 为什么要一个共享读数
 *
 * 主动开口有两条不相干的路：API 的学习完成模板（`run.completed:`）与 worker 的她
 * 自己开口（`initiative:`）。两边在**不同进程**里各自判定，谁也不调谁；原来它们
 * 唯一的共同工件就是 `assistant_deliveries` 里那一行。跨话题地板（用户 2026-10-16
 * 口径：全局主动不用节流太严重）只能在**同一份读数**上判，否则两边各自数各自的，
 * 她仍然可以"模板刚说完就打招呼"。
 *
 * ## 为什么排除 reminder
 *
 * 约定提醒是用户自己约的事，40 §8.2 说停用也不会取消已授权安排；它由
 * `astella_fire_due_companion_reminders` 直接入队，**不经过**这条判定。若把
 * `reminder:%` 也算进读数，一条提醒会把地板推给别的主动开口，用户得到的是
 * "提醒把她静音了"——方向正好反了。
 *
 * ## 已知边界
 *
 * RLS 让这条读数是**当前书房**计的（与 `companion-initiative.ts` 里"最近一次开口"
 * 那条查询同一限制）；worker 在起 run 之前读到的是**上一轮**的值。对一条 2 分钟的
 * 轻地板来说这两点都可以接受——它要挡的是"同一两分钟内连着开口"，不是精确配额。
 */
export function lastUnpromptedUtteranceAtQuery(scope: {
  workspaceId: string;
  userId: string;
}): SQL {
  return sql`
    SELECT max(created_at) AS at
    FROM assistant_deliveries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND (payload_ref->>'systemEventId' LIKE 'initiative:%'
        OR payload_ref->>'systemEventId' LIKE 'run.completed:%')
  `;
}

/**
 * 读数 → "距上一次主动开口多少毫秒"。
 *
 * 读不出来、没有行、时间戳解析不了，一律返回 null；调用方的
 * `globalProactiveFloorBlocked({ msSinceAnyCue: null })` 是**放行**。
 * 这条闸只该少挡一次，不该因为一次读失败把她静音。
 */
export function msSinceUnpromptedUtterance(at: unknown, now: number): number | null {
  if (at == null) return null;
  const time = at instanceof Date ? at.getTime() : new Date(String(at)).getTime();
  return Number.isFinite(time) ? Math.max(0, now - time) : null;
}
