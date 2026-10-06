import { sql } from "drizzle-orm";
import { resolveCompanionMemoryTemporalMetadata } from "@astella/shared";
import { queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { CompanionToolNotExecutedError } from "./companion-tool-result.ts";

/** Check the same current source before presenting a proposal and before a direct write. */
export async function readCompanionMemoryWriteSource(
  tx: AgentSqlExecutor,
  event: { ctx: Pick<AgentEventContext["ctx"], "workspaceId">;
    read: Pick<AgentEventContext["read"], "userMessageId" | "conversationId" | "userId"> },
  input: { kind: string; content: string; sourceQuote?: string | null; appliesWhen?: string | null; validUntil?: string | null },
) {
  const rows = await queryRows<{ created_at: Date; source_text: string }>(tx, sql`
    SELECT created_at, coalesce((
      SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(blocks) b WHERE b->>'type' = 'text'
    ), '') AS source_text
    FROM companion_messages
    WHERE id=${event.read.userMessageId}::uuid AND conversation_id=${event.read.conversationId}::uuid
      AND workspace_id=${event.ctx.workspaceId} AND user_id=${event.read.userId} AND role='user'
    LIMIT 1
  `);
  const source = (Array.isArray(rows) ? rows : [])[0];
  if (!source) throw new CompanionToolNotExecutedError("当前这句话的来源已无法核对，这次没有写入记忆");
  const temporal = resolveCompanionMemoryTemporalMetadata({ ...input, sourceText: source.source_text });
  if (!temporal.ok) throw new CompanionToolNotExecutedError(
    "记忆的来源、适用条件或期限没有对上。请逐字引用用户本轮原话，并使用其中的原文条件；没有明确截止时间就不设置期限。这次没有保存，也没有发起确认。",
  );
  return { createdAt: source.created_at, ...temporal };
}
