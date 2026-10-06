/**
 * run 事件的写入（唯一实现）。
 *
 * 2026-10-04：从 `apps/api/src/modules/card-generation-v2/helpers.ts` 原样搬过来。
 * API 的 `helpers.ts` 现在 import 并转出这两个函数，所以激活服务、审核服务、
 * 揭示服务与创建事务调到的**仍然是这一份**——不留第二份写入实现。
 */
import { and, eq, sql } from "drizzle-orm";
import { cardGenerationEventsV2 } from "@astella/shared/db-schema/card-generation-v2";
import type { CardGenerationEventTx } from "./transaction.ts";

export async function insertEvent(
  tx: CardGenerationEventTx,
  workspaceId: string,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await insertEventBatch(tx, workspaceId, runId, [{ eventType, payload }]);
}

/**
 * 批量写事件（P1-1）。
 *
 * `insertEvent` 每写一条要做 **2 个往返**（`SELECT MAX(event_seq)` + `INSERT`），
 * 而激活路径上它是在**按 candidate / 按 mapping 的循环里**被调的
 * （`activation-service.ts` 的 12 步与 12c 步各一个循环）。一批 20 个 candidate
 * 就是 40 次往返，外加 20 次 `MAX()` 扫描——这就是审计里那条 M×(2+10N) 的形状。
 *
 * 这里把 MAX 只查一次、INSERT 合成一次多行写入，N 条事件从 2N 次往返降到 2 次。
 *
 * 语义保持不变：
 *   - `event_seq` 仍按 batch 内的**入参顺序**连续递增，所以消费侧按 seq 读出来的
 *     先后关系与逐条插入完全一致；
 *   - 仍然是 (workspace_id, run_id) 作用域内的单调序列。
 *
 * 顺带把一次 MAX 的竞态窗口从「N 次」缩到「1 次」：原来循环里前一条刚插完、
 * 后一条再算 MAX，中间可能被并发事务插进来；现在整批基于同一个基线。
 *
 * 空数组直接返回——`tx.insert().values([])` 在 drizzle 里是未定义行为，不能喂空。
 */
export async function insertEventBatch(
  tx: CardGenerationEventTx,
  workspaceId: string,
  runId: string,
  events: Array<{ eventType: string; payload?: Record<string, unknown> }>,
): Promise<void> {
  if (events.length === 0) return;
  const [row] = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${cardGenerationEventsV2.eventSeq}), 0)` })
    .from(cardGenerationEventsV2)
    .where(and(
      eq(cardGenerationEventsV2.workspaceId, workspaceId),
      eq(cardGenerationEventsV2.runId, runId),
    ));
  const baseSeq = row?.maxSeq ?? 0;
  await tx.insert(cardGenerationEventsV2).values(
    events.map((event, index) => ({
      workspaceId,
      runId,
      eventSeq: baseSeq + index + 1,
      eventType: event.eventType,
      payload: event.payload ?? {},
    })),
  );
}