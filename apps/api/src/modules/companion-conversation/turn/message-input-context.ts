import { sql } from "drizzle-orm";
import { companionInputReferenceV1Schema, companionSelectionV1Schema } from "@astella/shared/companion-conversation-contracts";

/** 选文附在用户消息对应的 run 上；只投影这段快照，不返回整个后台上下文。 */
export function companionMessageInputContextSql(messageTable: "companion_messages" | "m") {
  // 用明确的表名限定外层字段：Drizzle 单表 SELECT 会移除 Column 的表名，
  // 子查询里的裸 id/conversation_id 就会错误地绑定到 r 自己。
  const column = (name: string) => sql`${sql.identifier(messageTable)}.${sql.identifier(name)}`;
  return sql<unknown>`CASE WHEN ${column("role")} = 'user' THEN (
    SELECT jsonb_build_object(
      'selection', r.page_context -> 'selection',
      'inputReference', CASE
        WHEN r.page_context #>> '{context,pageKind}' = 'note' THEN jsonb_strip_nulls(jsonb_build_object(
          'kind', 'note', 'noteId', r.page_context #> '{context,noteId}',
          'noteVersionId', r.page_context #> '{context,noteVersionId}', 'title', r.page_context #> '{context,noteTitle}'))
        WHEN r.page_context -> 'diaryReference' IS NOT NULL THEN jsonb_build_object(
          'kind', 'diary', 'date', r.page_context #> '{diaryReference,date}', 'version', r.page_context #> '{diaryReference,version}')
        ELSE NULL END)
    FROM companion_turn_runs r
    WHERE r.conversation_id = ${column("conversation_id")} AND r.user_message_id = ${column("id")}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  ) ELSE NULL END`;
}

export function companionMessageInputContext(value: unknown) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const selection = companionSelectionV1Schema.safeParse(raw.selection);
  const reference = companionInputReferenceV1Schema.safeParse(raw.inputReference);
  return { ...(selection.success ? { selection: selection.data } : {}),
    ...(reference.success ? { inputReference: reference.data } : {}) };
}
