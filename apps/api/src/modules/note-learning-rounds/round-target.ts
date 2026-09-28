import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  evidenceSnapshotsV2, evidenceQuoteCopiesV2, evidenceEligibilityStatesV2,
  learningObjectivesV2, learningObjectiveRevisionsV2, learningObjectiveEvidenceBindingsV2,
  semanticSupportReportsV2, learningExposuresV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  computeSemanticTargetFingerprintV2, computeCanonicalAnswerHashV2, computeLearningSupportHashV2,
  computeRubricHashV2, computeRelationsHashV2, computePracticeItemHashV2, computeEvidenceBindingHashV2,
  computeEvidenceBindingSetHashV2, computeSemanticSupportReportSetHashV2, computeTargetRevisionHashV2,
  computePrivatePayloadHashV2, computeEvidenceSnapshotHashV2, computeEvidenceEligibilityVectorHashV2,
  computeExposureScopeIdV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { objectiveRubricV2Schema, type CanonicalAnswerV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { createObjectiveOrigin } from "../learning-objectives/origin-service.ts";
import { visibleObjectivesCondition } from "../note/visibility.ts";
import { roundTargetDraftSchema, type RoundTargetDraft } from "./round-target-contract.ts";
import type { RoundTargetGroundingReport } from "./target-grounding.ts";
import type { TeachingEvidenceInputV1 } from "./teaching-explain.ts";
import { RoundServiceError, type RoundScopeV1, type NoteLearningRoundV1 } from "./round-service.ts";

export async function readRoundTargetId(tx: ApiTransaction, scope: RoundScopeV1, round: NoteLearningRoundV1): Promise<string | null> {
  const rows = await tx.execute(sql`SELECT objective_id FROM note_learning_round_targets
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND round_id = ${round.roundId}
      AND driving_question_revision = ${round.drivingQuestionRevision}`);
  return rows[0] ? String(rows[0].objective_id) : null;
}

/** Only independently checked, exactly quoted units can enter the ordinary target freeze chain. */
export async function persistRoundTarget(tx: ApiTransaction, scope: RoundScopeV1, round: NoteLearningRoundV1,
  input: TeachingEvidenceInputV1, proposal: RoundTargetDraft, report: RoundTargetGroundingReport,
  applicationScenario: string | null = null): Promise<string> {
  const draft = roundTargetDraftSchema.parse(proposal);
  if (!report.teachingSupported || !report.objectiveSupported || report.publicQuestionSafe !== true
    || report.units.length !== draft.units.length
    || new Set(report.units.map((unit) => unit.unitId)).size !== draft.units.length
    || report.suspectClaims.some((claim) => claim.unitIds.some((unitId) => draft.units.some((unit) => unit.unitId === unitId)))
    || draft.units.some((unit) => !report.units.some((check) => check.unitId === unit.unitId && check.factSupported && check.criterionSupported))) {
    throw new RoundServiceError("invalid_teaching_content", "练习目标还没有通过依据核查");
  }
  // Generation happens outside a transaction. Two preparations (or a teaching
  // and a preparation) can therefore race to bind this same question. Serialize
  // the binding before reading it, even if their proposed target identities differ.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`${scope.workspaceId}:${round.roundId}:${round.drivingQuestionRevision}:target`}, 0))`);
  const existingBinding = await readRoundTargetId(tx, scope, round);
  if (existingBinding) return existingBinding;
  const sources = draft.units.map((unit) => {
    const block = input.blocks.find((candidate) => candidate.ordinal === unit.sourceBlockOrdinal);
    if (!block || !block.text.includes(unit.quote)) throw new RoundServiceError("invalid_teaching_content", "练习目标引文不在本轮正文里");
    return { block, start: block.text.indexOf(unit.quote), quote: unit.quote };
  });
  const identity = `note-round:${hashCanonicalV2("note-round-target-identity-v1", {
    noteId: round.noteId, sourceContentHash: round.sourceContentHash, knowledgeForm: draft.knowledgeForm,
    units: draft.units.map(({ fact, criterion, facet, sourceBlockOrdinal, quote }) => ({ fact, criterion, facet, sourceBlockOrdinal, quote })),
  })}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + identity}, 0))`);
  const existing = (await tx.select().from(learningObjectivesV2).where(and(
    eq(learningObjectivesV2.workspaceId, scope.workspaceId), eq(learningObjectivesV2.semanticIdentityClassId, identity),
    eq(learningObjectivesV2.lifecycle, "active"),
    visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
  )).limit(1))[0];
  let objectiveId: string;
  let objectiveRevisionId: string;
  if (existing?.currentObjectiveRevisionId) {
    objectiveId = existing.objectiveId; objectiveRevisionId = existing.currentObjectiveRevisionId;
  } else {
    objectiveId = randomUUID(); objectiveRevisionId = randomUUID();
    const fingerprint = computeSemanticTargetFingerprintV2({ workspaceId: scope.workspaceId, objectiveId,
      semanticIdentityClassId: identity, semanticIdentityPolicyVersion: "note-round-exact-v1" });
    const canonicalAnswer: CanonicalAnswerV2 = { kind: "bullets", items: draft.units.map((unit) => ({ unitId: unit.unitId, text: unit.fact })) };
    const support = { explanation: draft.units.map((unit) => unit.fact).join("\n") };
    const evidenceIds = sources.map(() => randomUUID());
    const bindings = [];
    const reportHashes: string[] = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index]; const unit = draft.units[index]; const evidenceSnapshotId = evidenceIds[index];
      const quoteHash = hashCanonicalV2("evidence-quote", { quote: source.quote });
      const blockContentHash = hashCanonicalV2("block", { content: source.block.text });
      // The round is the real source snapshot identity, not an invented generation run/card candidate.
      const evidenceSnapshotHash = computeEvidenceSnapshotHashV2({ kind: "text", workspaceId: scope.workspaceId,
        sourceSnapshotId: round.roundId, noteId: round.noteId, blockId: source.block.blockId ?? null,
        startOffset: source.start, endOffset: source.start + source.quote.length, protectedContentHash: quoteHash,
        sourceContentHash: round.sourceContentHash, blockContentHash, modality: "text" });
      await tx.insert(evidenceSnapshotsV2).values({ workspaceId: scope.workspaceId, evidenceSnapshotId, evidenceSnapshotHash,
        sourceSnapshotId: round.roundId, noteId: round.noteId, blockId: source.block.blockId ?? null,
        startOffset: source.start, endOffset: source.start + source.quote.length,
        protectedQuoteRef: `evidence://snapshot/${evidenceSnapshotId}`, quoteHash, blockContentHash,
        sourceContentHash: round.sourceContentHash, modality: "text" });
      await tx.insert(evidenceQuoteCopiesV2).values({ workspaceId: scope.workspaceId, evidenceSnapshotId, quoteText: source.quote, quoteHash });
      await tx.insert(evidenceEligibilityStatesV2).values({ workspaceId: scope.workspaceId, eligibilityId: randomUUID(), evidenceSnapshotId,
        status: "usable", eligibilityEpoch: 1, eligibilityVectorHash: computeEvidenceEligibilityVectorHashV2([
          { evidenceSnapshotId, eligibilityEpoch: 1, status: "usable", stateHash: evidenceSnapshotHash },
        ]) });
      const reportId = randomUUID();
      const unitReport = { version: 1, roundId: round.roundId, unit: report.units.find((check) => check.unitId === unit.unitId), objectiveSupported: true,
        teachingSupported: report.teachingSupported, teachingReason: report.teachingReason, teachingSegments: report.teachingSegments };
      const reportHash = hashCanonicalV2("note-round-target-support-v1", unitReport); reportHashes.push(reportHash);
      for (const targetUnit of [{ kind: "answer", answerUnitId: unit.unitId }, { kind: "rubric", rubricUnitId: unit.unitId }]) {
        const bindingId = randomUUID();
        const bindingHash = computeEvidenceBindingHashV2({ objectiveRevisionId, targetUnit, evidenceSnapshotId, evidenceSnapshotHash,
          relation: "entails", supportStrength: "direct", semanticSupportReportId: reportId, semanticSupportReportHash: reportHash });
        bindings.push({ bindingId, targetUnit, evidenceSnapshotId, relation: "entails", supportStrength: "direct",
          semanticSupportReportId: reportId, semanticSupportReportHash: reportHash, bindingHash });
      }
    }
    const rubricBase = { version: 2 as const, units: draft.units.map((unit, index) => ({ rubricUnitId: unit.unitId,
      facet: unit.facet, criterion: unit.criterion, required: true, answerUnitIds: [unit.unitId], evidenceRefIds: [evidenceIds[index]] })),
      passingPolicy: { requireAllRequiredUnits: true as const, allowContradiction: false as const } };
    const rubricHash = computeRubricHashV2(rubricBase);
    const rubric = objectiveRubricV2Schema.parse({ ...rubricBase, rubricHash });
    const canonicalAnswerHash = computeCanonicalAnswerHashV2(canonicalAnswer); const learningSupportHash = computeLearningSupportHashV2(support);
    const targetRevisionHash = computeTargetRevisionHashV2({ semanticTargetFingerprint: fingerprint, objectiveRevision: 1,
      objectiveStatement: draft.objectiveStatement, publicSummary: draft.publicSummary, conceptLabel: draft.conceptLabel, knowledgeForm: draft.knowledgeForm,
      canonicalAnswerHash, learningSupportHash, rubricHash, relationsHash: computeRelationsHashV2([]), practiceItemHash: computePracticeItemHashV2(null),
      evidenceBindingSetHash: computeEvidenceBindingSetHashV2(bindings.map((binding) => ({ bindingId: binding.bindingId, evidenceBindingHash: binding.bindingHash }))),
      semanticSupportReportSetHash: computeSemanticSupportReportSetHashV2(reportHashes) });
    await tx.insert(learningObjectivesV2).values({ workspaceId: scope.workspaceId, objectiveId,
      semanticIdentityClassId: identity, semanticIdentityPolicyVersion: "note-round-exact-v1", semanticTargetFingerprint: fingerprint,
      lifecycle: "active", lifecycleEpoch: 1, currentObjectiveRevisionId: objectiveRevisionId, currentRevision: 1 });
    await tx.insert(learningObjectiveRevisionsV2).values({ workspaceId: scope.workspaceId, objectiveRevisionId, objectiveId, revision: 1,
      objectiveStatement: draft.objectiveStatement, publicSummary: draft.publicSummary, conceptLabel: draft.conceptLabel,
      knowledgeForm: draft.knowledgeForm, preferredIntents: [...new Set(draft.units.map((unit) => unit.facet))], canonicalAnswer,
      learningSupport: support, scoringRubric: rubric, evidenceBindings: bindings, relations: [], semanticTargetFingerprint: fingerprint,
      targetRevisionHash, privatePayloadHash: computePrivatePayloadHashV2({ canonicalAnswerHash, learningSupportHash, rubricHash }) });
    for (let index = 0; index < sources.length; index++) {
      const binding = bindings[index * 2]; const unit = draft.units[index];
      const unitReport = { version: 1, roundId: round.roundId, unit: report.units.find((check) => check.unitId === unit.unitId), objectiveSupported: true,
        teachingSupported: report.teachingSupported, teachingReason: report.teachingReason, teachingSegments: report.teachingSegments };
      await tx.insert(semanticSupportReportsV2).values({ workspaceId: scope.workspaceId, reportId: binding.semanticSupportReportId,
        objectiveRevisionId, candidateRevisionId: null, evidenceSnapshotId: evidenceIds[index], report: unitReport, verdict: "supported",
        reportHash: binding.semanticSupportReportHash, version: 2 });
    }
    for (const binding of bindings) await tx.insert(learningObjectiveEvidenceBindingsV2).values({ workspaceId: scope.workspaceId,
      ...binding, objectiveRevisionId, targetUnitKind: binding.targetUnit.kind, targetUnitId:
        binding.targetUnit.kind === "answer" ? binding.targetUnit.answerUnitId : binding.targetUnit.rubricUnitId });
    await createObjectiveOrigin(tx, scope.workspaceId, { originId: randomUUID(), objectiveId, objectiveRevisionId, kind: "note",
      noteId: round.noteId, noteVersionId: round.noteVersionId, evidenceSnapshotIds: evidenceIds, integrity: "verified",
      provenance: { kind: "note_round", roundId: round.roundId, drivingQuestionRevision: round.drivingQuestionRevision } });
  }
  await tx.execute(sql`INSERT INTO note_learning_round_targets
    (workspace_id,user_id,round_id,driving_question_revision,objective_id,objective_revision_id,application_scenario)
    VALUES (${scope.workspaceId},${scope.userId},${round.roundId},${round.drivingQuestionRevision},${objectiveId},${objectiveRevisionId},${applicationScenario})`);
  return objectiveId;
}

/** A prepared private target is not an answer reveal. Only a committed teaching does this. */
export async function recordRoundTeachingExposure(tx: ApiTransaction, scope: RoundScopeV1,
  round: NoteLearningRoundV1, objectiveId: string): Promise<void> {
  const objective = (await tx.select({ currentRevision: learningObjectivesV2.currentRevision })
    .from(learningObjectivesV2).where(and(
      eq(learningObjectivesV2.workspaceId, scope.workspaceId),
      eq(learningObjectivesV2.objectiveId, objectiveId),
      visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
    )).limit(1))[0];
  if (!objective) throw new RoundServiceError("invalid_teaching_content", "这一轮的练习目标现在不可见");
  await tx.insert(learningExposuresV2).values({ workspaceId: scope.workspaceId, userId: scope.userId,
    exposureId: randomUUID(), objectiveId, objectiveRevision: objective.currentRevision,
    cardId: null, cardRevision: null, exposureKind: "answer_reveal",
    contextHash: computeExposureScopeIdV2({ workspaceId: scope.workspaceId, objectiveId }),
    idempotencyKey: `round-teaching:${round.roundId}:${round.drivingQuestionRevision}`,
  }).onConflictDoNothing();
}
