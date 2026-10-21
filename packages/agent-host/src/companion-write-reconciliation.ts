import { sql } from "drizzle-orm";
import { companionCreatedNoteV1Schema, companionEditedNoteV1Schema, type CompanionCreatedNoteV1, type CompanionEditedNoteV1 } from "@astella/shared/companion-note-authoring-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/** The caller owns the run lock and its workspace transaction. Read the
 * business receipt committed with the note; never infer success from prose or
 * repeat an uncertain write. Other write tools remain explicitly unresolved. */
export async function reconcileCompanionSavedNotes(tx: AgentSqlExecutor,
  scope: { workspaceId: string; userId: string; runId: string }, toolCallId?: string) {
  const calls = await queryRows<{ tool_call_id: string; name: string; tool_version: string; risk_class: string; result_ref: string | null }>(tx,
    sql`SELECT tool_call_id,name,tool_version,risk_class,result_ref FROM companion_agent_tool_calls
      WHERE run_id=${scope.runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND name IN ('companion_create_note','companion_edit_note') AND status IN ('executing','outcome_unknown')
        ${toolCallId ? sql`AND tool_call_id=${toolCallId}` : sql``} ORDER BY created_at FOR UPDATE`);
  const resolved: { toolCallId: string; name: string; toolVersion: string; riskClass: string; receipt: CompanionCreatedNoteV1 | CompanionEditedNoteV1 }[] = [];
  for (const call of calls) {
    let receipt: CompanionCreatedNoteV1 | CompanionEditedNoteV1;
    try { const value = JSON.parse(call.result_ref ?? "null");
      receipt = call.name === 'companion_create_note' ? companionCreatedNoteV1Schema.parse(value) : companionEditedNoteV1Schema.parse(value);
    } catch { continue; }
    const [saved] = await queryRows<{ id: string }>(tx, sql`SELECT n.id FROM notes n JOIN note_versions v ON v.note_id=n.id
      WHERE n.id=${receipt.noteId} AND v.id=${receipt.noteVersionId} AND n.workspace_id=${scope.workspaceId}
        AND (n.created_by=${scope.userId} OR (n.share_scope='shared' AND ${call.name}='companion_edit_note')) AND n.deleted_at IS NULL`);
    if (!saved) continue;
    await tx.execute(sql`UPDATE companion_agent_tool_calls SET status='succeeded',
      result_safe_summary=${receipt.kind === 'created_note' ? `已核对，笔记《${receipt.title.slice(0, 36)}》已保存` : `已核对，笔记修改已保存：${receipt.summary}`},updated_at=now()
      WHERE run_id=${scope.runId} AND tool_call_id=${call.tool_call_id} AND status IN ('executing','outcome_unknown')`);
    resolved.push({ toolCallId: call.tool_call_id, name: call.name, toolVersion: call.tool_version, riskClass: call.risk_class, receipt });
  }
  const [remaining] = await queryRows<{ count: string }>(tx, sql`SELECT count(*)::int AS count FROM companion_agent_tool_calls
    WHERE run_id=${scope.runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND status IN ('executing','outcome_unknown') AND risk_class<>'read'`);
  return { resolved, unresolvedCount: Number(remaining?.count ?? 0) };
}
