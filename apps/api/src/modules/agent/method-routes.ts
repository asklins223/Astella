import { sql } from "drizzle-orm";
import { listCompanionSelfNotes, writeCompanionSelfNote, projectCompanionSelfNote, controlCompanionSelfNote, queryRows } from "@astella/agent-host";
import { companionSelfNoteWriteV1Schema, companionSelfNoteControlV1Schema } from "@astella/shared";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  proposeAgentMethodV1Schema, reviseAgentMethodV1Schema, controlAgentMethodV1Schema, agentMethodFeedbackV1Schema,
} from "@astella/shared/agent-growth-contracts";
import { requireSession } from "../identity/middleware.ts";
import { agentRequestScope, respondToAgentRequest } from "./routes.ts";
import { agentMethodStore } from "./service.ts";

const methodParams = z.object({ methodId: z.string().uuid() });
const useParams = z.object({ useId: z.string().uuid() });
export function createAgentMethodRouteHandlers(store: typeof agentMethodStore) {
  const handle = (action: (req: FastifyRequest) => Promise<unknown>) => (req: FastifyRequest, reply: FastifyReply) =>
    respondToAgentRequest(reply, () => action(req));
  return {
    list: handle(req => store.list(agentRequestScope(req))),
    get: handle(req => store.get(agentRequestScope(req), methodParams.parse(req.params).methodId)),
    propose: handle(req => store.propose(agentRequestScope(req), proposeAgentMethodV1Schema.parse(req.body))),
    revise: handle(req => store.revise(agentRequestScope(req), methodParams.parse(req.params).methodId, reviseAgentMethodV1Schema.parse(req.body))),
    control: handle(req => store.control(agentRequestScope(req), methodParams.parse(req.params).methodId, controlAgentMethodV1Schema.parse(req.body))),
    history: handle(req => store.history(agentRequestScope(req), methodParams.parse(req.params).methodId)),
    uses: handle(req => store.uses(agentRequestScope(req), methodParams.parse(req.params).methodId)),
    feedback: handle(req => store.feedback(agentRequestScope(req), useParams.parse(req.params).useId, agentMethodFeedbackV1Schema.parse(req.body))),
  };
}
export async function agentMethodRoutes(app: FastifyInstance) {
  const handlers = createAgentMethodRouteHandlers(agentMethodStore);
  const options = { preHandler: [requireSession] };
  app.get("/agent/self-notes", options, (req, reply) => respondToAgentRequest(reply, () =>
    withWorkspaceTransaction(agentRequestScope(req), async tx => ({ version: 1,
      items: await listCompanionSelfNotes(tx, agentRequestScope(req), { includeArchived: true, limit: 100 }) }))));
  app.get("/agent/self-notes/history", options, (req, reply) => respondToAgentRequest(reply, () => {
    const { key } = z.object({ key: z.string().min(1).max(120) }).parse(req.query), scope = agentRequestScope(req);
    return withWorkspaceTransaction(scope, async tx => {
      const rows = await queryRows<{ snapshot: Parameters<typeof projectCompanionSelfNote>[0] }>(tx, sql`
        SELECT snapshot FROM companion_self_note_versions WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
          AND entry_key=${key} ORDER BY revision DESC LIMIT 30`);
      return { version: 1, items: rows.map(row => projectCompanionSelfNote(row.snapshot)) };
    });
  }));
  app.patch("/agent/self-notes", options, (req, reply) => respondToAgentRequest(reply, () => {
    const input = companionSelfNoteWriteV1Schema.parse(req.body), scope = agentRequestScope(req);
    return withWorkspaceTransaction(scope, tx => writeCompanionSelfNote(tx, scope,
      { ...input, reason: `用户纠正：${input.reason}`.slice(0, 300) }, true));
  }));
  app.post("/agent/self-notes/control", options, (req, reply) => respondToAgentRequest(reply, () => {
    const input = companionSelfNoteControlV1Schema.parse(req.body), scope = agentRequestScope(req);
    return withWorkspaceTransaction(scope, tx => controlCompanionSelfNote(tx, scope, input));
  }));
  app.get("/agent/methods", options, handlers.list);
  app.post("/agent/methods", options, handlers.propose);
  app.get("/agent/methods/:methodId", options, handlers.get);
  app.patch("/agent/methods/:methodId", options, handlers.revise);
  app.post("/agent/methods/:methodId/control", options, handlers.control);
  app.get("/agent/methods/:methodId/history", options, handlers.history);
  app.get("/agent/methods/:methodId/uses", options, handlers.uses);
  app.post("/agent/method-uses/:useId/feedback", options, handlers.feedback);
}
