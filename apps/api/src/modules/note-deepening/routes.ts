/**
 * Star map routes (Plan 57 hard cutover, 2026-10-19).
 *
 * GET /v3/understanding/topology — sources, notes, and card questions
 * GET /v3/understanding/notes/:noteId/deepening — that note's card, questions,
 * and attempt history.
 *
 * The old relation-decision endpoints are gone with the objective chain: two
 * notes no longer get a machine-guessed semantic edge, so there is nothing for
 * the user to confirm or dismiss.
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import {
  buildTopologySnapshotV3Cached,
  readTopologySnapshotCache,
} from "./topology-repository.ts";
import {
  NoteNotReadableV3,
  readNoteDeepeningV3,
  resolveNoteDeepeningLimit,
} from "./note-deepening-service.ts";

export async function understandingTopologyV3Routes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v3/understanding/topology", async (req, reply) => {
    const ctx = scopeOfSession(req.session);
    // 先查 TTL 缓存——命中时**完全不开启事务**，于是 304 路径零 DB 成本。
    const cached = readTopologySnapshotCache(ctx);
    const snapshot = cached ?? await withWorkspaceTransaction(ctx, (tx) =>
      buildTopologySnapshotV3Cached(tx, ctx),
    );

    const etag = '"' + snapshot.topologyRevision + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    // no-cache（而非 no-store）：每次协商，304 可达。
    reply.header("cache-control", "private, no-cache");
    return snapshot;
  });

  app.get("/v3/understanding/notes/:noteId/deepening", async (req, reply) => {
    const ctx = scopeOfSession(req.session);
    const params = req.params as { noteId?: string };
    if (!params.noteId || !/^[0-9a-f-]{36}$/i.test(params.noteId)) {
      return reply.code(400).send({ error: "noteId 不是 uuid" });
    }
    const query = req.query as { limit?: string };
    if (query.limit !== undefined && resolveNoteDeepeningLimit(query.limit) !== Number(query.limit)) {
      return reply.code(400).send({ error: `limit 越界（1..${resolveNoteDeepeningLimit(undefined)}）` });
    }
    try {
      return await withWorkspaceTransaction(ctx, (tx) =>
        readNoteDeepeningV3(tx, ctx, params.noteId!, {
          ...(query.limit ? { limit: Number(query.limit) } : {}),
        }),
      );
    } catch (error) {
      // 读不到就是读不到。**不回一份空的**：空的那一份与"这一篇真的什么都
      // 没有"在屏上长得一模一样。
      if (error instanceof NoteNotReadableV3) {
        return reply.code(404).send({ error: "note_not_readable" });
      }
      throw error;
    }
  });
}
