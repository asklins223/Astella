import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createNoteExpansionTaskV1Schema,
  noteExpansionLatestTaskQueryV1Schema,
  noteExpansionLatestTaskV1Schema,
  noteExpansionListQueryV1Schema,
  noteExpansionPageV1Schema,
  noteExpansionTaskV1Schema,
  noteExpansionTaskListQueryV1Schema,
  noteExpansionTaskPageV1Schema,
} from "@ailearn/shared/note-expansion-contracts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  confirmNoteExpansionTask,
  getLatestNoteExpansionTask,
  getNoteExpansionTask,
  listNoteExpansions,
  listNoteExpansionTasks,
  NoteExpansionError,
  startNoteExpansionTask,
  updateNoteExpansionTaskDrafts,
} from "./service.ts";

const noteParams = z.strictObject({ noteId: z.string().uuid() });
const taskParams = z.strictObject({ noteId: z.string().uuid(), taskId: z.string().uuid() });

function sendError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof NoteExpansionError)) throw error;
  const status = error.code === "note_not_found" || error.code === "task_not_found" ? 404 : 409;
  return reply.code(status).send({ error: error.code, message: error.message });
}

export async function noteExpansionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/notes/:noteId/expansions", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const query = noteExpansionListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "拓展记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const page = await withWorkspaceTransaction(scope, (tx) => listNoteExpansions(
        tx, scope, params.data.noteId,
        query.data.beforeCreatedAt && query.data.beforeExpansionId
          ? { createdAt: query.data.beforeCreatedAt, expansionId: query.data.beforeExpansionId }
          : undefined,
      ));
      return noteExpansionPageV1Schema.parse(page);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/v2/notes/:noteId/expansion-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const body = createNoteExpansionTaskV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这次拓展请求不完整，请从当前笔记重新开始。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await startNoteExpansionTask(scope, params.data.noteId, body.data);
      return noteExpansionTaskV1Schema.parse(task);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/notes/:noteId/expansion-tasks/latest", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params);
    const query = noteExpansionLatestTaskQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "拓展任务位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const result = await withWorkspaceTransaction(scope, (tx) => getLatestNoteExpansionTask(tx, scope, params.data.noteId, query.data.noteVersionId));
      return noteExpansionLatestTaskV1Schema.parse(result);
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/notes/:noteId/expansion-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = noteParams.safeParse(req.params), query = noteExpansionTaskListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "草稿批次位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteExpansionTaskPageV1Schema.parse(await withWorkspaceTransaction(scope,
        tx => listNoteExpansionTasks(tx, scope, params.data.noteId, query.data.noteVersionId, query.data.before)));
    } catch (error) { return sendError(reply, error); }
  });

  app.get("/v2/notes/:noteId/expansion-tasks/:taskId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = taskParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "拓展任务位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await withWorkspaceTransaction(scope, (tx) => getNoteExpansionTask(tx, scope, params.data.noteId, params.data.taskId));
      return noteExpansionTaskV1Schema.parse(task);
    } catch (error) { return sendError(reply, error); }
  });

  app.put("/v2/notes/:noteId/expansion-tasks/:taskId/drafts", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = taskParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "拓展草稿位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await withWorkspaceTransaction(scope, (tx) => updateNoteExpansionTaskDrafts(tx, scope, params.data.noteId, params.data.taskId, req.body));
      return noteExpansionTaskV1Schema.parse(task);
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/v2/notes/:noteId/expansion-tasks/:taskId/confirm", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = taskParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "拓展草稿位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, (tx) => confirmNoteExpansionTask(tx, scope, params.data.noteId, params.data.taskId, req.body));
    } catch (error) { return sendError(reply, error); }
  });
}
