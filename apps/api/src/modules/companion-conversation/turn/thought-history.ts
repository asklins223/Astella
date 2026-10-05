import { sql } from "drizzle-orm";
import {
  companionChatListThoughtsRequestV1Schema,
  companionChatListThoughtsResultV1Schema,
  type CompanionChatListThoughtsRequestV1,
  type CompanionChatListThoughtsResultV1,
} from "@ailearn/shared/companion-chat-desktop-contracts";
import { withWorkspaceTransaction } from "../../../db/client.ts";
import { CompanionConversationError } from "./turn-service.ts";

/** 回看只读已表达的短念想，不消耗气泡、不启动对话，也不展示未通过投递的候选。 */
export async function listCompanionThoughts(args: {
  workspaceId: string;
  userId: string;
  request: CompanionChatListThoughtsRequestV1;
}): Promise<CompanionChatListThoughtsResultV1> {
  const request = companionChatListThoughtsRequestV1Schema.parse(args.request);
  const limit = request.limit ?? 30;
  return withWorkspaceTransaction({ workspaceId: args.workspaceId, userId: args.userId }, async tx => {
    const scope = sql`workspace_id = ${args.workspaceId} AND user_id = ${args.userId}`;
    const visible = sql`delivered_at IS NOT NULL AND status IN ('delivered', 'spent', 'expired')`;
    let before = sql``;
    if (request.before) {
      const anchors = await tx.execute<{ id: string }>(sql`
        SELECT id FROM assistant_thoughts
        WHERE ${scope} AND ${visible} AND id = ${request.before}
      `);
      const anchor = anchors[0];
      if (!anchor) throw new CompanionConversationError("NOT_FOUND", 404, "thought not found");
      // 留在数据库里比较，避免 JS Date 截掉投递时间的微秒，导致连续翻页漏掉念想。
      before = sql`AND (delivered_at, id) < (
        SELECT delivered_at, id FROM assistant_thoughts WHERE ${scope} AND ${visible} AND id = ${anchor.id}
      )`;
    }
    const rows = await tx.execute<{
      id: string; text: string; status: string; created_at: Date;
      delivered_at: Date; opened_at: Date | null; expires_at: Date;
    }>(sql`
      SELECT id, text, status, created_at, delivered_at, opened_at, expires_at
      FROM assistant_thoughts WHERE ${scope} AND ${visible} ${before}
      ORDER BY delivered_at DESC, id DESC LIMIT ${limit + 1}
    `);
    const items = rows.slice(0, limit).map(row => ({
      id: row.id, text: row.text, status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      deliveredAt: new Date(row.delivered_at).toISOString(),
      openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
      expiresAt: new Date(row.expires_at).toISOString(),
    }));
    return companionChatListThoughtsResultV1Schema.parse({
      version: 1, items, nextBefore: rows.length > limit ? items.at(-1)?.id ?? null : null,
    });
  });
}
