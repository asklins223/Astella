import { sql } from "drizzle-orm";
import { resolveCompanionMemoryTemporalMetadata } from "@astella/shared";
import { queryRows, type AgentSqlExecutor } from "@astella/agent-host";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import { CompanionToolNotExecutedError } from "../tools/companion-tool-result.ts";

/** Verify factual provenance; authorization still belongs to the current turn.
 * A follow-up acceptance can refer to a unique earlier statement by this user. */
export async function readCompanionMemoryWriteSource(
  tx: AgentSqlExecutor,
  event: { ctx: Pick<AgentEventContext["ctx"], "workspaceId">;
    read: Pick<AgentEventContext["read"], "userMessageId" | "conversationId" | "userId"> },
  input: { kind: string; content: string; sourceQuote?: string | null; appliesWhen?: string | null; validUntil?: string | null },
) {
  const rows = await queryRows<{ id: string; seq: string; created_at: Date; source_text: string }>(tx, sql`
    SELECT id,seq,created_at, coalesce((
      SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(blocks) b WHERE b->>'type' = 'text'
    ), '') AS source_text
    FROM companion_messages
    WHERE id=${event.read.userMessageId}::uuid AND conversation_id=${event.read.conversationId}::uuid
      AND workspace_id=${event.ctx.workspaceId} AND user_id=${event.read.userId} AND role='user'
    LIMIT 1
  `);
  let source = (Array.isArray(rows) ? rows : [])[0];
  if (!source) throw new CompanionToolNotExecutedError("当前这句话的来源已无法核对，这次没有写入记忆");
  if (input.sourceQuote && !source.source_text.includes(input.sourceQuote)) {
    const earlier = await queryRows<typeof source>(tx, sql`
      SELECT id,seq,created_at,source_text FROM (
        SELECT id,seq,created_at,coalesce((
          SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(blocks) b WHERE b->>'type'='text'
        ), '') AS source_text FROM companion_messages
        WHERE conversation_id=${event.read.conversationId}::uuid AND workspace_id=${event.ctx.workspaceId}
          AND user_id=${event.read.userId} AND role='user' AND seq<${source.seq}::bigint
      ) prior WHERE strpos(source_text,${input.sourceQuote})>0 ORDER BY seq DESC LIMIT 2
    `);
    if (earlier.length === 1 && earlier[0]!.source_text.includes(input.sourceQuote)) source = earlier[0]!;
  }
  const temporal = resolveCompanionMemoryTemporalMetadata({ ...input, sourceText: source.source_text });
  if (!temporal.ok) throw new CompanionToolNotExecutedError(
    "记忆的来源、适用条件或期限没有对上。请逐字引用当前发言或同一会话中可唯一核对的用户原话，并使用其中的原文条件；来源有歧义时先澄清，没有明确截止时间不设置期限。这次没有保存，也没有发起确认。",
  );
  return { messageId: source.id ?? event.read.userMessageId, createdAt: source.created_at, ...temporal };
}
