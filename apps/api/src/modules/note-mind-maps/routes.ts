import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  createNoteMindMapTaskV1Schema,
  noteMindMapLatestTaskQueryV1Schema,
  noteMindMapLatestTaskV1Schema,
  noteMindMapListQueryV1Schema,
  noteMindMapPageV1Schema,
  noteMindMapTaskV1Schema,
  noteMindMapSourceV1Schema,
} from "@astella/shared/note-mind-map-contracts";
import {
  getLatestNoteMindMapTask,
  getNoteMindMapSource,
  getNoteMindMapTask,
  listNoteMindMaps,
  NoteMindMapError,
  startNoteMindMapTask,
} from "./service.ts";

export async function noteMindMapRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/notes/:noteId/mind-maps", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteMindMapListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "脑图记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const page = await withWorkspaceTransaction(scope, (tx) => listNoteMindMaps(tx, scope, params.data.noteId, query.data.before));
      return noteMindMapPageV1Schema.parse(page);
    } catch (err) {
      if (err instanceof NoteMindMapError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v2/notes/:noteId/mind-maps/:mindMapId/source", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid(), mindMapId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const scope = scopeOfSession(req.session);
    try { return noteMindMapSourceV1Schema.parse(await withWorkspaceTransaction(scope, tx => getNoteMindMapSource(tx, scope, params.data.noteId, params.data.mindMapId))); }
    catch (err) { if (err instanceof NoteMindMapError) return reply.code(404).send({ error: err.code, message: err.message }); throw err; }
  });

  app.post("/v2/notes/:noteId/mind-map-tasks", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const body = createNoteMindMapTaskV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这次脑图请求不完整，请从笔记正文重新开始。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await startNoteMindMapTask(scope, params.data.noteId, body.data);
      return noteMindMapTaskV1Schema.parse(task);
    } catch (err) {
      if (err instanceof NoteMindMapError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v2/notes/:noteId/mind-map-tasks/latest", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteMindMapLatestTaskQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "脑图记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const result = await withWorkspaceTransaction(scope, (tx) => getLatestNoteMindMapTask(tx, scope, params.data.noteId, query.data.noteVersionId));
      return noteMindMapLatestTaskV1Schema.parse(result);
    } catch (err) {
      if (err instanceof NoteMindMapError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get("/v2/notes/:noteId/mind-map-tasks/:taskId", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.object({ noteId: z.string().uuid(), taskId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request", message: "脑图任务位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      const task = await withWorkspaceTransaction(scope, (tx) => getNoteMindMapTask(tx, scope, params.data.noteId, params.data.taskId));
      return noteMindMapTaskV1Schema.parse(task);
    } catch (err) {
      if (err instanceof NoteMindMapError) return reply.code(err.code === "note_not_found" || err.code === "task_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}
