import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../../db/client.ts";
import { writeActivationNoteOrigin } from "../origin-service.ts";

test("activation preserves sealed evidence snapshot IDs on the note origin", async () => {
  const workspaceId = randomUUID();
  const noteId = randomUUID();
  const snapshotId = randomUUID();
  const objectiveRevisionId = randomUUID();
  let inserted: Record<string, unknown> | null = null;
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ noteId, objectiveRevisionId }] }) }) }),
    insert: () => ({ values: (row: Record<string, unknown>) => {
      inserted = row;
      return { onConflictDoNothing: () => ({ returning: async () => [row] }) };
    } }),
  } as unknown as ApiTransaction;
  const result = await writeActivationNoteOrigin(tx, workspaceId, {
    originId: randomUUID(), objectiveId: randomUUID(), objectiveRevisionId, noteVersionId: randomUUID(),
    evidenceSnapshotIds: [snapshotId, snapshotId],
  });
  assert.equal(result.written, true);
  assert.deepEqual(result.origin?.evidenceSnapshotIds, [snapshotId]);
  assert.deepEqual((inserted as unknown as { evidenceSnapshotIds: string[] }).evidenceSnapshotIds, [snapshotId]);
});
