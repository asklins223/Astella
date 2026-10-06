import { and, eq, inArray, sql } from "drizzle-orm";
import { noteBlocks } from "@astella/shared/db-schema/note";
import { roundTeachingContentV1Schema, type RoundSuspectClaimV1 } from "@astella/shared/note-learning-round-contracts";
import type { ApiTransaction } from "../../db/client.ts";
import type { TeachingExplainBlockV1 } from "./teaching/teaching-explain.ts";
import type { RoundTargetDraft } from "./teaching/round-target-contract.ts";
import type { NoteLearningRoundV1, RoundScopeV1 } from "./round/round-service.ts";

export type SuspectClaimRecheckTargetV1 = {
  unitId: string;
  sourceBlockOrdinal: number;
  sourceQuote: string;
  reason: string;
};

export type SuspectClaimFollowUpV1 = {
  /** Only changed, exactly located claims are sent back through target generation. */
  recheckTargets: SuspectClaimRecheckTargetV1[];
  /** Old warnings remain visible until a matching target is independently accepted. */
  pendingClaims: RoundSuspectClaimV1[];
};

export type SuspectClaimEditStatusV1 = "changed" | "unchanged" | "uncertain";

/** Fail closed if rechecking would smuggle any unrelated or unlinked target unit into the freeze path. */
export function constrainTargetToSuspectRechecksV1(
  target: RoundTargetDraft | null,
  rechecks: readonly SuspectClaimRecheckTargetV1[],
): RoundTargetDraft | null {
  if (rechecks.length === 0 || target === null) return target;
  const expected = new Map(rechecks.map((claim) => [claim.unitId, claim.sourceBlockOrdinal]));
  const ids = target.units.map((unit) => unit.unitId);
  if (ids.length !== expected.size || new Set(ids).size !== ids.length
    || target.units.some((unit) => expected.get(unit.unitId) !== unit.sourceBlockOrdinal)) return null;
  return target;
}

/** Compare only the original block/offset. A moved quote is left uncertain, never re-anchored. */
export function classifySuspectClaimEditV1(input: {
  claim: RoundSuspectClaimV1;
  previousBlockText: string | null;
  currentBlockText: string | null;
  previousOtherBlockTexts?: readonly string[];
  currentOtherBlockTexts?: readonly string[];
}): SuspectClaimEditStatusV1 {
  const { claim, previousBlockText, currentBlockText } = input;
  if (claim.sourceBlockOrdinal === null || claim.sourceQuote === null
    || previousBlockText === null || currentBlockText === null) return "uncertain";
  const quote = claim.sourceQuote;
  const start = previousBlockText.indexOf(quote);
  if (start < 0 || previousBlockText.indexOf(quote, start + 1) >= 0) return "uncertain";
  if (previousBlockText === currentBlockText) return "unchanged";
  if (input.previousOtherBlockTexts?.some((text) => text === currentBlockText)
    || input.currentOtherBlockTexts?.some((text) => text.includes(quote))) return "uncertain";
  const currentSlice = currentBlockText.slice(start, start + quote.length);
  // A different edit in this same evidence block (such as adding a verified source
  // excerpt beside the claim) can change whether the unit is supportable. Recheck it.
  if (currentSlice === quote) return "changed";
  // If the old quote still exists elsewhere, its changed location cannot tell us
  // whether the claim itself changed. Keep the warning instead of fuzzy-reanchoring it.
  if (currentBlockText.includes(quote)) return "uncertain";
  return "changed";
}

function canonicalUnitIds(value: unknown): Set<string> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) return new Set();
    return new Set((parsed as { items: unknown[] }).items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const unitId = (item as { unitId?: unknown }).unitId;
      return typeof unitId === "string" ? [unitId] : [];
    }));
  } catch { return new Set(); }
}

/**
 * Carry forward the latest unresolved warning for this note. If its cited block changed
 * in the new immutable version, the next target proposal is constrained to that unit and
 * block. Unchanged or unlocatable claims remain warnings and are not retested.
 */
