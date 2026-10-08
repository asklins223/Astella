import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { companionEditNoteV1Schema, companionEditedNoteV1Schema, companionNoteEditingContextV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolNotExecutedError, type AgentToolExecutionResult } from "./companion-tool-result.ts";

/** The executing tool supplies feedback even when the user's phrasing has no edit keyword. */
export function companionNoteEditTarget(arguments_: unknown, pageContext: unknown) {
  const parsed = companionEditNoteV1Schema.safeParse(arguments_);
  if (!parsed.success) return undefined;
  const input = parsed.data;
  const target = (startBlock: number, endBlock = startBlock) => ({ noteId: input.noteId, startBlock, endBlock });
  if (input.operation.endsWith("blocks")) return target(input.startBlock!, input.endBlock!);
  const page = pageContext as { context?: { noteId?: unknown; editing?: unknown } } | null;
  if (page?.context?.noteId !== input.noteId) return undefined;
  const context = companionNoteEditingContextV1Schema.safeParse(page.context.editing);
  if (!context.success) return undefined;
  const editing = context.data;
  if (input.operation === "append") return editing.tail ? target(editing.tail.block) : undefined;
  if (input.operation === "insert_at_cursor") return editing.cursor ? target(editing.cursor.block) : undefined;
  return editing.selection ? target(editing.selection.startBlock, editing.selection.endBlock) : undefined;
}

/** The API owns the live CRDT document and returns the actual persisted receipt. */
export async function executeCompanionNoteEdit(event: AgentEventContext, callId: string, signal?: AbortSignal): Promise<AgentToolExecutionResult> {
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  for (;;) {
    if (signal?.aborted || event.ctx.signal?.aborted) throw new CompanionToolNotExecutedError("这轮已停止，请核对正文中的实际结果。");
    const rows = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ result_ref: string | null; status: string }>(sql`
      SELECT result_ref,status FROM companion_agent_tool_calls WHERE run_id=${event.read.runId}
        AND tool_call_id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND name='companion_edit_note'`));
    if (rows[0]?.result_ref) {
      const value = JSON.parse(rows[0].result_ref);
      if (value.kind === "note_edit_failed") throw new CompanionToolNotExecutedError(value.message);
      const receipt = companionEditedNoteV1Schema.parse(value);
      const { update: _update, ...modelReceipt } = receipt;
      return { value: { ...modelReceipt, status: "succeeded" }, safeSummary: receipt.summary, resultRef: JSON.stringify(receipt) };
    }
    if (!rows[0] || rows[0].status !== "executing") throw new CompanionToolNotExecutedError("这次编辑已经停止，请核对正文。");
    await delay(180, undefined, { signal });
  }
}
