/**
 * 产品层唯一的连续伴星历史读取、搜索与整域清理。
 * 内部 conversation 只作为传输/持久化分段，不跨过这组产品 API。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../../identity/middleware.ts";
import { requireCompanionDialogue } from "../routes.ts";
import {
  clearContinuousHistory,
  listContinuousHistory,
  searchContinuousHistory,
} from "./continuous-history-service.ts";
import { scopeOfSession } from "../../../db/client.ts";

const historySearchQuerySchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

const historyListQuerySchema = z.object({
  before: z.string().max(2_000).optional(),
  throughMessageId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export async function continuousHistoryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/history",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const query = historyListQuerySchema.safeParse(req.query ?? {});
      if (!query.success) return reply.code(400).send({ error: "bad_request", message: "history query 非法" });
      const result = await listContinuousHistory({ ...scopeOfSession(req.session),
userId: req.session.userId,
        before: query.data.before,
        throughMessageId: query.data.throughMessageId,
        limit: query.data.limit,
      });
      if (result.invalidCursor) {
        return reply.code(400).send({ error: "invalid_cursor", message: "历史游标无效或已过期" });
      }
      if (result.missingMessage) return reply.code(404).send({ error: "message_not_found", message: "这条对话记录已不存在" });
      return reply.header("Cache-Control", "no-store").send(result.value);
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/history/search",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const query = historySearchQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: "bad_request", message: "history search query 非法" });
      }
      const result = await searchContinuousHistory({ ...scopeOfSession(req.session),
userId: req.session.userId,
        query: query.data.q,
        limit: query.data.limit,
      });
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.delete(
    "/companion/history",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const result = await clearContinuousHistory(scopeOfSession(req.session));
      if (result.activeReply) {
        return reply.code(409).send({
          error: "companion_reply_active",
          message: "伴星仍在回复，请先停止当前回复再清空连续对话记录",
        });
      }
      return reply.header("Cache-Control", "no-store").send(result.value);
    },
  );
}
