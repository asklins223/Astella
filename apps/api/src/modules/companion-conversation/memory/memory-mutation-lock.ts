import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../../db/client.ts";
import { companionMemoryMutationLockKey } from "@astella/shared/db-schema/assistant-memory";

/** Serialize automatic extraction against every user-driven memory deletion path. */
export async function lockMemoryMutations(executor: ApiTransaction, userId: string): Promise<void> {
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${companionMemoryMutationLockKey(userId)}, 0))
  `);
}
