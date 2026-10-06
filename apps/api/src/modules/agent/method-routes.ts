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
  app.get("/agent/methods", options, handlers.list);
  app.post("/agent/methods", options, handlers.propose);
  app.get("/agent/methods/:methodId", options, handlers.get);
  app.patch("/agent/methods/:methodId", options, handlers.revise);
  app.post("/agent/methods/:methodId/control", options, handlers.control);
  app.get("/agent/methods/:methodId/history", options, handlers.history);
  app.get("/agent/methods/:methodId/uses", options, handlers.uses);
  app.post("/agent/method-uses/:useId/feedback", options, handlers.feedback);
}
