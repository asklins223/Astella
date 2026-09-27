import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  evidenceQuoteCopiesV2,
  evidenceSnapshotsV2,
  learningObjectiveLineageV2,
  learningObjectiveOriginsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { noteBlocks, notes } from "@ailearn/shared/db-schema/note";
import {
  objectiveNoteChangeImpactV1Schema,
  type ObjectiveNoteChangeImpactV1,
} from "@ailearn/shared/learning-objective-surface-contracts";
import { visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import { detectObjectiveNoteChangeImpactV1 } from "./change-impact.ts";

type NoteImpactScope = { workspaceId: string; userId: string };

/**
 * Recompute note-specific impact for objective list rows. This is a projection
 * only: it reads the immutable evidence copy and current version blocks, writes
 * no status, and is called only by the note-filtered objective list.
 */
export async function readNoteChangeImpactsV1(
  tx: ApiTransaction,
  scope: NoteImpactScope,
  noteId: string,
  objectiveIds: readonly string[],
  options: { readonly includeUnchanged?: boolean } = {},
): Promise<Map<string, ObjectiveNoteChangeImpactV1 | null>> {
  const result = new Map<string, ObjectiveNoteChangeImpactV1 | null>(objectiveIds.map((id) => [id, null]));
  if (objectiveIds.length === 0) return result;

  const noteRows = await tx
    .select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, scope.workspaceId),
      eq(notes.id, noteId),
      isNull(notes.deletedAt),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  const currentVersionId = noteRows[0]?.currentVersionId;
  if (!currentVersionId) return result;

  const currentBlocks = await tx
    .select({ ordinal: noteBlocks.ordinal, content: noteBlocks.content })
    .from(noteBlocks)
    .where(and(
      eq(noteBlocks.workspaceId, scope.workspaceId),
      eq(noteBlocks.versionId, currentVersionId),
    ));
  // D3 §3.3: an empty current projection provides no basis for a user-facing claim.
  if (currentBlocks.length === 0) return result;

  const objectives = await tx
    .select({ objectiveId: learningObjectivesV2.objectiveId, revisionId: learningObjectivesV2.currentObjectiveRevisionId })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, scope.workspaceId),
      inArray(learningObjectivesV2.objectiveId, [...objectiveIds]),
      visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
    ));
  const revisionToObjective = new Map(
    objectives.filter((row) => row.revisionId).map((row) => [row.revisionId!, row.objectiveId]),
  );
  const currentRevisionIds = [...revisionToObjective.keys()];
  if (currentRevisionIds.length === 0) return result;

  const [revisions, originRows, lineageRows] = await Promise.all([
    tx
      .select({ objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId, supersedesObjectiveRevisionId: learningObjectiveRevisionsV2.supersedesObjectiveRevisionId })
      .from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.workspaceId, scope.workspaceId),
        inArray(learningObjectiveRevisionsV2.objectiveRevisionId, currentRevisionIds),
      )),
    tx
      .select({ objectiveId: learningObjectiveOriginsV2.objectiveId, objectiveRevisionId: learningObjectiveOriginsV2.objectiveRevisionId,
        noteVersionId: learningObjectiveOriginsV2.noteVersionId, evidenceSnapshotIds: learningObjectiveOriginsV2.evidenceSnapshotIds })
      .from(learningObjectiveOriginsV2)
      .where(and(
        eq(learningObjectiveOriginsV2.workspaceId, scope.workspaceId),
        eq(learningObjectiveOriginsV2.noteId, noteId),
        eq(learningObjectiveOriginsV2.originKind, "note"),
        inArray(learningObjectiveOriginsV2.objectiveId, [...objectiveIds]),
        visibleObjectivesCondition(scope.userId, learningObjectiveOriginsV2.objectiveId),
      )),
    tx
      .select({ predecessorRevisionId: learningObjectiveLineageV2.predecessorRevisionId,
        successorRevisionId: learningObjectiveLineageV2.successorRevisionId })
      .from(learningObjectiveLineageV2)
      .where(and(
        eq(learningObjectiveLineageV2.workspaceId, scope.workspaceId),
        inArray(learningObjectiveLineageV2.successorRevisionId, currentRevisionIds),
      )),
  ]);

  const predecessorBySuccessor = new Map<string, Set<string>>();
  for (const row of lineageRows) {
    const set = predecessorBySuccessor.get(row.successorRevisionId) ?? new Set<string>();
    set.add(row.predecessorRevisionId);
    predecessorBySuccessor.set(row.successorRevisionId, set);
  }
  for (const row of revisions) {
    if (!row.supersedesObjectiveRevisionId) continue;
    const set = predecessorBySuccessor.get(row.objectiveRevisionId) ?? new Set<string>();
    set.add(row.supersedesObjectiveRevisionId);
    predecessorBySuccessor.set(row.objectiveRevisionId, set);
  }

  const predecessorRevisionIds = [...new Set([...predecessorBySuccessor.values()].flatMap((set) => [...set]))];
  const predecessorOrigins = predecessorRevisionIds.length > 0
    ? await tx
        .select({ objectiveRevisionId: learningObjectiveOriginsV2.objectiveRevisionId, objectiveId: learningObjectiveOriginsV2.objectiveId,
          noteVersionId: learningObjectiveOriginsV2.noteVersionId })
        .from(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, scope.workspaceId),
          eq(learningObjectiveOriginsV2.noteId, noteId),
          eq(learningObjectiveOriginsV2.originKind, "note"),
          inArray(learningObjectiveOriginsV2.objectiveRevisionId, predecessorRevisionIds),
          visibleObjectivesCondition(scope.userId, learningObjectiveOriginsV2.objectiveId),
        ))
    : [];

  const currentOriginsByObjective = new Map<string, typeof originRows>();
  for (const row of originRows) {
    const currentRevisionId = objectives.find((objective) => objective.objectiveId === row.objectiveId)?.revisionId;
    if (row.objectiveRevisionId !== currentRevisionId) continue;
    const values = currentOriginsByObjective.get(row.objectiveId) ?? [];
    values.push(row);
    currentOriginsByObjective.set(row.objectiveId, values);
  }

  const requestedSnapshotIds: Array<{ objectiveId: string; evidenceSnapshotId: string; noteVersionId: string }> = [];
  const requestedSnapshotKeys = new Set<string>();
  for (const [objectiveId, origins] of currentOriginsByObjective) {
    for (const origin of origins) {
      if (!origin.noteVersionId) continue;
      for (const evidenceSnapshotId of origin.evidenceSnapshotIds ?? []) {
        const key = `${objectiveId}:${origin.noteVersionId}:${evidenceSnapshotId}`;
        if (requestedSnapshotKeys.has(key)) continue;
        requestedSnapshotKeys.add(key);
        requestedSnapshotIds.push({ objectiveId, evidenceSnapshotId, noteVersionId: origin.noteVersionId });
      }
    }
  }
  const snapshotIds = [...new Set(requestedSnapshotIds.map((row) => row.evidenceSnapshotId))];
  const snapshotRows = snapshotIds.length > 0
    ? await tx
        .select({ evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId, blockId: evidenceSnapshotsV2.blockId,
          startOffset: evidenceSnapshotsV2.startOffset, endOffset: evidenceSnapshotsV2.endOffset,
          quoteHash: evidenceSnapshotsV2.quoteHash, blockContentHash: evidenceSnapshotsV2.blockContentHash })
        .from(evidenceSnapshotsV2)
        .where(and(
          eq(evidenceSnapshotsV2.workspaceId, scope.workspaceId),
          eq(evidenceSnapshotsV2.noteId, noteId),
          inArray(evidenceSnapshotsV2.evidenceSnapshotId, snapshotIds),
        ))
    : [];
  const blockIds = [...new Set(snapshotRows.map((row) => row.blockId).filter((id): id is string => id !== null))];
  const previousBlocks = blockIds.length > 0
    ? await tx
        .select({ id: noteBlocks.id, versionId: noteBlocks.versionId, ordinal: noteBlocks.ordinal })
        .from(noteBlocks)
        .where(and(eq(noteBlocks.workspaceId, scope.workspaceId), inArray(noteBlocks.id, blockIds)))
    : [];
  const quoteCopies = snapshotIds.length > 0
    ? await tx
        .select({ evidenceSnapshotId: evidenceQuoteCopiesV2.evidenceSnapshotId, quoteText: evidenceQuoteCopiesV2.quoteText, quoteHash: evidenceQuoteCopiesV2.quoteHash })
        .from(evidenceQuoteCopiesV2)
        .where(and(
          eq(evidenceQuoteCopiesV2.workspaceId, scope.workspaceId),
          inArray(evidenceQuoteCopiesV2.evidenceSnapshotId, snapshotIds),
        ))
    : [];
  const snapshotById = new Map(snapshotRows.map((row) => [row.evidenceSnapshotId, row]));
  const previousBlockById = new Map(previousBlocks.map((row) => [row.id, row]));
  const quoteCopyBySnapshotId = new Map(quoteCopies.map((row) => [row.evidenceSnapshotId, row]));
  const currentBlockByOrdinal = new Map<number, typeof currentBlocks>();
  for (const row of currentBlocks) {
    const values = currentBlockByOrdinal.get(row.ordinal) ?? [];
    values.push(row);
    currentBlockByOrdinal.set(row.ordinal, values);
  }

  for (const objective of objectives) {
    const objectiveId = objective.objectiveId;
    const currentRevisionId = objective.revisionId;
    if (!currentRevisionId) continue;
    const sameRevisionOrigins = currentOriginsByObjective.get(objectiveId) ?? [];
    const predecessorRevisionSet = predecessorBySuccessor.get(currentRevisionId) ?? new Set<string>();
    const explicitChangeRelation = predecessorOrigins.some((origin) => predecessorRevisionSet.has(origin.objectiveRevisionId));
    const historicalOrigins = originRows.filter((origin) => origin.objectiveId === objectiveId);
    const originsToCompare = sameRevisionOrigins;
    const evidenceInputs = requestedSnapshotIds
      .filter((snapshot) => snapshot.objectiveId === objectiveId && originsToCompare.some((origin) =>
        origin.noteVersionId === snapshot.noteVersionId && origin.evidenceSnapshotIds?.includes(snapshot.evidenceSnapshotId)))
      .sort((left, right) => {
        const leftSnapshot = snapshotById.get(left.evidenceSnapshotId);
        const rightSnapshot = snapshotById.get(right.evidenceSnapshotId);
        const leftOrdinal = leftSnapshot?.blockId ? previousBlockById.get(leftSnapshot.blockId)?.ordinal ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        const rightOrdinal = rightSnapshot?.blockId ? previousBlockById.get(rightSnapshot.blockId)?.ordinal ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        return leftOrdinal - rightOrdinal
          || (leftSnapshot?.startOffset ?? 0) - (rightSnapshot?.startOffset ?? 0)
          || left.evidenceSnapshotId.localeCompare(right.evidenceSnapshotId);
      })
      .map((requested) => {
        const snapshot = snapshotById.get(requested.evidenceSnapshotId);
        const previousBlock = snapshot?.blockId ? previousBlockById.get(snapshot.blockId) : null;
        const matchingCurrentBlocks = previousBlock
          ? currentBlockByOrdinal.get(previousBlock.ordinal) ?? []
          : [];
        const copy = quoteCopyBySnapshotId.get(requested.evidenceSnapshotId);
        return {
          previousOrdinal: snapshot && previousBlock?.versionId === requested.noteVersionId ? previousBlock.ordinal : null,
          previousBlockContentHash: snapshot?.blockContentHash ?? null,
          startOffset: snapshot?.startOffset ?? 0,
          endOffset: snapshot?.endOffset ?? 0,
          quoteHash: snapshot?.quoteHash ?? null,
          quoteCopyText: copy?.quoteText ?? null,
          quoteCopyHash: copy?.quoteHash ?? null,
          currentBlockContent: matchingCurrentBlocks.length === 1 ? matchingCurrentBlocks[0].content : null,
        };
      });

    const versionChanged = (sameRevisionOrigins.length > 0 ? sameRevisionOrigins : historicalOrigins)
      .some((origin) => origin.noteVersionId !== currentVersionId);
    const hasNoCurrentRevisionOriginButHasHistory = sameRevisionOrigins.length === 0 && historicalOrigins.length > 0;
    const impact = detectObjectiveNoteChangeImpactV1({
      noteId,
      explicitChangeRelation,
      evidence: evidenceInputs,
    });

    // Ordinary reads should not paint a green status on every note objective.
    // Show unaffected only when the saved version changed (or a cited block
    // changed in place); same-version stable anchors have nothing to report.
    const inPlaceBlockChanged = evidenceInputs.some((evidence) =>
      evidence.previousBlockContentHash !== null &&
      evidence.currentBlockContent !== null &&
      hashCanonicalV2("block", { content: evidence.currentBlockContent }) !== evidence.previousBlockContentHash,
    );
    if (
      options.includeUnchanged === true || versionChanged || explicitChangeRelation || inPlaceBlockChanged || hasNoCurrentRevisionOriginButHasHistory
    ) {
      result.set(objectiveId, objectiveNoteChangeImpactV1Schema.parse(impact));
    }
  }

  return result;
}

