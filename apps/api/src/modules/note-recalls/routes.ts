import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  noteRecallActionResultV1Schema,
  noteRecallActionV1Schema,
  noteRecallListQueryV1Schema,
  noteRecallPageV1Schema,
  noteRecallStartInputV1Schema,
  noteRecallStartResultV1Schema,
} from "@ailearn/shared/note-recall-contracts";
import { actOnNoteRecallRecord, createNoteRecallRecord, listNoteRecallRecords, NoteRecallError } from "./service.ts";

export async function noteRecallRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);
  app.get("/v2/notes/:noteId/recalls", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.strictObject({ noteId: z.string().uuid() }).safeParse(req.params);
    const query = noteRecallListQueryV1Schema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "invalid_request", message: "回想记录位置无效，请重新读取。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteRecallPageV1Schema.parse(await withWorkspaceTransaction(scope, (tx) => listNoteRecallRecords(tx, scope, params.data.noteId, query.data.before)));
    } catch (err) {
      if (err instanceof NoteRecallError) return reply.code(err.code === "note_not_found" ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post("/v2/notes/:noteId/recalls", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.strictObject({ noteId: z.string().uuid() }).safeParse(req.params);
    const body = noteRecallStartInputV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "回想这次没有开始，请重试。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteRecallStartResultV1Schema.parse(await withWorkspaceTransaction(scope, (tx) => createNoteRecallRecord(tx, scope, params.data.noteId, body.data)));
    } catch (err) {
      if (err instanceof NoteRecallError) {
        const status = err.code === "note_not_found" || err.code === "recall_not_found" || err.code === "source_message_not_found" ? 404
          : err.code === "invalid_recall_question" || err.code === "invalid_recall_hint" ? 422
          : 409;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post("/v2/notes/:noteId/recalls/:recallId/actions", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const params = z.strictObject({ noteId: z.string().uuid(), recallId: z.string().uuid() }).safeParse(req.params);
    const body = noteRecallActionV1Schema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request", message: "这一步没有记下来，请重试。" });
    const scope = scopeOfSession(req.session);
    try {
      return noteRecallActionResultV1Schema.parse(await withWorkspaceTransaction(scope, (tx) => actOnNoteRecallRecord(tx, scope, params.data.noteId, params.data.recallId, body.data)));
    } catch (err) {
      if (err instanceof NoteRecallError) {
        const status = err.code === "note_not_found" || err.code === "recall_not_found" || err.code === "source_message_not_found" ? 404
          : err.code === "invalid_recall_question" || err.code === "invalid_recall_hint" ? 422
          : 409;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
