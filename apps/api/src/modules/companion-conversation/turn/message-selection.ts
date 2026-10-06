import { sql } from "drizzle-orm";
import { companionSelectionV1Schema } from "@astella/shared/companion-conversation-contracts";

/** 选文附在用户消息对应的 run 上；只投影这段快照，不返回整个后台上下文。 */
export function companionMessageSelectionSql(messageTable: "companion_messages" | "m") {
  // 用明确的表名限定外层字段：Drizzle 单表 SELECT 会移除 Column 的表名，
  // 子查询里的裸 id/conversation_id 就会错误地绑定到 r 自己。
  const column = (name: string) => sql`${sql.identifier(messageTable)}.${sql.identifier(name)}`;
  return sql<unknown>`CASE WHEN ${column("role")} = 'user' THEN (
    SELECT r.page_context -> 'selection'
    FROM companion_turn_runs r
    WHERE r.conversation_id = ${column("conversation_id")} AND r.user_message_id = ${column("id")}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  ) ELSE NULL END`;
}

export function companionMessageSelection(value: unknown) {
  const parsed = companionSelectionV1Schema.safeParse(value);
  return parsed.success ? { selection: parsed.data } : {};
}
