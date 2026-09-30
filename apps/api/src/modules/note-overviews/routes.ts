import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  createNoteOverviewTaskV1Schema,
  noteOverviewLatestTaskQueryV1Schema,
  noteOverviewLatestTaskV1Schema,
  noteOverviewListQueryV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
} from "@ailearn/shared/note-overview-contracts";
import {
  getLatestNoteOverviewTask,
  getNoteOverviewTask,
  listNoteOverviews,
  NoteOverviewError,
  startNoteOverviewTask,
} from "./service.ts";

export async function noteOverviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/notes/:noteId/overviews", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteOverviewListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "速看记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const page = await withWorkspaceTransaction(scope, (tx) => listNoteOverviews(tx, scope, params.data.noteId, query.data.before));
      return noteOverviewPageV1Schema.parse(page);
    } catch (err) {
      if (err instanceof NoteOverviewError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post("/v2/notes/:noteId/overview-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const body = createNoteOverviewTaskV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这次速看请求不完整，请从笔记正文重新开始。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await startNoteOverviewTask(scope, params.data.noteId, body.data);
      return noteOverviewTaskV1Schema.parse(task);
    } catch (err) {
      if (err instanceof NoteOverviewError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v2/notes/:noteId/overview-tasks/latest", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteOverviewLatestTaskQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "速看记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const result = await withWorkspaceTransaction(scope, (tx) => getLatestNoteOverviewTask(tx, scope, params.data.noteId, query.data.noteVersionId));
      return noteOverviewLatestTaskV1Schema.parse(result);
    } catch (err) {
      if (err instanceof NoteOverviewError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v2/notes/:noteId/overview-tasks/:taskId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid(), taskId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "速看任务位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await withWorkspaceTransaction(scope, (tx) => getNoteOverviewTask(tx, scope, params.data.noteId, params.data.taskId));
      return noteOverviewTaskV1Schema.parse(task);
    } catch (err) {
      if (err instanceof NoteOverviewError) return reply.code(err.code === "note_not_found" || err.code === "task_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}