export async function readSuspectClaimFollowUpV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  round: NoteLearningRoundV1,
  currentBlocks: readonly TeachingExplainBlockV1[],
): Promise<SuspectClaimFollowUpV1> {
  const rows = await tx.execute(sql`
    SELECT r.note_version_id, t.content, revision.canonical_answer
    FROM public.note_learning_rounds AS r
    JOIN public.note_learning_round_teachings AS t
      ON t.workspace_id = r.workspace_id AND t.user_id = r.user_id AND t.round_id = r.id
    LEFT JOIN public.note_learning_round_targets AS target
      ON target.workspace_id = r.workspace_id AND target.user_id = r.user_id
      AND target.round_id = r.id AND target.driving_question_revision = t.driving_question_revision
    LEFT JOIN public.learning_objective_revisions_v2 AS revision
      ON revision.workspace_id = target.workspace_id AND revision.objective_revision_id = target.objective_revision_id
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId} AND r.note_id = ${round.noteId}
      AND r.source_content_hash <> ${round.sourceContentHash}
    ORDER BY t.created_at DESC, t.ordinal DESC
    LIMIT 200`);

  const selectedByUnitId = new Map<string, { noteVersionId: string; claim: RoundSuspectClaimV1 }>();
  const decidedUnitIds = new Set<string>();
  for (const row of rows) {
    const noteVersionId = String(row.note_version_id ?? "");
    const parsed = roundTeachingContentV1Schema.safeParse(row.content);
    for (const claim of parsed.success ? parsed.data.suspectClaims ?? [] : []) {
      const freshIds = claim.unitIds.filter((unitId) => !decidedUnitIds.has(unitId));
      for (const unitId of freshIds) {
        decidedUnitIds.add(unitId);
        selectedByUnitId.set(unitId, { noteVersionId, claim: { ...claim, unitIds: [unitId] } });
      }
    }
    for (const unitId of canonicalUnitIds(row.canonical_answer)) decidedUnitIds.add(unitId);
  }

  if (selectedByUnitId.size === 0) return { recheckTargets: [], pendingClaims: [] };
  const versionIds = [...new Set([...selectedByUnitId.values()].map((item) => item.noteVersionId))];
  const previousBlocks = await tx.select({ versionId: noteBlocks.versionId, ordinal: noteBlocks.ordinal, text: noteBlocks.content })
    .from(noteBlocks)
    .where(and(eq(noteBlocks.workspaceId, scope.workspaceId), inArray(noteBlocks.versionId, versionIds)));
  const previousTextByKey = new Map(previousBlocks.map((block) => [`${block.versionId}:${block.ordinal}`, block.text]));
  const previousBlocksByVersion = new Map<string, typeof previousBlocks>();
  for (const block of previousBlocks) {
    const prior = previousBlocksByVersion.get(block.versionId) ?? [];
    previousBlocksByVersion.set(block.versionId, [...prior, block]);
  }
  const currentTextByOrdinal = new Map(currentBlocks.map((block) => [block.ordinal, block.text]));
  const recheckTargets: SuspectClaimRecheckTargetV1[] = [];
  const pendingByKey = new Map<string, RoundSuspectClaimV1>();

  for (const [unitId, previous] of selectedByUnitId) {
    const claim = previous.claim;
    const previousVersionBlocks = previousBlocksByVersion.get(previous.noteVersionId) ?? [];
    const currentOrdinal = claim.sourceBlockOrdinal;
    const status = classifySuspectClaimEditV1({
      claim,
      previousBlockText: currentOrdinal === null
        ? null : previousTextByKey.get(`${previous.noteVersionId}:${currentOrdinal}`) ?? null,
      currentBlockText: currentOrdinal === null ? null : currentTextByOrdinal.get(currentOrdinal) ?? null,
      previousOtherBlockTexts: currentOrdinal === null ? [] : previousVersionBlocks
        .filter((block) => block.ordinal !== currentOrdinal).map((block) => block.text),
      currentOtherBlockTexts: currentOrdinal === null ? [] : currentBlocks
        .filter((block) => block.ordinal !== currentOrdinal).map((block) => block.text),
    });
    if (status === "changed" && claim.sourceBlockOrdinal !== null && claim.sourceQuote !== null) {
      recheckTargets.push({ unitId, sourceBlockOrdinal: claim.sourceBlockOrdinal, sourceQuote: claim.sourceQuote, reason: claim.reason });
    }
    const pending = status === "changed" ? { ...claim, sourceChanged: true } : claim;
    const key = `${pending.sourceBlockOrdinal ?? "?"}:${pending.sourceQuote ?? "?"}:${pending.reason}:${pending.sourceChanged ? "changed" : "same"}`;
    const prior = pendingByKey.get(key);
    pendingByKey.set(key, { ...pending, unitIds: [...new Set([...(prior?.unitIds ?? []), unitId])] });
  }

  return { recheckTargets: recheckTargets.slice(0, 6), pendingClaims: [...pendingByKey.values()].slice(0, 6) };
}
