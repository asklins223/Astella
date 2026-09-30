import { and, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { companionConversations, companionMessages, companionTurnRuns } from "@ailearn/shared/db-schema/companion-conversations";

export interface NoteCompanionSourceV1 {
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * Confirm that a persisted Companion reply came from this exact note snapshot.
 * A message UUID alone is not provenance: any same-user reply could otherwise be
 * attached to an unrelated note or selected passage.
 */
export async function isAssistantReplyForNote(
  tx: ApiTransaction,
  scope: NoteCompanionSourceV1,
  input: {
    readonly messageId: string;
    readonly noteId: string;
    readonly noteVersionId: string;
    readonly conversationId?: string;
    /** undefined = don't constrain selection; null = require a note-wide reply without a selected passage. */
    readonly selectionText?: string | null;
  },
): Promise<boolean> {
  return Boolean(await assistantReplyTextForNote(tx, scope, input));
}

export async function assistantReplyTextForNote(
  tx: ApiTransaction,
  scope: NoteCompanionSourceV1,
  input: {
    readonly messageId: string;
    readonly noteId: string;
    readonly noteVersionId: string;
    readonly conversationId?: string;
    /** undefined = don't constrain selection; null = require a note-wide reply without a selected passage. */
    readonly selectionText?: string | null;
  },
): Promise<string | null> {
  const [source] = await tx.select({ blocks: companionMessages.blocks }).from(companionMessages)
    .innerJoin(companionConversations, eq(companionConversations.id, companionMessages.conversationId))
    .innerJoin(companionTurnRuns, and(
      eq(companionTurnRuns.id, companionMessages.runId),
      eq(companionTurnRuns.assistantMessageId, companionMessages.id),
      eq(companionTurnRuns.conversationId, companionMessages.conversationId),
    ))
    .where(and(
      eq(companionMessages.id, input.messageId),
      eq(companionMessages.workspaceId, scope.workspaceId),
      eq(companionMessages.userId, scope.userId),
      eq(companionMessages.role, "assistant"),
      eq(companionMessages.kind, "text"),
      eq(companionConversations.workspaceId, scope.workspaceId),
      eq(companionConversations.userId, scope.userId),
      eq(companionTurnRuns.workspaceId, scope.workspaceId),
      eq(companionTurnRuns.userId, scope.userId),
      eq(companionTurnRuns.status, "succeeded"),
      input.conversationId ? eq(companionMessages.conversationId, input.conversationId) : undefined,
      sql`${companionTurnRuns.pageContext} #>> '{context,noteId}' = ${input.noteId}`,
      sql`${companionTurnRuns.pageContext} #>> '{context,noteVersionId}' = ${input.noteVersionId}`,
      input.selectionText === undefined
        ? undefined
        : input.selectionText === null
          ? sql`${companionTurnRuns.pageContext} #>> '{selection,text}' IS NULL`
          : sql`${companionTurnRuns.pageContext} #>> '{selection,text}' = ${input.selectionText}`,
    ));
  if (!source) return null;
  return source.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim() || null;
}
