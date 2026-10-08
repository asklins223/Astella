import { sql } from "drizzle-orm";
import { createPrivateNoteRecords, queryRows } from "@astella/agent-host";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { markdownToBlocks } from "@astella/shared/markdown-parser";
import { noteLinkHref, noteLinkTarget, noteMarkdownTree } from "@astella/shared/note-markdown";
import { companionCreateNoteV1Schema, companionCreatedNoteV1Schema,
  type CompanionCreatedNoteV1 } from "@astella/shared/companion-note-authoring-contracts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { lockJobLease } from "../lib/job-lease.ts";
import { assertCompanionContextSourcesCurrent } from "./companion-context-sources.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolNotExecutedError, type AgentToolExecutionResult } from "./companion-tool-result.ts";

/** One current-turn creation has a stable identity across provider retries. */
export function companionCreatedNoteId(runId: string): string {
  const hash = sha256Utf8V1(`companion-created-note:${runId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function createdNoteToolResult(receipt: CompanionCreatedNoteV1): AgentToolExecutionResult {
  return { value: { ...receipt, status: "succeeded" }, resultRef: JSON.stringify(receipt),
    safeSummary: `已保存笔记《${receipt.title.slice(0, 36)}》，含 ${receipt.linkedNotes.length} 个库内链接，可打开继续编辑`,
    blocks: [{ type: "nav", label: `打开《${receipt.title.slice(0, 60)}》`, route: { kind: "note", noteId: receipt.noteId } }] };
}

export function readCreatedNoteReceipt(value: string | null): CompanionCreatedNoteV1 | null {
  if (!value) return null;
  try {
    const parsed = companionCreatedNoteV1Schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

const escapeMarkdown = (value: string) => value.replace(/[\\[\]()*_`<>]/g, "\\$&").replace(/\s+/g, " ");

/** Links in generated prose must use the same verified IDs as the appended
 * reading paths. Code literals are not links; wiki/HTML links are checked too. */
export function assertGeneratedNoteLinks(markdown: string, allowedIds: ReadonlySet<string>): void {
  const walk = (node: ReturnType<typeof noteMarkdownTree> | ReturnType<typeof noteMarkdownTree>["children"][number]) => {
    if (node.type === "element" && node.tagName === "a") {
      const target = noteLinkTarget(String(node.properties.href ?? ""));
      if (target && (target.kind !== "id" || !allowedIds.has(target.value)))
        throw new CompanionToolNotExecutedError("正文里的库内链接还没有核对，请用实际读过的笔记身份关联。");
    }
    if ("children" in node) node.children.forEach(child => walk(child));
  };
  walk(noteMarkdownTree(markdown));
}

export type CompanionNoteAuthoringEvent = {
  ctx: AgentEventContext["ctx"];
  read: Pick<AgentEventContext["read"], "runId" | "userId" | "accountEpoch" | "generation">;
};

