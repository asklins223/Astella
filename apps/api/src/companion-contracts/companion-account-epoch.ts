/**
 * L11：conversation 事件流的 account_epoch 统一到账号世代计数器。
 *
 * 世代来源是 user_companion_account_state.epoch（账号级、跨设备同步；
 * global off 时单调递增并广播，见 companion-shell/service.ts）。conversation
 * 事件（turn/cancel/proactive/action）必须携带事件发生时的世代，客户端据此
 * 拒绝 global off 之前的迟到事件（合同 §5.2 accountEpoch 语义）。从未
 * global off 的用户 epoch 恒 0。
 *
 * 注意：companion_runtime_fences.surface_epoch 是设备侧世代（trigger
 * arbitration 的 deviceSurfaceEpoch 用它），与事件流的账号级 epoch 不同源。
 */

import { sql } from "drizzle-orm";

/** 读取当前账号世代（无账号状态行 → 0）。 */
export async function getCompanionAccountEpoch(
  tx: { execute(q: unknown): Promise<unknown> },
  userId: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX(epoch), 0)::int AS epoch
    FROM user_companion_account_state
    WHERE user_id = ${userId}
  `)) as Array<{ epoch: string }>;
  return Number(rows[0]?.epoch ?? 0);
}

/**
 * 建 run 前幂等补齐账号状态行——**行的存在本身**是伴星链路的准入条件，
 * 而这一行以前只有用户主动改设置（PATCH /me/companion）或跑 agent store 时才产生。
 *
 * ## 为什么必须在建 run 这条路径上补
 *
 * `reserveCompanionProviderCall`（worker）用 INNER JOIN 把 provider 调用闸门与
 * `user_companion_account_state` 绑在一起：
 *
 * ```sql
 * UPDATE companion_turn_runs r ... FROM user_companion_account_state a
 *  WHERE ... AND a.user_id = r.user_id AND a.global_enabled AND a.epoch = r.account_epoch
 * ```
 *
 * 没有这一行 ⇒ 命中 0 行 ⇒ 抛 `AGENT_BUDGET_EXCEEDED`
 * （"companion provider budget exhausted or turn obsolete"）。而建 run 这一侧
 * 用的是 `getCompanionAccountEpoch`，它对无行返回 0、**不要求这一行存在**：
 * 于是「API 允许 epoch=0 建 run，worker 却要求该行存在」——从没碰过伴星设置的
 * 用户第一句话必然失败，伴星永远答不出来。
 *
 * ## 为什么是这里而不是把闸门改成 LEFT JOIN
 *
 * `global_enabled` 是**关掉伴星**的载体，缺失行时放行等于绕过用户的关闭意图，
 * 是安全性回退。这里改成「入口保证行存在」，闸门保持 fail-closed：
 * 行一旦存在，`global_enabled=false` 或 epoch 不匹配照样拒。
 *
 * ## 取值：默认**开启**
 *
 * 显式写 `global_enabled = true`，与 `updateCompanionAccountState` 首次写入的
 * `patch.globalEnabled ?? true` 同值——从没设置过的用户就是默认开启伴星。
 * 写 false 会把「用户还没表达过关闭意图」误记成「用户关闭了伴星」，比原缺陷更糟。
 * 其余列与列默认值同源（`epoch = 0`、`revision = 0`、`agent_settings` guided、
 * `intervention_level` moderate）；`diary_enabled_since` 必须给 now()：
 * 日记调度（0333）要求它非空，置 NULL 会让从不改设置的用户永远进不了日记。
 *
 * `revision = 0`（而非 updateCompanionAccountState 首写的 1）是刻意的：GET /me/companion
 * 在无行时返回 `emptyAccountState()`（revision 0），所以 revision 0 是客户端看得到的
 * 「还没有账号状态」取值；写 1 会让客户端缓存的 base revision 0 与服务端对不上，
 * 用户第一次改设置就撞 409。
 *
 * 幂等：唯一索引在 user_id 上，`ON CONFLICT DO NOTHING` 保证并发建 run 也只留一行、
 * 且绝不覆盖既有行（已关闭的账号不会被重新打开）。
 */
export async function ensureCompanionAccountState(
  tx: { execute(q: unknown): Promise<unknown> },
  userId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO user_companion_account_state
      (user_id, revision, epoch, global_enabled, diary_enabled, diary_enabled_since)
    VALUES (${userId}, 0, 0, true, true, now())
    ON CONFLICT (user_id) DO NOTHING
  `);
}
