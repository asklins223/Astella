import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  createNoteAnnotationV1Schema,
  deleteNoteAnnotationV1Schema,
  noteAnnotationListQueryV1Schema,
  noteAnnotationPageV1Schema,
  updateNoteAnnotationV1Schema,
  noteAnnotationWriteResultV1Schema,
  createNoteAnnotationTaskV1Schema,
  noteAnnotationTaskV1Schema,
  noteAnnotationLatestTaskQueryV1Schema,
  noteAnnotationLatestTaskV1Schema,
} from "@ailearn/shared/note-annotation-contracts";
import { changeNoteAnnotation, createNoteAnnotation, listNoteAnnotations, NoteAnnotationError, startNoteAnnotationTask, getLatestNoteAnnotationTask, getNoteAnnotationTask } from "./service.ts";

export async function noteAnnotationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);
  app.post("/v2/notes/:noteId/annotation-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const body = createNoteAnnotationTaskV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "请从笔记正文重新选中要讲解的原句。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteAnnotationTaskV1Schema.parse(await startNoteAnnotationTask(scope, params.data.noteId, body.data));
    } catch (err) {
      if (err instanceof NoteAnnotationError) return reply.code(err.code === "note_not_found" || err.code === "note_version_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
  app.get("/v2/notes/:noteId/annotation-tasks/latest", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteAnnotationLatestTaskQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "批注记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteAnnotationLatestTaskV1Schema.parse(await withWorkspaceTransaction(scope, (tx) => getLatestNoteAnnotationTask(tx, scope, params.data.noteId, query.data.noteVersionId)));
    } catch (err) {
      if (err instanceof NoteAnnotationError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
  app.get("/v2/notes/:noteId/annotation-tasks/:taskId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid(), taskId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "批注任务位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteAnnotationTaskV1Schema.parse(await withWorkspaceTransaction(scope, (tx) => getNoteAnnotationTask(tx, scope, params.data.noteId, params.data.taskId)));
    } catch (err) {
      if (err instanceof NoteAnnotationError) return reply.code(err.code === "note_not_found" || err.code === "task_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
  const paramsSchema = z.object({ noteId: z.string().uuid(), annotationId: z.string().uuid().optional() });
  const base = "/v2/notes/:noteId/annotations";
  const status: Record<string, number> = {
    note_not_found: 404,
    note_version_not_found: 404,
    note_anchor_mismatch: 409,
    source_message_not_found: 409,
    annotation_not_found: 404,
    stale_revision: 409,
    save_unconfirmed: 503,
  };
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) app.route({
    method,
    url: method === "PATCH" || method === "DELETE" ? `${base}/:annotationId` : base,
    handler: async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const params = paramsSchema.safeParse(req.params);
      const parsed = method === "GET" ? noteAnnotationListQueryV1Schema.safeParse(req.query)
        : method === "POST" ? createNoteAnnotationV1Schema.safeParse(req.body)
          : method === "PATCH" ? updateNoteAnnotationV1Schema.safeParse(req.body)
            : deleteNoteAnnotationV1Schema.safeParse(req.body);
      if (!params.success || !parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: "批注信息不完整，请重新选择原文。" });
      }
      const scope = scopeOfSession(req.session);
      try {
        const result = await withWorkspaceTransaction(scope, async (tx) => {
          if (method === "GET") return listNoteAnnotations(tx, scope, params.data.noteId, noteAnnotationListQueryV1Schema.parse(parsed.data));
          if (method === "POST") return createNoteAnnotation(tx, scope, params.data.noteId, createNoteAnnotationV1Schema.parse(parsed.data));
          return changeNoteAnnotation(tx, scope, params.data.noteId, params.data.annotationId!, method === "PATCH"
            ? updateNoteAnnotationV1Schema.parse(parsed.data) : deleteNoteAnnotationV1Schema.parse(parsed.data));
        });
        if (method === "GET") return noteAnnotationPageV1Schema.parse(result);
        return noteAnnotationWriteResultV1Schema.parse(result);
      } catch (err) {
        if (err instanceof NoteAnnotationError) return reply.code(status[err.code] ?? 500).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  });
}
