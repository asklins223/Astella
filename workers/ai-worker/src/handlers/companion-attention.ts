import { z } from "zod";
import type { AgentAttentionObjectV1 } from "@astella/shared/agent-contracts";
import type { ReadContext } from "./companion-dialogue-store.ts";

const refs = z.object({ context: z.object({ noteId: z.string().uuid().optional(), noteVersionId: z.string().uuid().optional(),
  cardId: z.string().uuid().optional(), keyPointId: z.string().uuid().optional(), runId: z.string().uuid().optional(),
}).passthrough() }).passthrough();

/** Projection of the server's persisted page/goal identity, not model-created
 * IDs. Execution still verifies current RLS, version and permission. */
export function companionAttentionObjects(read: Pick<ReadContext, "pageContext">,
  relatedGoals: readonly AgentAttentionObjectV1[] = []): AgentAttentionObjectV1[] {
  const parsed = refs.safeParse(read.pageContext);
  const objects: AgentAttentionObjectV1[] = [];
  if (parsed.success) {
    const context = parsed.data.context;
    if (context.noteId) objects.push({ kind: context.noteVersionId ? "note_version" : "note", id: context.noteId,
      ...(context.noteVersionId ? { versionId: context.noteVersionId } : {}) });
    if (context.cardId) objects.push({ kind: "card", id: context.cardId });
    if (context.keyPointId) objects.push({ kind: "key_point", id: context.keyPointId });
    if (context.runId) objects.push({ kind: "learning_run", id: context.runId });
  }
  objects.push(...relatedGoals);
  return objects;
}
