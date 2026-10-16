import { sql } from "drizzle-orm";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/**
 * 新的一次启动作废上一次**还没被看见**的启动问候（2026-10-16）。
 *
 * 启动问候是**对某一次启动**说的话：它在 host 的 `app.started` 之后生成，通常十几秒才落地。
 * 那次启动如果先关了窗口（或网络慢），投递就停在 `queued`；下一次打开时它才被认领——
 * 用户看到的是「上一次启动的问候」，紧接着这次启动自己的问候也到了。真窗口实测：
 * 11:40:48 生成的问候在 11:41:39 出现在下一个窗口，两条问候前后只差十几秒。
 *
 * 所以一条没被看见的启动问候，在下一次真实启动发生时就没有价值了：问候不是待办，
 * 过期的问候不该攒成消息债务（40 §8.2 对普通招呼的同一口径）。这里把它按 `suppressed`
 * 收掉——正文仍留在连续历史与手记里读得到，只是不再冒充「这次的问候」。
 *
 * **为什么住在共用层而不是 API 的投递服务里**：这条判定的时机是「这一次启动真的成立了吗」，
 * 与 `recordCompanionAwareness` 的记账同一个事务；而 API 里 `companion-shell` 与
 * `companion-conversation` 之间必须**零条边**（`companion-module-cycle.test.ts` 守着，
 * 那条边正是 2026-09-30 P1-6 特意拆掉的）。把这几行投递语句放在共用层，
 * 那条边界才继续成立。
 *
 * 只动 `app.started` 那一类：她自己想说的感想、她排的到点关注、用户约的提醒都不在此列。
 * 加了 `created_at < now()`：并发的另一次启动（另一台设备）刚生成的问候不该被这一次顺手收掉。
 */
export async function retireSupersededLaunchGreetings(
  tx: AgentSqlExecutor,
  scope: { workspaceId: string; userId: string },
): Promise<number> {
  const rows = await queryRows<{ id: string }>(tx, sql`
    UPDATE assistant_deliveries AS d
    SET state = 'suppressed', updated_at = now()
    WHERE d.workspace_id = ${scope.workspaceId} AND d.user_id = ${scope.userId}
      AND d.state IN ('queued', 'delivered')
      AND d.kind = 'system_event'
      AND d.payload_ref->>'systemEventId' LIKE 'initiative:%'
      AND d.created_at < now()
      AND EXISTS (
        SELECT 1 FROM companion_turn_runs r
        WHERE r.workspace_id = d.workspace_id AND r.user_id = d.user_id
          AND r.id::text = d.payload_ref->'initiative'->>'runId'
          AND r.input_source->>'topic' = 'app.started'
      )
    RETURNING d.id`);
  return rows.length;
}
