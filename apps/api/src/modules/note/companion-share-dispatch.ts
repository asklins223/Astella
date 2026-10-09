import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { companionShareNoteV1Schema, noteShareScopeReceiptV1Schema } from "@astella/shared/note-share-contracts";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { setNoteShareScope } from "./service.ts";

/**
 * 伴星那一句「把这篇共享给空间」在这里落地（2026-10-09）。
 *
 * 与 `companion-edit-dispatch.ts` 同一条形状：worker 只登记要做什么，**写笔记的仍是
 * 服务层那一个入口**。这不是风格问题——`setNoteShareScope` 之后跟着一次
 * `refreshNoteObjectiveSearchProjections`，因为目标索引的正文里可能带着这篇的公开标题。
 * worker 绕过它自己改那一列，撤回共享之后那句标题就会继续留在别人的搜索结果里，
 * 而那正是这条能力最容易伤到人的方向。
 */
export async function processCompanionNoteShare(scope: { workspaceId: string; userId: string }, callId: string): Promise<void> {
  try {
    await withWorkspaceTransaction(scope, async tx => {
      const rows = await tx.execute<{ arguments: unknown }>(sql`
        SELECT c.arguments FROM companion_agent_tool_calls c
          JOIN companion_turn_runs r ON r.id=c.run_id
          JOIN user_companion_account_state a ON a.user_id=r.user_id
          JOIN jobs j ON j.id=r.job_id
          WHERE c.id=${callId} AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
            AND c.name='companion_share_note' AND c.status='executing' AND c.result_ref IS NULL
            AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
            AND a.global_enabled AND a.epoch=r.account_epoch AND r.permission_level<>'read_only'
            AND j.status='running' AND j.type='companion_agent' AND j.requested_by=c.user_id
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') t
              WHERE t->>'name'='companion_share_note')
          FOR UPDATE OF c,r,a SKIP LOCKED`);
      const row = (Array.isArray(rows) ? rows : [])[0];
      if (!row) return;
      const input = companionShareNoteV1Schema.safeParse(row.arguments);
      const settled = input.success
        ? await setNoteShareScope(tx, input.data.noteId, scope.workspaceId, scope.userId, input.data.shareScope)
        : null;
      const receipt = input.success && settled
        ? noteShareScopeReceiptV1Schema.parse({
          noteId: settled.note.id, shareScope: settled.note.shareScope,
          changed: settled.changed, updatedAt: settled.note.updatedAt.toISOString(),
        })
        : null;
      await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${
        receipt
          ? JSON.stringify({ kind: "note_share", ...receipt })
          : JSON.stringify({ kind: "note_share_failed",
            message: "这篇笔记不是这位用户写的，或者已经不在这位用户的空间里，可见范围没有改动。要改得由作者自己去那一页。" })
      },updated_at=now()
        WHERE id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
          AND name='companion_share_note' AND status='executing' AND result_ref IS NULL`);
    });
  } catch (error) {
    logger.error({ err: error, callId }, "companion note share dispatch failed");
    // 事务可能已经回滚，而那一列到底改没改**不确定**——留一条待核对，
    // 不能留"失败"：说成没发生，用户会再点一次，而共享可能已经生效过一轮。
    await withWorkspaceTransaction(scope, tx => tx.execute(sql`UPDATE companion_agent_tool_calls
      SET result_ref=${JSON.stringify({ kind: "note_share_unknown",
        message: "共享结果暂时无法确认，请先在那一页核对可见范围，不要重复操作。" })},updated_at=now()
      WHERE id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND name='companion_share_note' AND status='executing' AND result_ref IS NULL`));
  }
}

export async function companionNoteShareDispatch(app: FastifyInstance) {
  let running = false, closed = false;
  const tick = async () => {
    if (running || closed) return;
    running = true;
    try {
      const requests = await db.execute<{ workspace_id: string; user_id: string; call_id: string }>(
        sql`SELECT * FROM astella_pending_companion_note_shares_v1()`);
      for (const request of requests)
        await processCompanionNoteShare({ workspaceId: request.workspace_id, userId: request.user_id }, request.call_id);
    } catch (err) { app.log.error({ err }, "companion note share dispatch failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 300); timer.unref();
  app.addHook("onClose", async () => { closed = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 20)); });
}
