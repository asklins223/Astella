import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NoteDocBlockSpec } from "@astella/shared/note-doc-schema";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

/** Initial note/version/blocks and search projection, shared by the human and
 * companion writers. Interactive editing still uses the existing CRDT loader
 * and projection; this function only owns a brand-new document. */
export async function createPrivateNoteRecords(tx: AgentSqlExecutor,
  scope: { workspaceId: string; userId: string },
  input: { title: string; titleSource: "manual" | "auto"; blocks: readonly NoteDocBlockSpec[];
    noteId?: string; noteVersionId?: string; companionRunId?: string;
    linkRefs?: readonly { noteId: string; noteVersionId: string }[] }) {
  const noteId = input.noteId ?? randomUUID(), noteVersionId = input.noteVersionId ?? randomUUID();
  // The restricted worker receives only this scoped creation function, never
  // general INSERT/UPDATE rights over users' existing notes.
  await tx.execute(sql`SELECT astella_create_private_note_v1(${scope.workspaceId},${scope.userId},${noteId},
    ${noteVersionId},${input.title},${input.titleSource},${JSON.stringify({ blocks: input.blocks, linkRefs: input.linkRefs ?? [] })}::jsonb,
    ${input.companionRunId ?? null}::uuid)`);
  const [saved] = await queryRows<{ id: string; current_version_id: string }>(tx,
    sql`SELECT id,current_version_id FROM notes WHERE id=${noteId} AND workspace_id=${scope.workspaceId}
      AND created_by=${scope.userId} AND deleted_at IS NULL`);
  if (saved?.current_version_id !== noteVersionId) throw new Error("note creation receipt missing");
  return { noteId, noteVersionId };
}
