import { sql } from "drizzle-orm";
import { queryRows } from "@astella/agent-host";
import { companionAnnotationTargetV1Schema, companionWriteAnnotationV1Schema, companionWrittenAnnotationV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { noteAnchorMatchesV1, noteAnnotationV1Schema } from "@astella/shared/note-annotation-contracts";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { lockJobLease } from "../../lib/job-lease.ts";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { CompanionToolNotExecutedError, type AgentToolExecutionResult } from "../tools/companion-tool-result.ts";

export async function executeCompanionWriteAnnotation(event: AgentEventContext,
  args: Record<string, unknown>, signal: AbortSignal | undefined, toolCallId: string): Promise<AgentToolExecutionResult> {
  const input = companionWriteAnnotationV1Schema.parse(args);
  const page = event.read.pageContext as { context?: { pageKind?: string; noteId?: string; noteVersionId?: string; annotationTarget?: unknown }; selection?: { text?: string } } | null;
  const target = companionAnnotationTargetV1Schema.safeParse(page?.context?.annotationTarget);
  if (!target.success || page?.context?.pageKind !== "note" || !page.context.noteId
    || page.context.noteVersionId !== target.data.anchor.noteVersionId || page.selection?.text !== target.data.anchor.excerpt
    || !event.read.userMessageId || event.read.initiativeInput)
    throw new CompanionToolNotExecutedError("这次没有绑定可写入的原句，请从笔记原句重新发起解释。");
  const { requestId, anchor } = target.data;
  const noteId = page.context.noteId;
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  const assertCurrent = () => {
    if (signal?.aborted || event.ctx.signal?.aborted)
      throw new CompanionToolNotExecutedError("这一轮已停止，没有写入未完成的解释。");
  };
  assertCurrent();
  const receipt = await withWorkerWorkspaceTransaction(scope, async tx => {
    await lockJobLease(tx, event.ctx);
    await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
    const [run] = await queryRows<{ id: string }>(tx, sql`SELECT r.id FROM companion_turn_runs r
      JOIN user_companion_account_state a ON a.user_id=r.user_id
      WHERE r.id=${event.read.runId} AND r.workspace_id=${scope.workspaceId} AND r.user_id=${scope.userId}
        AND r.account_epoch=${event.read.accountEpoch} AND r.generation=${event.read.generation}
        AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
        AND a.global_enabled AND a.epoch=r.account_epoch
        AND r.page_context->'context'->'annotationTarget'=${JSON.stringify(target.data)}::jsonb
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') tool
          WHERE tool->>'name'='companion_write_annotation') FOR UPDATE OF r`);
    if (!run || event.ctx.requestedBy !== scope.userId)
      throw new CompanionToolNotExecutedError("这一轮的原句或权限已失效，解释没有写入。");
    const [note] = await queryRows<{ current_version_id: string | null }>(tx, sql`SELECT n.current_version_id FROM notes n
      JOIN note_versions v ON v.note_id=n.id AND v.workspace_id=n.workspace_id AND v.id=${anchor.noteVersionId}
      WHERE n.id=${noteId} AND n.workspace_id=${scope.workspaceId} AND n.deleted_at IS NULL
        AND (n.share_scope='shared' OR n.created_by=${scope.userId})`);
    if (!note) throw new CompanionToolNotExecutedError("原句所属笔记已不可读，解释没有写入。");
    const blocks = await queryRows<{ ordinal: number; type: string; content: string }>(tx, sql`SELECT ordinal,type,content FROM note_blocks
      WHERE workspace_id=${scope.workspaceId} AND version_id=${anchor.noteVersionId}
        AND ordinal BETWEEN ${anchor.startBlockOrdinal} AND ${anchor.endBlockOrdinal} ORDER BY ordinal`);
    if (!noteAnchorMatchesV1(blocks, anchor))
      throw new CompanionToolNotExecutedError("原句位置与保存的笔记对不上，解释没有写入。");
    assertCurrent();
    // The attempt identity belongs to the bound quote, independently of any speech message or provider call id.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-annotation:${requestId}`},0))`);
    await tx.execute(sql`INSERT INTO note_annotations(id,workspace_id,user_id,note_id,note_version_id,
      start_block_ordinal,start_offset,end_block_ordinal,end_offset,excerpt,prefix,suffix,explanation,generation_job_id)
      VALUES(${requestId},${scope.workspaceId},${scope.userId},${noteId},${anchor.noteVersionId},
        ${anchor.startBlockOrdinal},${anchor.startOffset},${anchor.endBlockOrdinal},${anchor.endOffset},
        ${anchor.excerpt},${anchor.prefix},${anchor.suffix},${input.markdown},${event.ctx.id}) ON CONFLICT DO NOTHING`);
    const [saved] = await queryRows<{ explanation: string; generation_job_id: string; revision: number; created_at: Date | string; updated_at: Date | string }>(tx,
      sql`SELECT explanation,generation_job_id,revision,created_at,updated_at FROM note_annotations
        WHERE id=${requestId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND note_id=${noteId}
          AND generation_job_id=${event.ctx.id} AND note_version_id=${anchor.noteVersionId}
          AND start_block_ordinal=${anchor.startBlockOrdinal} AND start_offset=${anchor.startOffset}
          AND end_block_ordinal=${anchor.endBlockOrdinal} AND end_offset=${anchor.endOffset} AND excerpt=${anchor.excerpt}
          AND prefix=${anchor.prefix} AND suffix=${anchor.suffix}`);
    if (!saved) throw new CompanionToolNotExecutedError("这次写入身份与原句不一致，没有覆盖已有批注。");
    assertCurrent();
    const annotation = noteAnnotationV1Schema.parse({ annotationId: requestId, noteId, anchor, explanation: saved.explanation,
      sourceMessageId: null, generationJobId: saved.generation_job_id, revision: saved.revision,
      versionState: note.current_version_id === anchor.noteVersionId ? "current" : "older",
      createdAt: new Date(saved.created_at).toISOString(), updatedAt: new Date(saved.updated_at).toISOString() });
    const result = companionWrittenAnnotationV1Schema.parse({ kind: "written_annotation", requestId, annotation });
    await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify(result)}
      WHERE run_id=${event.read.runId} AND tool_call_id=${toolCallId} AND name='companion_write_annotation' AND status='executing'`);
    return result;
  });
  return { value: { kind: receipt.kind, requestId, annotationId: receipt.annotation.annotationId, saved: true },
    resultRef: JSON.stringify(receipt), safeSummary: "完整解释已写入原句批注，可继续阅读、编辑或拓展。" };
}