/**
 * Recompute the note evidence impact across an objective's current note origins.
 * Read surfaces use the unlocked, changed-only projection; schedule
 * authorization/settlement opts into a source-row lock and the unaffected
 * result so a concurrent checkpoint cannot move the current version between
 * the impact read and the schedule decision.
 */
export async function readObjectiveNoteChangeImpactV1(
  tx: ApiTransaction,
  scope: NoteImpactScope,
  objectiveId: string,
  options: { readonly lockSourceNotes?: boolean; readonly includeUnchanged?: boolean } = {},
): Promise<ObjectiveNoteChangeImpactV1 | null> {
  const origins = await tx
    .select({ noteId: learningObjectiveOriginsV2.noteId })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, scope.workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, objectiveId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
      visibleObjectivesCondition(scope.userId, learningObjectiveOriginsV2.objectiveId),
    ));
  const noteIds = [...new Set(origins.map((row) => row.noteId).filter((id): id is string => id !== null))].sort();
  if (noteIds.length === 0) return null;

  const readableNotesQuery = tx
    .select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, scope.workspaceId),
      inArray(notes.id, noteIds),
      isNull(notes.deletedAt),
      visibleNotesCondition(scope.userId),
    ))
    .orderBy(asc(notes.id));
  const readableNotes = await (options.lockSourceNotes === true
    ? readableNotesQuery.for("share")
    : readableNotesQuery);
  const readableById = new Map(readableNotes.map((row) => [row.id, row]));
  const impacts: ObjectiveNoteChangeImpactV1[] = [];
  for (const noteId of noteIds) {
    const note = readableById.get(noteId);
    if (!note?.currentVersionId) {
      impacts.push(detectObjectiveNoteChangeImpactV1({ noteId, explicitChangeRelation: false, evidence: [] }));
      continue;
    }
    const impact = (await readNoteChangeImpactsV1(tx, scope, noteId, [objectiveId], { includeUnchanged: true })).get(objectiveId);
    impacts.push(impact ?? detectObjectiveNoteChangeImpactV1({ noteId, explicitChangeRelation: false, evidence: [] }));
  }

  const impact = impacts.find((candidate) => candidate.status === "affected")
    ?? impacts.find((impact) => impact.status === "uncertain")
    ?? impacts[0]
    ?? null;
  return impact?.status === "unaffected" && options.includeUnchanged !== true ? null : impact;
}
