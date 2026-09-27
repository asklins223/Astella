import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes } from "@ailearn/shared/db-schema/note";
import { noteLearningRounds, noteLearningRoundTeachings } from "@ailearn/shared/db-schema/note-learning-rounds";
import { noteLearningReflections as reflections } from "@ailearn/shared/db-schema/note-learning-reflections";
import { learningArtifacts, learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import { artifactPayloadSchema } from "@ailearn/shared/learning-run-contracts";
import { roundTeachingContentV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import { noteReflectionV1Schema, type ReflectionSourceV1 } from "@ailearn/shared/note-learning-reflection-contracts";
import { visibleNotesCondition } from "../note/visibility.ts";
import { RoundServiceError, type RoundScopeV1 } from "./round-service.ts";

/** Serialize with note deletion / share withdrawal until the transaction completes. */
async function requireVisibleNote(tx: ApiTransaction, scope: RoundScopeV1, noteId: string) {
  const [note] = await tx.select({ id: notes.id }).from(notes).where(and(
    eq(notes.id, noteId), eq(notes.workspaceId, scope.workspaceId),
    visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
  )).for("share");
  if (!note) throw new RoundServiceError("note_not_found", "这篇笔记现在读不到，请回到笔记架核对权限。");
}

type SourceFilter = { roundId?: string; teachingIds?: string[]; answerIds?: string[] };
async function readSources(tx: ApiTransaction, scope: RoundScopeV1, noteId: string, filter: SourceFilter): Promise<ReflectionSourceV1[]> {
  const roundWhere = and(eq(noteLearningRounds.workspaceId, scope.workspaceId), eq(noteLearningRounds.userId, scope.userId),
    eq(noteLearningRounds.noteId, noteId), filter.roundId ? eq(noteLearningRounds.id, filter.roundId) : undefined);
  const teachings = filter.teachingIds?.length === 0 ? [] : await tx.select({
    id: noteLearningRoundTeachings.id, roundId: noteLearningRounds.id, content: noteLearningRoundTeachings.content,
    createdAt: noteLearningRoundTeachings.createdAt, question: noteLearningRounds.drivingQuestion,
    questionRevision: noteLearningRounds.drivingQuestionRevision, teachingRevision: noteLearningRoundTeachings.drivingQuestionRevision,
  }).from(noteLearningRoundTeachings).innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundTeachings.roundId))
    .where(and(roundWhere, eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId), eq(noteLearningRoundTeachings.userId, scope.userId),
      filter.teachingIds ? inArray(noteLearningRoundTeachings.id, filter.teachingIds) : undefined))
    .orderBy(desc(noteLearningRoundTeachings.createdAt)).limit(50);
  const answers = filter.answerIds?.length === 0 ? [] : await tx.select({
    id: learningArtifacts.id, roundId: noteLearningRounds.id, payload: learningArtifacts.payload, createdAt: learningArtifacts.createdAt,
  }).from(learningArtifacts).innerJoin(learningRuns, eq(learningRuns.id, learningArtifacts.runId))
    .innerJoin(noteLearningRounds, sql`${learningRuns.origin}->>'roundId' = ${noteLearningRounds.id}::text`)
    .where(and(roundWhere, eq(learningRuns.workspaceId, scope.workspaceId), eq(learningRuns.userId, scope.userId),
      eq(learningArtifacts.workspaceId, scope.workspaceId), eq(learningArtifacts.userId, scope.userId), eq(learningArtifacts.status, "locked"),
      sql`${learningRuns.origin}->>'kind' = 'note_round'`, filter.answerIds ? inArray(learningArtifacts.id, filter.answerIds) : undefined))
    .orderBy(desc(learningArtifacts.createdAt)).limit(50);
  return [
    ...teachings.flatMap((row): ReflectionSourceV1[] => {
      const content = roundTeachingContentV1Schema.safeParse(row.content);
      return content.success ? [{ ref: { kind: "teaching", id: row.id }, roundId: row.roundId,
        question: row.questionRevision === row.teachingRevision ? row.question : `本轮第 ${row.teachingRevision} 版问题的讲解`,
        text: [content.data.explanation, content.data.example].filter(Boolean).join("\n\n"), createdAt: row.createdAt.toISOString() }] : [];
    }),
    ...answers.flatMap((row): ReflectionSourceV1[] => {
      const payload = artifactPayloadSchema.safeParse(row.payload);
      if (!payload.success) return [];
      const text = payload.data.kind === "text" ? payload.data.text : payload.data.kind === "voice" ? payload.data.confirmedTranscript : null;
      return text?.trim() ? [{ ref: { kind: "answer", id: row.id }, roundId: row.roundId, question: "本轮练习的作答",
        text, createdAt: row.createdAt.toISOString() }] : [];
    }),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const owned = (scope: RoundScopeV1, noteId: string) => and(eq(reflections.workspaceId, scope.workspaceId), eq(reflections.userId, scope.userId), eq(reflections.noteId, noteId));
const key = (source: ReflectionSourceV1) => `${source.ref.kind}:${source.ref.id}`;
type ReflectionRow = typeof reflections.$inferSelect;
function project(row: ReflectionRow, source: ReflectionSourceV1) {
  return noteReflectionV1Schema.parse({ reflectionId: row.id, noteId: row.noteId, source,
    annotation: row.annotation, revision: row.revision, createdAt: row.createdAt.toISOString() });
}
async function sourceFor(tx: ApiTransaction, scope: RoundScopeV1, noteId: string, ref: ReflectionSourceV1["ref"]) {
  const [source] = await readSources(tx, scope, noteId, { teachingIds: ref.kind === "teaching" ? [ref.id] : [], answerIds: ref.kind === "answer" ? [ref.id] : [] });
  if (!source) throw new RoundServiceError("reflection_source_not_found", "这条学习记录现在不能收藏，请重新读取这一轮。");
  return source;
}
export async function listNoteReflections(tx: ApiTransaction, scope: RoundScopeV1, noteId: string, query: { roundId?: string; before?: string; reflectionId?: string }) {
  await requireVisibleNote(tx, scope, noteId);
  if (query.roundId) {
    const [round] = await tx.select({ id: noteLearningRounds.id }).from(noteLearningRounds).where(and(
      eq(noteLearningRounds.id, query.roundId), eq(noteLearningRounds.workspaceId, scope.workspaceId), eq(noteLearningRounds.userId, scope.userId), eq(noteLearningRounds.noteId, noteId)));
    if (!round) throw new RoundServiceError("round_not_found", "这一轮现在读不到。");
  }
  const [cursor] = query.before ? await tx.select().from(reflections).where(and(owned(scope, noteId), eq(reflections.id, query.before))) : [];
  if (query.before && !cursor) throw new RoundServiceError("invalid_cursor", "收藏位置已变化，请从最近的记录重新读取。");
  const rows = await tx.select().from(reflections).where(and(owned(scope, noteId), query.reflectionId ? eq(reflections.id, query.reflectionId) : undefined, cursor
    ? sql`(${reflections.createdAt},${reflections.id}) < (${cursor.createdAt.toISOString()}::timestamptz,${cursor.id}::uuid)` : undefined))
    .orderBy(desc(reflections.createdAt), desc(reflections.id)).limit(21);
  const page = rows.slice(0, 20);
  const linked = await readSources(tx, scope, noteId, { teachingIds: page.flatMap(r => r.teachingId ? [r.teachingId] : []), answerIds: page.flatMap(r => r.answerArtifactId ? [r.answerArtifactId] : []) });
  const byRef = new Map(linked.map(s => [key(s), s]));
  return { version: 1 as const, items: page.flatMap(row => {
    const source = byRef.get(row.teachingId ? `teaching:${row.teachingId}` : `answer:${row.answerArtifactId}`);
    return source ? [project(row, source)] : [];
  }), sources: query.roundId ? (await readSources(tx, scope, noteId, { roundId: query.roundId })).slice(0, 50) : [],
  nextCursor: rows.length > 20 ? page.at(-1)!.id : null };
}
export async function createNoteReflection(tx: ApiTransaction, scope: RoundScopeV1, noteId: string, input: { source: ReflectionSourceV1["ref"]; annotation: string }) {
  await requireVisibleNote(tx, scope, noteId);
  const source = await sourceFor(tx, scope, noteId, input.source);
  const sourceWhere = input.source.kind === "teaching" ? eq(reflections.teachingId, input.source.id) : eq(reflections.answerArtifactId, input.source.id);
  const [inserted] = await tx.insert(reflections).values({ ...scope, noteId, roundId: source.roundId,
    teachingId: input.source.kind === "teaching" ? input.source.id : null,
    answerArtifactId: input.source.kind === "answer" ? input.source.id : null, annotation: input.annotation,
  }).onConflictDoNothing().returning();
  const [existing] = inserted ? [] : await tx.select().from(reflections).where(and(owned(scope, noteId), sourceWhere));
  // A replay never overwrites a later personal annotation.
  return project(inserted ?? existing!, source);
}
export async function changeNoteReflection(tx: ApiTransaction, scope: RoundScopeV1, noteId: string, reflectionId: string, input: { expectedRevision: number; annotation?: string }) {
  await requireVisibleNote(tx, scope, noteId);
  const [row] = await tx.select().from(reflections).where(and(owned(scope, noteId), eq(reflections.id, reflectionId))).for("update");
  if (!row) throw new RoundServiceError("reflection_not_found", "这条收藏已取消，请重新读取。");
  if (row.revision !== input.expectedRevision) throw new RoundServiceError("reflection_stale_revision", "另一处已修改这条批注。你的文字还在，请重新读取后核对。");
  if (input.annotation === undefined) {
    await tx.delete(reflections).where(eq(reflections.id, reflectionId));
    return { removed: true as const };
  }
  const source = await sourceFor(tx, scope, noteId, { kind: row.teachingId ? "teaching" : "answer", id: (row.teachingId ?? row.answerArtifactId)! });
  const [updated] = await tx.update(reflections).set({ annotation: input.annotation, revision: row.revision + 1, updatedAt: new Date() })
    .where(and(eq(reflections.id, reflectionId), eq(reflections.revision, input.expectedRevision))).returning();
  return project(updated!, source);
}