export async function executeCompanionCreateNote(event: CompanionNoteAuthoringEvent,
  args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolExecutionResult> {
  const input = companionCreateNoteV1Schema.parse(args);
  const links = [...new Map(input.links.map(link => [link.noteId, link])).values()];
  assertGeneratedNoteLinks(input.markdown, new Set(links.map(link => link.noteId)));
  const assertNotAborted = () => {
    if (signal?.aborted || event.ctx.signal?.aborted)
      throw new CompanionToolNotExecutedError("这一轮已经停止，笔记没有保存。");
  };
  assertNotAborted();
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  const receipt = await withWorkerWorkspaceTransaction(scope, async tx => {
    const [owner] = await queryRows<{ allowed: boolean }>(tx,
      sql`SELECT astella_note_creation_scope_current(${scope.workspaceId},${scope.userId}) AS allowed`);
    if (!owner?.allowed) throw new CompanionToolNotExecutedError("当前空间只能阅读，笔记没有保存。可以回到有写入权限的空间再整理。");
    await lockJobLease(tx, event.ctx);
    await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
    const [run] = await queryRows<{ id: string }>(tx, sql`SELECT r.id FROM companion_turn_runs r
      JOIN user_companion_account_state a ON a.user_id=r.user_id
      WHERE r.id=${event.read.runId} AND r.workspace_id=${scope.workspaceId} AND r.user_id=${scope.userId}
        AND r.account_epoch=${event.read.accountEpoch} AND r.generation=${event.read.generation}
        AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
        AND a.global_enabled AND a.epoch=r.account_epoch AND r.permission_level<>'read_only'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_snapshot->'offeredTools') tool
          WHERE tool->>'name'='companion_create_note') FOR UPDATE OF r`);
    if (!run || event.ctx.requestedBy !== scope.userId)
      throw new CompanionToolNotExecutedError("这一轮已停止或没有保存权限，笔记没有保存。");
    assertNotAborted();
    const noteId = companionCreatedNoteId(event.read.runId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`companion-note:${noteId}`},0))`);
    const [existing] = await queryRows<{ id: string; current_version_id: string; title: string }>(tx,
      sql`SELECT id,current_version_id,title FROM notes WHERE id=${noteId} AND workspace_id=${scope.workspaceId}
        AND created_by=${scope.userId} AND deleted_at IS NULL`);
    if (existing) {
      // The prior write already committed. Preserve it even if a retry rewrites
      // its argument text; never replace an editable document on recovery.
      const [call] = await queryRows<{ result_ref: string | null }>(tx,
        sql`SELECT result_ref FROM companion_agent_tool_calls WHERE run_id=${event.read.runId}
          AND name='companion_create_note' AND result_ref IS NOT NULL ORDER BY created_at LIMIT 1`);
      return readCreatedNoteReceipt(call?.result_ref ?? null) ?? {
        kind: "created_note" as const, noteId: existing.id, noteVersionId: existing.current_version_id,
        title: existing.title, linkedNotes: [],
      };
    }
    const [searched] = await queryRows<{ found: boolean }>(tx, sql`SELECT EXISTS(SELECT 1 FROM companion_agent_tool_calls
      WHERE run_id=${event.read.runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND name='companion_search_notes' AND status='succeeded') AS found`);
    if (!searched?.found)
      throw new CompanionToolNotExecutedError("先搜索库里与这个知识点相关的笔记，再保存；没有相关内容也可以写成独立笔记。");
    const linkedNotes: CompanionCreatedNoteV1["linkedNotes"] = [];
    const readingPaths: string[] = [];
    for (const link of links) {
      const [note] = await queryRows<{ id: string; title: string }>(tx, sql`SELECT n.id,n.title FROM notes n
        WHERE n.id=${link.noteId} AND n.workspace_id=${scope.workspaceId} AND n.deleted_at IS NULL
          AND (n.share_scope='shared' OR n.created_by=${scope.userId}) AND n.current_version_id=${link.noteVersionId}
          AND EXISTS(SELECT 1 FROM companion_agent_tool_calls c WHERE c.run_id=${event.read.runId}
            AND c.workspace_id=${scope.workspaceId} AND c.user_id=${scope.userId}
            AND c.name='companion_read_note' AND c.status='succeeded'
            AND c.result_ref=${JSON.stringify({ kind: "note_read", noteId: link.noteId, noteVersionId: link.noteVersionId })})`);
      if (!note) throw new CompanionToolNotExecutedError("关联的笔记尚未读取、已经改版或当前不可见。先核对正文，再保存新笔记。");
      linkedNotes.push({ noteId: note.id, title: note.title });
      readingPaths.push(`- [${escapeMarkdown(note.title)}](${noteLinkHref(note.id)})：${escapeMarkdown(link.reason)}`);
    }
    const markdown = input.markdown + (readingPaths.length ? `\n\n## 相关笔记\n\n${readingPaths.join("\n")}` : "");
    const blocks = markdownToBlocks(markdown);
    assertNotAborted();
    const saved = await createPrivateNoteRecords(tx, scope, {
      title: input.title, titleSource: "manual", blocks, noteId, companionRunId: event.read.runId, linkRefs: links,
    });
    assertNotAborted();
    const result: CompanionCreatedNoteV1 = { kind: "created_note", ...saved, title: input.title, linkedNotes };
    // Persist identity with the business write. An interrupted outer ledger
    // update can recover this receipt without creating a second note.
    await tx.execute(sql`UPDATE companion_agent_tool_calls SET result_ref=${JSON.stringify(result)}
      WHERE run_id=${event.read.runId} AND name='companion_create_note' AND status='executing'`);
    return result;
  });
  return createdNoteToolResult(receipt);
}
