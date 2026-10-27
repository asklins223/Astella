import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { companionEditNoteV1Schema, companionNoteEditingContextV1Schema, type CompanionEditedNoteV1 } from "@astella/shared/companion-note-authoring-contracts";
import { db, withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { noteCollaboration, documentNameForNote, disconnectAndConfirmNoteDocSaved, type NoteDocContext } from "./collaboration.ts";
import { applyCompanionNoteEdit, NoteEditConflict } from "./companion-edit-document.ts";
import { noteVisibleSqlText } from "./visibility.ts";
import { logger } from "../../lib/logger.ts";

const summaries: Record<string, string> = { append: "已追加到笔记末尾", insert_at_cursor: "已插入到光标后",
  replace_selection: "已替换选中的内容", delete_selection: "已删除选中的内容", replace_blocks: "已替换指定段落", delete_blocks: "已删除指定段落" };

// A closed note has no cursor or selection. Block edits can instead bind to a
// successful full-block read of that exact version in this same live run.
const verifiedBlockRead = sql`(c.arguments->>'operation' IN ('replace_blocks','delete_blocks') AND EXISTS (
  SELECT 1 FROM companion_agent_tool_calls source_read
  WHERE source_read.run_id=r.id AND source_read.workspace_id=c.workspace_id AND source_read.user_id=c.user_id
    AND source_read.name='notes.read.read' AND source_read.status='succeeded'
    AND source_read.arguments->>'includeBlocks'='true'
    AND source_read.result_ref::jsonb=jsonb_build_object('kind','note_read','noteId',n.id::text,
      'noteVersionId',c.arguments->>'noteVersionId')))`;

export function companionNoteEditSourceAllowed(input: {
  operation: string | null; pageNoteId: string | null; noteId: string | null; verifiedRead: boolean;
}): boolean {
  return input.noteId !== null && (input.pageNoteId === input.noteId
    || ((input.operation === "replace_blocks" || input.operation === "delete_blocks") && input.verifiedRead));
}

/**
 * 放行判据一条都没中时，**说清到底是哪一条**（2026-10-14 dev 库实测补）。
 *
 * 此前这里只有一句合并文案「这轮已经停止、页面已变化或没有编辑权限」。它在最常见的
 * 那种失败上是**假话**：实测三轮 `companion_edit_note` 全部败在
 * `r.page_context->'context'->>'noteId'=n.id::text`（用户从气泡发消息、当时没有打开
 * 这篇笔记，page_context 为空），而 run 明明还 running、权限是 full——模型照着回执
 * 复述给用户的就是「这轮已经停止、页面已变化」，把一个"页面不对"说成了"轮次没了"。
 *
 * 这条诊断只在失败路径上多跑一发只读查询，取回放行判据各自的原料，在 JS 里按
 * 主次逐条比对；顺序即优先级，报出来的必须是**当下真的成立**的那一条。
 */
export async function diagnoseNoteEditRefusal(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  callId: string,
): Promise<string> {
  const rows = await tx.execute<{
    call_status: string; result_ref: string | null;
    run_status: string | null; cancel_requested_at: Date | null; permission_level: string | null;
    account_epoch: number | null; global_enabled: boolean | null; current_epoch: number | null;
    page_note_id: string | null; note_id: string | null; deleted_at: Date | null;
    share_scope: string | null; created_by: string | null;
    member_left_at: Date | null; member_role: string | null; workspace_owner: string | null;
    job_status: string | null; job_type: string | null; job_requested_by: string | null;
    operation: string | null; offered: boolean; confirmed: boolean; source_read_verified: boolean;
  }>(sql`
    SELECT c.status AS call_status, c.result_ref,
           r.status AS run_status, r.cancel_requested_at, r.permission_level, r.account_epoch,
           r.page_context->'context'->>'noteId' AS page_note_id,
           c.arguments->>'operation' AS operation,
           ${verifiedBlockRead} AS source_read_verified,
           a.global_enabled, a.epoch AS current_epoch,
           n.id AS note_id, n.deleted_at, n.share_scope, n.created_by,
           m.left_at AS member_left_at, m.role AS member_role, w.owner_id AS workspace_owner,
           j.status AS job_status, j.type AS job_type, j.requested_by AS job_requested_by,
           EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') t WHERE t->>'name' = 'companion_notes_write') AS offered,
           COALESCE(astella_companion_tool_confirmed_v1(r.id, c.tool_call_id), false) AS confirmed
    FROM companion_agent_tool_calls c
    LEFT JOIN companion_turn_runs r ON r.id=c.run_id
    LEFT JOIN user_companion_account_state a ON a.user_id=c.user_id
    LEFT JOIN notes n ON n.id=(c.arguments->>'noteId')::uuid AND n.workspace_id=c.workspace_id
    LEFT JOIN workspaces w ON w.id=c.workspace_id
    LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=c.user_id
    LEFT JOIN jobs j ON j.id=r.job_id
    WHERE c.id=${callId} AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
      AND c.name='notes.write.edit'`);
  const row = rows[0];
  if (!row) return "这次编辑请求已经不在了，笔记没有改动。";
  if (row.call_status !== "executing" || row.result_ref !== null) return "这次编辑已经停止，笔记没有改动。";
  if (!row.run_status || !["accepted", "running"].includes(row.run_status) || row.cancel_requested_at !== null) {
    return "这轮已经停止，笔记没有改动。要改的话重新发一次要求，我接着改。";
  }
  // 页面不是这篇（或根本没带页面上下文）是最常见的一种，先报它：
  // 它和"轮次没了"完全是两回事，说错了用户会以为对话断了。
  if (!companionNoteEditSourceAllowed({ operation: row.operation, pageNoteId: row.page_note_id,
    noteId: row.note_id, verifiedRead: row.source_read_verified })) {
    return row.operation === "replace_blocks" || row.operation === "delete_blocks"
      ? "这轮还没有读取目标笔记的完整段落和版本，修改没有执行。先读取目标正文再修改。"
      : "这次操作需要目标笔记里的光标、选区或末尾位置，请先打开目标笔记；正文没有改动。";
  }
  if (row.global_enabled === false || row.current_epoch === null || row.account_epoch !== row.current_epoch) {
    return "伴星功能已关闭或账号信息已更新，笔记没有改动。";
  }
  const needsConfirmation = row.operation === "delete_selection" || row.operation === "delete_blocks";
  if (row.permission_level !== "full" ? !row.confirmed : needsConfirmation && !row.confirmed) {
    return "这一步需要你先确认才能执行，笔记没有改动。";
  }
  if (row.note_id !== null && (row.deleted_at !== null || (row.share_scope !== "shared" && row.created_by !== scope.userId))) {
    return "这篇笔记已经删除或不在我可见的范围里，笔记没有改动。";
  }
  if (row.member_left_at !== null || (row.member_role !== "owner" && row.workspace_owner !== scope.userId)) {
    return "我在你的空间里没有编辑这篇笔记的权限，笔记没有改动。";
  }
  if (row.job_status !== "running" || row.job_type !== "companion_agent" || row.job_requested_by !== scope.userId) {
    return "这一轮的后台任务已经结束，笔记没有改动。重新发一次要求，我再接着改。";
  }
  if (!row.offered) return "这一轮没有把编辑工具交给我，笔记没有改动。";
  return "这次编辑的条件没有对上，笔记没有改动。重新发一次要求试试。";
}


/** Bounded durable dispatch. No alternate note writer: direct connection uses the existing projection/store hook. */
export async function processCompanionNoteEdit(scope: { workspaceId: string; userId: string }, callId: string): Promise<void> {
  let editApplied = false;
  try {
    await withWorkspaceTransaction(scope, async tx => {
      const rows = await tx.execute<{ run_id: string; arguments: unknown; page_context: unknown; note_id: string; current_version_id: string; source_read_verified: boolean }>(sql`
        SELECT c.run_id,c.arguments,r.page_context,n.id AS note_id,n.current_version_id,
          ${verifiedBlockRead} AS source_read_verified
        FROM companion_agent_tool_calls c JOIN companion_turn_runs r ON r.id=c.run_id
        JOIN user_companion_account_state a ON a.user_id=r.user_id
        JOIN notes n ON n.id=(c.arguments->>'noteId')::uuid AND n.workspace_id=c.workspace_id
        JOIN workspaces w ON w.id=c.workspace_id JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=c.user_id
        JOIN jobs j ON j.id=r.job_id
        WHERE c.id=${callId} AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
          AND c.name='notes.write.edit' AND c.status='executing' AND c.result_ref IS NULL
          AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
          AND a.global_enabled AND a.epoch=r.account_epoch
          AND ((r.permission_level='full' AND c.arguments->>'operation' NOT IN ('delete_selection','delete_blocks'))
            OR astella_companion_tool_confirmed_v1(r.id,c.tool_call_id))
          AND j.status='running' AND j.type='companion_agent' AND j.requested_by=c.user_id
          AND m.left_at IS NULL AND (m.role='owner' OR w.owner_id=c.user_id)
          AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=c.user_id)
          AND (r.page_context->'context'->>'noteId'=n.id::text OR ${verifiedBlockRead})
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') t WHERE t->>'name' = 'companion_notes_write')
        -- A locked live run/account is still authorized. Wait and recheck;
        -- skipping it would turn ordinary contention into a false failure receipt.
        FOR UPDATE OF c,r,a`);
      const row = rows[0];
      if (!row) {
        const message = await diagnoseNoteEditRefusal(tx, scope, callId);
        logger.warn({ callId, message }, "companion note edit refused; receipt states the actual reason");
        await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify({ kind: "note_edit_failed", message })}
          WHERE id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND status='executing' AND result_ref IS NULL`);
        return;
      }
      const input = companionEditNoteV1Schema.parse(row.arguments);
      const page = row.page_context as { context?: { noteId?: string; noteVersionId?: string; editing?: unknown } } | null;
      // Later batches may follow a version created by an earlier confirmed edit in this same turn.
      // An unrelated version change still cannot replace the frozen page version.
      const chained = page?.context?.noteVersionId !== input.noteVersionId ? await tx.execute(sql`
        SELECT 1 FROM companion_agent_tool_calls
        WHERE run_id=${row.run_id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
          AND name='notes.write.edit' AND status='succeeded' AND result_ref IS NOT NULL
          AND result_ref::jsonb->>'kind'='edited_note'
          AND result_ref::jsonb->>'noteId'=${row.note_id}
          AND result_ref::jsonb->>'noteVersionId'=${input.noteVersionId}
        LIMIT 1`) : [];
      const frozenPageVersion = page?.context?.noteId === row.note_id && page.context.noteVersionId === input.noteVersionId;
      if (input.noteVersionId !== row.current_version_id || (!frozenPageVersion && !row.source_read_verified && chained.length === 0)) {
        await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify({ kind: "note_edit_failed", message: "这篇笔记已经换版，请在当前正文重新发送要求。" })} WHERE id=${callId}`); return;
      }
      const editing = companionNoteEditingContextV1Schema.parse(page?.context?.noteId === row.note_id ? page.context.editing ?? {} : {});
      const context: NoteDocContext = { ...scope, noteId: row.note_id, versionId: row.current_version_id, readOnly: false };
      const connection = await noteCollaboration.openDirectConnection(documentNameForNote(row.note_id), context);
      let receipt: CompanionEditedNoteV1 | undefined;
      let failure: string | undefined;
      try {
        await connection.transact(document => {
          const marker = `companion-edit:${callId}`;
          if (!document.getMap("meta").has(marker)) {
            // All parsing/verification completes before the first document mutation.
            applyCompanionNoteEdit(document, input, editing);
            document.getMap("meta").set(marker, true);
          }
          editApplied = true;
          receipt = { kind: "edited_note", noteId: row.note_id, noteVersionId: row.current_version_id,
            operation: input.operation, summary: summaries[input.operation]!, update: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64") };
        });
      } catch (error) {
        if (!(error instanceof NoteEditConflict)) throw error;
        failure = error.message;
      } finally { await disconnectAndConfirmNoteDocSaved(connection, context); }
      // The persisted CRDT, including the call marker, is verified before issuing a receipt.
      if (receipt) {
        const saved = await tx.execute<{ current_version_id: string }>(sql`SELECT n.current_version_id FROM notes n
          CROSS JOIN (SELECT ${scope.userId}::uuid AS viewer) v
          WHERE n.id=${row.note_id} AND n.workspace_id=${scope.workspaceId}
            AND n.deleted_at IS NULL AND ${sql.raw(noteVisibleSqlText("n", "v.viewer"))}`);
        receipt.noteVersionId = saved[0]?.current_version_id ?? receipt.noteVersionId;
      }
      await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify(receipt ?? { kind: "note_edit_failed", message: failure })},updated_at=now() WHERE id=${callId}`);
    });
  } catch (error) {
    logger.error({ err: error, callId }, "companion note edit persistence was not confirmed");
    // The failed transaction may have rolled back while the live document already changed.
    // Report uncertainty in a fresh transaction; never dispatch the same edit repeatedly.
    await withWorkspaceTransaction(scope, tx => tx.execute(sql`UPDATE companion_agent_tool_calls
      SET result_ref=${JSON.stringify({ kind: editApplied ? "note_edit_unknown" : "note_edit_failed",
        message: editApplied ? "正文修改已进入实时文档，但保存结果暂时无法确认；请先核对正文，不要重复修改。" : "这次编辑没有开始执行，笔记没有被修改。" })},updated_at=now()
      WHERE id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND name='notes.write.edit' AND status='executing' AND result_ref IS NULL`));
  }
}

export async function companionNoteEditDispatch(app: FastifyInstance) {
  let running = false, closed = false;
  const tick = async () => {
    if (running || closed) return;
    running = true;
    try {
      const requests = await db.execute<{ workspace_id: string; user_id: string; call_id: string }>(sql`SELECT * FROM astella_pending_companion_note_edits_v1()`);
      for (const request of requests) await processCompanionNoteEdit({ workspaceId: request.workspace_id, userId: request.user_id }, request.call_id);
    } catch (err) { app.log.error({ err }, "companion note edit dispatch failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 300); timer.unref();
  app.addHook("onClose", async () => { closed = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 20)); });
}
