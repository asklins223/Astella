import { sql } from "drizzle-orm";

/** Queue an idempotent background rebuild alongside the memory write. */
export async function enqueueCompanionMemoryEmbeddingRebuild(
  tx: { execute(query: unknown): Promise<unknown> },
  input: {
    workspaceId: string;
    userId: string;
    idempotencyKey: string;
  },
): Promise<void> {
  if (process.env.COMPANION_MEMORY_VECTOR_V1 !== "true") return;

  await tx.execute(sql`
    INSERT INTO jobs
      (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
    VALUES
      ('companion_memory_embedding_rebuild', ${input.workspaceId}, ${input.userId},
       ${JSON.stringify({ userId: input.userId })}, 'pending', 10, 'maintenance', ${input.idempotencyKey})
    ON CONFLICT (workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    DO NOTHING
  `);
}
