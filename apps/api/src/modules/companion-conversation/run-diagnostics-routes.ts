import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import {
  COMPANION_RATE_LIMITS,
  companionRateLimit,
  companionRateLimitReply,
} from "../../lib/companion-rate-limit.ts";
import { requireCompanionDialogue } from "./routes.ts";
import { companionRunListQueryV1Schema } from "@astella/shared";
import { loadCompanionRunDoctorV1 } from "./run-doctor.ts";
import { loadCompanionRunListV1 } from "./run-list.ts";
import { loadCompanionRunIssueBundleV1 } from "./run-issue-bundle.ts";
import { loadCompanionTurnReplayV1 } from "./run-turn-replay.ts";

const runParamsSchema = z.object({ id: z.string().uuid() }).strict();

export async function companionRunDiagnosticsRoutes(app: FastifyInstance) {
  app.get(
    "/companion/runs",
    {
      onRequest: [async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }],
      preHandler: [requireSession, requireCompanionDialogue],
    },
    async (request, reply) => {
      const query = companionRunListQueryV1Schema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "invalid run query",
          recoverable: false,
          requestId: request.id,
        });
      }
      const scope = scopeOfSession(request.session);
      const rateLimit = await companionRateLimit({
        key: `${scope.workspaceId}:${scope.userId}:read`,
        ...COMPANION_RATE_LIMITS.readQueriesPerMinute,
      });
      if (!rateLimit.allowed) {
        return companionRateLimitReply(reply, request.id, rateLimit.retryAfterSeconds);
      }
      const report = await withWorkspaceTransaction(scope, (tx) =>
        loadCompanionRunListV1(tx, scope, query.data),
      );
      return reply.code(200).send(report);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/companion/runs/:id/doctor",
    {
      onRequest: [async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }],
      preHandler: [requireSession, requireCompanionDialogue],
    },
    async (request, reply) => {
      const params = runParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }

      const scope = scopeOfSession(request.session);
      const rateLimit = await companionRateLimit({
        key: `${scope.workspaceId}:${scope.userId}:read`,
        ...COMPANION_RATE_LIMITS.readQueriesPerMinute,
      });
      if (!rateLimit.allowed) {
        return companionRateLimitReply(reply, request.id, rateLimit.retryAfterSeconds);
      }

      const report = await withWorkspaceTransaction(scope, (tx) =>
        loadCompanionRunDoctorV1(tx, scope, params.data.id),
      );
      if (!report) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }
      return reply.code(200).send(report);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/companion/runs/:id/turn",
    {
      onRequest: [async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }],
      preHandler: [requireSession, requireCompanionDialogue],
    },
    async (request, reply) => {
      const params = runParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }

      const scope = scopeOfSession(request.session);
      const rateLimit = await companionRateLimit({
        key: `${scope.workspaceId}:${scope.userId}:read`,
        ...COMPANION_RATE_LIMITS.readQueriesPerMinute,
      });
      if (!rateLimit.allowed) {
        return companionRateLimitReply(reply, request.id, rateLimit.retryAfterSeconds);
      }

      const report = await withWorkspaceTransaction(scope, (tx) =>
        loadCompanionTurnReplayV1(tx, scope, params.data.id),
      );
      if (!report) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }
      return reply.code(200).send(report);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/companion/runs/:id/issue-bundle",
    {
      onRequest: [async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }],
      preHandler: [requireSession, requireCompanionDialogue],
    },
    async (request, reply) => {
      const params = runParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }
      const scope = scopeOfSession(request.session);
      const rateLimit = await companionRateLimit({
        key: `${scope.workspaceId}:${scope.userId}:read`,
        ...COMPANION_RATE_LIMITS.readQueriesPerMinute,
      });
      if (!rateLimit.allowed) {
        return companionRateLimitReply(reply, request.id, rateLimit.retryAfterSeconds);
      }
      const bundle = await withWorkspaceTransaction(scope, (tx) =>
        loadCompanionRunIssueBundleV1(tx, scope, params.data.id),
      );
      if (!bundle) {
        return reply.code(404).send({
          version: 1,
          error: "NOT_FOUND",
          message: "not found",
          recoverable: false,
          requestId: request.id,
        });
      }
      return reply.code(200).send(bundle);
    },
  );
}
