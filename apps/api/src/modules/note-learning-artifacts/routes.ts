import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createNoteDynamicArtifactTaskV1Schema,
  noteLearningArtifactListQueryV1Schema,
  noteLearningArtifactTaskListQueryV1Schema,
  noteLearningArtifactTaskV1Schema,
} from "@ailearn/shared/note-learning-artifact-contracts";
import { noteLearningArtifacts } from "@ailearn/shared/db-schema/note-learning-artifacts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  getNoteLearningArtifactTask,
  listNoteLearningArtifactTasks,
  listNoteLearningArtifacts,
  NoteLearningArtifactError,
  startNoteLearningArtifactTask,
} from "./service.ts";

const noteParams = z.object({ noteId: z.string().uuid() });
const taskParams = z.object({ noteId: z.string().uuid(), taskId: z.string().uuid() });
const artifactParams = z.object({ artifactId: z.string().uuid() });

function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof NoteLearningArtifactError)) throw error;
  const status = error.code === "note_not_found" || error.code === "task_not_found" || error.code === "artifact_not_found" ? 404 : 409;
  return reply.code(status).send({ error: error.code, message: error.message });
}

export async function noteLearningArtifactRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/notes/:noteId/learning-artifacts", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const query = noteLearningArtifactListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "互动演示记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => listNoteLearningArtifacts(tx, scope, params.data.noteId, query.data.before));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/v2/notes/:noteId/learning-artifact-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const body = createNoteDynamicArtifactTaskV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这次互动演示请求不完整，请从笔记正文重新开始。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await startNoteLearningArtifactTask(scope, params.data.noteId, body.data);
      return noteLearningArtifactTaskV1Schema.parse(task);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/notes/:noteId/learning-artifact-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const query = noteLearningArtifactTaskListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "互动演示任务记录位置无效。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => listNoteLearningArtifactTasks(tx, scope, params.data.noteId, query.data.noteVersionId));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/notes/:noteId/learning-artifact-tasks/:taskId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = taskParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "互动演示任务位置无效。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await withWorkspaceTransaction(scope, (tx) => getNoteLearningArtifactTask(tx, scope, params.data.noteId, params.data.taskId));
      return noteLearningArtifactTaskV1Schema.parse(task);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/note-learning-artifacts/:artifactId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = artifactParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "互动演示编号无效。" });
    const scope = scopeOfSession(req.session);
    const [row] = await withWorkspaceTransaction(scope, (tx) => tx.select({ html: noteLearningArtifacts.html })
      .from(noteLearningArtifacts).where(and(
        eq(noteLearningArtifacts.id, params.data.artifactId),
        eq(noteLearningArtifacts.workspaceId, scope.workspaceId),
        eq(noteLearningArtifacts.userId, scope.userId),
      )));
    if (!row) return reply.code(404).send({ error: "artifact_not_found", message: "这份互动演示现在读不到。" });
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(row.html);
  });
}
