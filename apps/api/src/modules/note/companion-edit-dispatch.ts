import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import * as Y from "yjs";
import { companionEditNoteV1Schema, companionNoteEditingContextV1Schema, type CompanionEditedNoteV1 } from "@astella/shared/companion-note-authoring-contracts";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { noteCollaboration, documentNameForNote, type NoteDocContext } from "./collaboration.ts";
import { applyCompanionNoteEdit, NoteEditConflict } from "./companion-edit-document.ts";
import { noteVisibleSqlText } from "./visibility.ts";

const summaries: Record<string, string> = { append: "已追加到笔记末尾", insert_at_cursor: "已插入到光标后",
  replace_selection: "已替换选中的内容", delete_selection: "已删除选中的内容", replace_blocks: "已替换指定段落", delete_blocks: "已删除指定段落" };

/** Bounded durable dispatch. No alternate note writer: direct connection uses the existing projection/store hook. */
export async function processCompanionNoteEdit(scope: { workspaceId: string; userId: string }, callId: string): Promise<void> {
  await withWorkspaceTransaction(scope, async tx => {
    const rows = await tx.execute<{ run_id: string; arguments: unknown; page_context: unknown; note_id: string; current_version_id: string }>(sql`
      SELECT c.run_id,c.arguments,r.page_context,n.id AS note_id,n.current_version_id
      FROM companion_agent_tool_calls c JOIN companion_turn_runs r ON r.id=c.run_id
      JOIN user_companion_account_state a ON a.user_id=r.user_id
      JOIN notes n ON n.id=(c.arguments->>'noteId')::uuid AND n.workspace_id=c.workspace_id
      JOIN workspaces w ON w.id=c.workspace_id JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=c.user_id
      JOIN jobs j ON j.id=r.job_id
      WHERE c.id=${callId} AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
        AND c.name='companion_edit_note' AND c.status='executing' AND c.result_ref IS NULL
        AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
        AND a.global_enabled AND a.epoch=r.account_epoch AND r.permission_level<>'read_only'
        AND j.status='running' AND j.type='companion_agent' AND j.requested_by=c.user_id
        AND m.left_at IS NULL AND (m.role='owner' OR w.owner_id=c.user_id)
        AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=c.user_id)
        AND r.page_context->'context'->>'noteId'=n.id::text
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') t WHERE t->>'name'='companion_edit_note')
      FOR UPDATE OF c,r,a SKIP LOCKED`);
    const row = rows[0];
    if (!row) {
      await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify({ kind: "note_edit_failed", message: "这轮已经停止、页面已变化或没有编辑权限，笔记没有改动。" })}
        WHERE id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND status='executing' AND result_ref IS NULL`);
      return;
    }
    const input = companionEditNoteV1Schema.parse(row.arguments);
    const page = row.page_context as { context?: { noteVersionId?: string; editing?: unknown } };
    if (input.noteVersionId !== row.current_version_id || page.context?.noteVersionId !== input.noteVersionId) {
      await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify({ kind: "note_edit_failed", message: "这篇笔记已经换版，请在当前正文重新发送要求。" })} WHERE id=${callId}`); return;
    }
    const editing = companionNoteEditingContextV1Schema.parse(page.context?.editing ?? {});
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
        receipt = { kind: "edited_note", noteId: row.note_id, noteVersionId: row.current_version_id,
          operation: input.operation, summary: summaries[input.operation]!, update: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64") };
      });
    } catch (error) {
      if (!(error instanceof NoteEditConflict)) throw error;
      failure = error.message;
    } finally { await connection.disconnect(); }
    // Only disconnect's successful store/projection makes this a saved receipt.
    if (receipt) {
      const saved = await tx.execute<{ current_version_id: string }>(sql`SELECT n.current_version_id FROM notes n
        CROSS JOIN (SELECT ${scope.userId}::uuid AS viewer) v
        WHERE n.id=${row.note_id} AND n.workspace_id=${scope.workspaceId}
          AND n.deleted_at IS NULL AND ${sql.raw(noteVisibleSqlText("n", "v.viewer"))}`);
      receipt.noteVersionId = saved[0]?.current_version_id ?? receipt.noteVersionId;
    }
    await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify(receipt ?? { kind: "note_edit_failed", message: failure })},updated_at=now() WHERE id=${callId}`);
  });
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
