import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { noteShareScopeReceiptV1Schema } from "@astella/shared/note-share-contracts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolNotExecutedError, type AgentToolExecutionResult } from "./companion-tool-result.ts";

/**
 * API 写回来的回执 → 这一步的结果或错误。
 *
 * 单独抽出来是为了把三档**不混**钉成可测的东西：`note_share_failed` 是"没做成"
 * （可以说没改），`note_share_unknown` 是"可能已经改了但拿不到回执"（既不能说改了
 * 也不能说没改，必须走 outcome_unknown 那一档），成功才给可见的结论。
 * 这三档一旦在循环里就地写，最容易出的错是把 unknown 当 failed——用户据此再点一次，
 * 而共享可能已经生效过一轮。
 */
export function companionShareStepResult(value: unknown): AgentToolExecutionResult {
  const { kind, message, ...rest } = value as { kind?: string; message?: string };
  if (kind === "note_share_failed")
    throw new CompanionToolNotExecutedError(message ?? "可见范围没有改动。");
  if (kind === "note_share_unknown") throw new Error("note_share_save_unconfirmed");
  const shared = noteShareScopeReceiptV1Schema.parse(rest);
  return {
    value: { ...shared, status: "succeeded" },
    resultRef: JSON.stringify(shared),
    safeSummary: shared.changed
      ? `已把这篇设为「${shared.shareScope === "shared" ? "已共享给空间" : "仅自己可见"}」，${
        shared.shareScope === "shared" ? "空间里的人现在能读到它" : "之后别人再也读不到它"}（已经生成的学习卡不受影响）`
      : `这篇本来就是「${shared.shareScope === "shared" ? "已共享给空间" : "仅自己可见"}」，这一项没有改动`,
    blocks: [{ type: "nav", label: "回到那篇笔记", route: { kind: "note", noteId: shared.noteId } }],
  };
}

/**
 * 「共享给空间」/「取消共享」的 worker 侧（2026-10-09）。
 *
 * 这里**不写笔记**：worker 角色对 `notes` 没有 UPDATE 权限（0395 立的规矩），
 * 而可见性一变，目标索引里那句公开标题要跟着变——那条投影规则只住在服务层
 * `setNoteShareScope` 一处。所以这一份与 `executeCompanionNoteEdit` 同形状：
 * 登记要做什么的是台账，真正落库的是 API 那个派发器，worker 只等它写回来的回执。
 *
 * 为什么宁可多一次轮询也不在 worker 里补一份投影刷新：那等于第二个笔记写入者，
 * 两处规则一旦分岔，最先出问题的方向是**撤回共享之后标题还留在别人的搜索里**。
 */
export async function executeCompanionShareNote(
  event: AgentEventContext, callId: string, signal?: AbortSignal,
): Promise<AgentToolExecutionResult> {
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  for (;;) {
    if (signal?.aborted || event.ctx.signal?.aborted)
      throw new CompanionToolNotExecutedError("这一轮已经停止，这篇笔记的可见范围没有改动。");
    const rows = await withWorkerWorkspaceTransaction(scope, tx => tx.execute<{ result_ref: string | null; status: string }>(sql`
      SELECT result_ref,status FROM companion_agent_tool_calls WHERE run_id=${event.read.runId}
        AND tool_call_id=${callId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND name='companion_share_note'`));
    const row = (Array.isArray(rows) ? rows : [])[0];
    if (row?.result_ref) return companionShareStepResult(JSON.parse(row.result_ref));
    if (!row || row.status !== "executing")
      throw new CompanionToolNotExecutedError("这次共享已经停止，请先在那一页核对可见范围。");
    await delay(180, undefined, { signal });
  }
}
