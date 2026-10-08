import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import type { ApiTransaction } from "../../../db/client.ts";

/** Save the already committed stream in the transaction that ends the run.
 * The worker fence forbids late writes, so retention cannot depend on the
 * cancelled worker writing a final message afterwards. */
export async function retainCompanionCancelledPartial(tx: ApiTransaction, scope: {
  workspaceId: string; userId: string; conversationId: string; runId: string;
}): Promise<void> {
  const claimed = await tx.execute<{ id: string }>(sql`
    SELECT id FROM companion_turn_runs
    WHERE id=${scope.runId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
      AND status IN ('cancelled','superseded') AND assistant_message_id IS NULL
    FOR UPDATE
  `);
  if (!claimed[0]) return;
  const events = await tx.execute<{ payload: Record<string, unknown> }>(sql`
    SELECT payload FROM companion_stream_events
    WHERE run_id=${scope.runId} AND conversation_id=${scope.conversationId}
      AND type='assistant.delta' ORDER BY seq
  `);
  let text = "";
  for (const { payload } of events) {
    if (typeof payload?.textDelta !== "string") continue;
    const offset = payload.appendFrom ?? text.length;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > text.length) continue;
    text = offset === text.length ? text + payload.textDelta : text.slice(0, offset) + payload.textDelta;
  }
  if (!text.trim()) return;
  const blocks = [{ type: "text" as const, text }];
  const messageId = randomUUID();
  const counters = await tx.execute<{ next_message_seq: number }>(sql`
    UPDATE companion_conversations
    SET next_message_seq=next_message_seq+1, last_message_at=now(), updated_at=now()
    WHERE id=${scope.conversationId} RETURNING next_message_seq
  `);
  if (!counters[0]) throw new Error("cancelled conversation disappeared");
  await tx.execute(sql`
    INSERT INTO companion_messages
      (id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,run_id,content_sha256)
    VALUES(${messageId},${scope.workspaceId},${scope.userId},${scope.conversationId},
      ${Number(counters[0].next_message_seq)-1},'assistant','cancelled',
      ${JSON.stringify(blocks)},${scope.runId},${sha256Utf8V1(canonicalJsonV1(blocks))})
  `);
  await tx.execute(sql`
    UPDATE companion_turn_runs SET assistant_message_id=${messageId},updated_at=now()
    WHERE id=${scope.runId}
  `);
}
