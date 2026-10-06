import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { createNoteReflectionV1Schema, deleteNoteReflectionV1Schema, noteReflectionPageV1Schema, noteReflectionQueryV1Schema,
  noteReflectionV1Schema, updateNoteReflectionV1Schema } from "@astella/shared/note-learning-reflection-contracts";
import { changeNoteReflection, createNoteReflection, listNoteReflections } from "./reflection-service.ts";
import { RoundServiceError } from "./round/round-service.ts";

/** Called inside the session-authenticated note-learning-round plugin. */
export function noteReflectionRoutes(app: FastifyInstance) {
  const paramsSchema = z.object({ noteId: z.string().uuid(), reflectionId: z.string().uuid().optional() });
  const base = "/v2/notes/:noteId/learning-reflections";
  const status: Record<string, number> = { note_not_found: 404, round_not_found: 404, reflection_source_not_found: 404,
    reflection_not_found: 404, reflection_stale_revision: 409, invalid_cursor: 400 };
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) app.route({ method,
    url: method === "PATCH" || method === "DELETE" ? `${base}/:reflectionId` : base,
    handler: async (req, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const params = paramsSchema.safeParse(req.params);
      const parsed = method === "GET" ? noteReflectionQueryV1Schema.safeParse(req.query) : method === "POST"
        ? createNoteReflectionV1Schema.safeParse(req.body) : method === "PATCH"
          ? updateNoteReflectionV1Schema.safeParse(req.body) : deleteNoteReflectionV1Schema.safeParse(req.body);
      if (!params.success || !parsed.success) return reply.code(400).send({ error: "invalid_request", message: "收藏字段不完整，请重新读取。" });
      const scope = scopeOfSession(req.session);
      try {
        const result = await withWorkspaceTransaction(scope, async tx => {
          if (method === "GET") return listNoteReflections(tx, scope, params.data.noteId, noteReflectionQueryV1Schema.parse(parsed.data));
          if (method === "POST") return createNoteReflection(tx, scope, params.data.noteId, createNoteReflectionV1Schema.parse(parsed.data));
          return changeNoteReflection(tx, scope, params.data.noteId, params.data.reflectionId!, method === "PATCH"
            ? updateNoteReflectionV1Schema.parse(parsed.data) : deleteNoteReflectionV1Schema.parse(parsed.data));
        });
        return method === "GET" ? noteReflectionPageV1Schema.parse(result) : method === "DELETE" ? result : noteReflectionV1Schema.parse(result);
      } catch (err) {
        if (err instanceof RoundServiceError) return reply.code(status[err.code] ?? 500).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  });
}
