import { prepareCompanionGeneratedNote } from "../note/companion-note-authoring.ts";
import { sql } from "drizzle-orm";
import { companionToolConfirmationStage, COMPANION_AGENT_TOOL_LABELS, type CompanionAgentToolDefinitionV1 } from "@astella/shared";
import { companionCreateNoteV1Schema, companionEditNoteV1Schema, companionNoteEditingContextV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import { previewCompanionNoteEdit, NoteEditConflict } from "@astella/shared/note-companion-transform";
import { noteBlockMarkdown } from "@astella/shared/note-markdown";
import type { NoteDocBlockSpec } from "@astella/shared/note-doc-schema";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolNotExecutedError } from "./companion-tool-result.ts";

/** Review complete generated data. Actual effects wait for one frozen decision. */
export async function prepareCompanionToolReview(event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1, arguments_: Record<string, unknown>) {
  // 扩展 C（2026-10-15）：page_context 里随回合上抛的发起端界面——mobile 发起的
  // 正文修改切成 before_execute 确认提案（桌面行为不变）。
  const originClientKind = ((event.read.pageContext as { clientSurface?: unknown } | null)?.clientSurface === "mobile")
    ? "mobile" : null;
  const confirmationStage = companionToolConfirmationStage(definition, arguments_, { originClientKind });
  let expectedTarget: Record<string, unknown> | undefined;
  const preview: { title: string; markdown?: string; beforeMarkdown?: string; noteId?: string } = {
    title: String(arguments_.title ?? COMPANION_AGENT_TOOL_LABELS[definition.name] ?? "查看这次改动").slice(0, 200),
  };
  if (definition.name === "companion_create_note") {
    const input = companionCreateNoteV1Schema.parse(arguments_);
    const prepared = await withWorkerWorkspaceTransaction({ workspaceId: event.ctx.workspaceId, userId: event.read.userId },
      tx => prepareCompanionGeneratedNote(tx, event, input));
    preview.markdown = prepared.markdown;
  }
  else if (definition.name === "companion_edit_note") {
    const input = companionEditNoteV1Schema.parse(arguments_);
    const page = event.read.pageContext as { context?: { noteId?: string; noteVersionId?: string; editing?: unknown } } | null;
    if (page?.context?.noteId !== input.noteId) throw new CompanionToolNotExecutedError("请先打开要调整的笔记，再准备这次改动。");
    const editing = companionNoteEditingContextV1Schema.parse(page.context.editing ?? {});
    const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
    const result = await withWorkerWorkspaceTransaction(scope, async tx => {
      const heads = await tx.execute<{ title: string; current_version_id: string }>(sql`
        SELECT n.title,n.current_version_id FROM notes n
        WHERE n.id=${input.noteId} AND n.workspace_id=${scope.workspaceId} AND n.deleted_at IS NULL
          AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))}`);
      if (!heads[0] || heads[0].current_version_id !== input.noteVersionId)
        throw new CompanionToolNotExecutedError("笔记已经换版，请重新读取后再调整。");
      const rows = await tx.execute(sql`SELECT type,content,source_ref,image_asset_id FROM note_blocks
        WHERE version_id=${input.noteVersionId} ORDER BY ordinal`);
      return { title: heads[0].title, blocks: rows.map(row => ({ type: row.type, content: row.content,
        ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
        ...(row.image_asset_id ? { imageAssetId: row.image_asset_id } : {}) })) as NoteDocBlockSpec[] };
    });
    preview.title = result.title; preview.noteId = input.noteId;
    preview.beforeMarkdown = result.blocks.map(block => noteBlockMarkdown(block.type, block.content)).join("\n\n");
    try {
      const changed = previewCompanionNoteEdit(result.blocks, input, editing);
      // before_execute 的非删除操作（如 mobile 改写确认）给"改后全文"做对照；
      // 删除类给"将被删的原文"，让用户确认前知道自己在删什么。
      preview.markdown = confirmationStage === "after_preview" || !String(input.operation).startsWith("delete")
        ? changed.map(block => noteBlockMarkdown(block.type, block.content)).join("\n\n")
        : `将从《${result.title}》删除以下原文：\n\n${input.expectedBlocks?.join("\n\n") ?? editing.selection?.excerpt ?? ""}`;
    } catch (error) { if (error instanceof NoteEditConflict) throw new CompanionToolNotExecutedError(error.message); throw error; }
  } else if (definition.name === "companion_forget_memory" || definition.name === "companion_cancel_reminder") {
    const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
    expectedTarget = await withWorkerWorkspaceTransaction(scope, async tx => {
      const rows = definition.name === "companion_forget_memory"
        ? await tx.execute<{ state: Record<string, unknown> }>(sql`SELECT jsonb_build_object('content',content,'revision',revision) AS state
          FROM assistant_memory_items WHERE id=${String(arguments_.memoryId)}::uuid AND workspace_id=${scope.workspaceId}
            AND user_id=${scope.userId} AND deleted_at IS NULL`)
        : await tx.execute<{ state: Record<string, unknown> }>(sql`SELECT jsonb_build_object('text',text,'fireAt',fire_at::text) AS state
          FROM companion_reminders WHERE id=${String(arguments_.reminderId)}::uuid AND workspace_id=${scope.workspaceId}
            AND user_id=${scope.userId} AND status='pending'`);
      if (!rows[0]) throw new CompanionToolNotExecutedError("要删除的内容已经变化或不再可用，请重新查看。");
      return rows[0].state;
    });
    preview.title = definition.name === "companion_forget_memory" ? "删除这条记忆" : "取消这个提醒";
    preview.markdown = definition.name === "companion_forget_memory" ? String(expectedTarget.content)
      : `${String(expectedTarget.text)}\n\n原定时间：${String(expectedTarget.fireAt)}`;
  } else {
    const labels: Record<string, string> = { content: "内容", text: "内容", title: "标题", activeness: "陪伴频率",
      tier: "保存位置", fireAtLocal: "提醒时间", allowPlayful: "玩趣", allowNudgeLearning: "学习提醒",
      allowVoiceTags: "语音情绪", catchphrase: "口头禅", appliesWhen: "适用情况", validFrom: "生效时间", validUntil: "结束时间" };
    const values = Object.entries(arguments_).filter(([key]) => !/id$|revision|sourceQuote/i.test(key));
    preview.markdown = values.map(([key, value]) => `${labels[key] ?? "改动"}：${typeof value === "boolean" ? (value ? "开启" : "关闭") : typeof value === "string" ? value : JSON.stringify(value)}`).join("\n\n");
  }
  return { kind: "agent_tool_review", toolName: definition.name, arguments: arguments_, confirmationStage, preview,
    ...(expectedTarget ? { expectedTarget } : {}) };
}
