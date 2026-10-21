import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import { and, eq } from "drizzle-orm";
import { jobs } from "@astella/shared/db-schema/job";
import { noteLearningCardOperationArtifacts, noteLearningCards } from "@astella/shared/db-schema/note-learning-cards";
import { notes } from "@astella/shared/db-schema/note";
import { visibleNotesCondition } from "../note/visibility.ts";
import { isNull } from "drizzle-orm";
import { JobResourceClass, JobType } from "@astella/shared/enums";
import { noteLearningCardGenerationOptionsV1Schema } from "@astella/shared/note-learning-card-contracts";
import {
  ensureNoteLearningCardRow,
  listNoteLearningCardAttempts,
  readNoteLearningCard,
  saveNoteLearningCardAnswer,
  startNoteLearningCardAttempt,
  queueNoteLearningCardAttempt,
  NoteLearningCardError,
} from "./service.ts";

const noteParams = z.strictObject({ noteId: z.string().uuid() });
const cardParams = z.strictObject({ cardId: z.string().uuid() });
const attemptParams = z.strictObject({ cardId: z.string().uuid(), attemptId: z.string().uuid() });
const answerBody = z.strictObject({
  questionId: z.string().uuid(),
  answer: z.unknown(),
  usedHint: z.boolean().optional(),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof NoteLearningCardError) {
    const status = err.code === "note_not_found" || err.code === "card_not_found" || err.code === "question_not_found" ? 404
      : err.code === "attempt_not_in_progress" || err.code === "card_not_ready" ? 409
        : 400;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

export async function noteLearningCardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/notes/:noteId/learning-card", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const query = z.strictObject({ cardId: z.string().uuid().optional() }).safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "学习卡位置无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => readNoteLearningCard(tx, scope, params.data.noteId, query.data.cardId));
    } catch (err) { return sendError(reply, err); }
  });

  app.post("/v2/notes/:noteId/learning-card/generate", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const body = z.strictObject({ noteVersionId: z.string().uuid(), options: noteLearningCardGenerationOptionsV1Schema.optional() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "学习卡生成参数无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, async (tx) => {
        const { cardId, created, generating } = await ensureNoteLearningCardRow(tx, scope, params.data.noteId, body.data.noteVersionId);
        if (!created) return { cardId, queued: false, reason: generating ? "generating" : "card_exists" };
        const [job] = await tx.insert(jobs).values({
          workspaceId: scope.workspaceId,
          requestedBy: scope.userId,
          type: JobType.NOTE_LEARNING_CARD_GENERATE,
          payload: { cardId, noteId: params.data.noteId, noteVersionId: body.data.noteVersionId, cardGenerationId: cardId, questionCount: body.data.options?.questionCount ?? 6 },
          resourceClass: JobResourceClass.CARD_FOREGROUND,
        }).returning({ id: jobs.id });
        return { cardId, jobId: job.id, queued: true };
      });
    } catch (err) { return sendError(reply, err); }
  });

  app.post("/v2/learning-cards/:cardId/attempts", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = cardParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "学习卡位置无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => startNoteLearningCardAttempt(tx, scope, params.data.cardId));
    } catch (err) { return sendError(reply, err); }
  });

  app.post("/v2/learning-cards/:cardId/attempts/:attemptId/answers", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = attemptParams.safeParse(req.params);
    const body = answerBody.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这道题的作答格式无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => saveNoteLearningCardAnswer(
        tx, scope, params.data.cardId, params.data.attemptId, body.data.questionId, body.data.answer, body.data.usedHint ?? false,
      ));
    } catch (err) { return sendError(reply, err); }
  });

  app.post("/v2/learning-cards/:cardId/attempts/:attemptId/complete", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = attemptParams.safeParse(req.params);
    const body = z.strictObject({ summaryOnly: z.boolean().optional() }).safeParse(req.body ?? {});
    const requestKey = z.string().trim().min(1).max(120).optional().safeParse(req.headers["idempotency-key"]);
    if (!params.success || !body.success || !requestKey.success) return reply.code(400).send({ error: "invalid_request", message: "学习卡位置或操作编号无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => queueNoteLearningCardAttempt(tx, scope, params.data.cardId, params.data.attemptId, body.data.summaryOnly, requestKey.data));
    } catch (err) { return sendError(reply, err); }
  });

  app.get("/v2/note-learning-card-operation-artifacts/:artifactId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.strictObject({ artifactId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "操作题编号无效。" });
    const scope = scopeOfSession(req.session);
    const [row] = await withWorkspaceTransaction(scope, (tx) => tx.select({ html: noteLearningCardOperationArtifacts.html })
      .from(noteLearningCardOperationArtifacts).innerJoin(noteLearningCards, eq(noteLearningCards.id, noteLearningCardOperationArtifacts.cardId))
      .innerJoin(notes, eq(notes.id, noteLearningCards.noteId)).where(and(
        eq(noteLearningCardOperationArtifacts.id, params.data.artifactId),
        eq(noteLearningCardOperationArtifacts.workspaceId, scope.workspaceId),
        visibleNotesCondition(scope.userId), isNull(notes.deletedAt),
      )));
    if (!row) return reply.code(404).send({ error: "artifact_not_found", message: "这道操作题现在读不到。" });
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(row.html);
  });

  app.get("/v2/learning-cards/:cardId/attempts", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = cardParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "学习卡位置无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return { items: await withWorkspaceTransaction(scope, (tx) => listNoteLearningCardAttempts(tx, scope, params.data.cardId)) };
    } catch (err) { return sendError(reply, err); }
  });
}
