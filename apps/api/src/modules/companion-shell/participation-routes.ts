import type { FastifyInstance } from "fastify";
import { AgentStoreError, readParticipationPreferences, writeParticipationPreferences,
  recordCompanionAwareness, enqueueParticipationObservation } from "@astella/agent-host";
import { companionParticipationPreferencesWriteV1Schema, companionAwarenessObservationV1Schema } from "@astella/shared/companion-initiative-contracts";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { withWorkspaceTransaction, scopeOfSession } from "../../db/client.ts";
import { buildSimpleErrorBody } from "../../lib/error-envelope.ts";
import { ensureCompanionAccountState } from "../../companion-contracts/companion-account-epoch.ts";
import { retireSupersededLaunchGreetings } from "../companion-conversation/delivery/delivery-service.ts";

export async function companionParticipationRoutes(app: FastifyInstance) {
  app.get("/me/companion/participation", { preHandler: [requireSession] }, async req =>
    withWorkspaceTransaction(scopeOfSession(req.session), tx => readParticipationPreferences(tx, scopeOfSession(req.session))));
  app.put("/me/companion/participation", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, companionParticipationPreferencesWriteV1Schema, req.body);
    const scope = scopeOfSession(req.session);
    try {
      return await withWorkspaceTransaction(scope, async tx => {
        const result = await writeParticipationPreferences(tx, scope, { ...body,
          source: { kind: "settings", workspaceId: scope.workspaceId, messageId: null, quote: null } });
        if (result.changed && result.preferences.enabled && result.preferences.markdown.trim()) await enqueueParticipationObservation(tx, scope, {
          dedupeKey: `participation:${scope.userId}:${result.preferences.revision}`, topic: "preference.changed",
          facts: { preferenceRevision: result.preferences.revision }, ttlMs: 10 * 60_000,
        });
        return result.preferences;
      });
    } catch (error) {
      if (error instanceof AgentStoreError) return reply.code(error.statusCode).send(buildSimpleErrorBody(error));
      throw error;
    }
  });
  app.post("/me/companion/awareness", { preHandler: [requireSession] }, async req => {
    const observation = parseBody(app, companionAwarenessObservationV1Schema, req.body);
    const scope = scopeOfSession(req.session);
    const accepted = await withWorkspaceTransaction(scope, async tx => {
      await ensureCompanionAccountState(tx, scope.userId);
      const recorded = await recordCompanionAwareness(tx, scope, observation);
      /**
       * 一次**真实启动**成立时，把上一次还没被看见的启动问候收掉（2026-10-16）。
       *
       * 问候生成在启动后十几秒；上次启动若先关了窗口，它下一次才被认领——用户看到的
       * 是「上一次启动的问候」，而这次启动自己的问候紧接着也会到（真窗口实测两条相差
       * 十几秒）。只在这一条观察真的入库（`recorded`）时收：同一次启动的重复上报
       * 不该动别人的问候。
       */
      if (recorded && observation.topic === "app.started") {
        await retireSupersededLaunchGreetings(tx, scope);
      }
      return recorded;
    });
    return { version: 1, accepted, observationId: observation.id };
  });
}
