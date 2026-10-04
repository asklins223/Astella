import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AgentStoreError } from "@ailearn/agent-host";
import { z } from "zod";
import { createAgentRunV1Schema, reviseAgentRunV1Schema, controlAgentRunV1Schema } from "@ailearn/shared/agent-contracts";
import { requireSession } from "../identity/middleware.ts";
import { agentStore } from "./service.ts";

const runParams = z.object({ runId: z.string().uuid() });
async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof AgentStoreError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", message: "输入格式不正确。" });
    throw error;
  }
}
function scope(req: FastifyRequest) { return { workspaceId: req.session!.workspaceId, userId: req.session!.userId }; }
export async function agentRoutes(app: FastifyInstance) {
  app.get("/agent/runs", { preHandler: [requireSession] }, (req, reply) => respond(reply, () => agentStore.list(scope(req))));
  app.get("/agent/runs/:runId", { preHandler: [requireSession] }, (req, reply) => respond(reply,
    () => agentStore.get(scope(req), runParams.parse(req.params).runId)));
  app.post("/agent/runs", { preHandler: [requireSession] }, (req, reply) => respond(reply,
    () => agentStore.create(scope(req), createAgentRunV1Schema.parse(req.body))));
  app.patch("/agent/runs/:runId", { preHandler: [requireSession] }, (req, reply) => respond(reply, () => {
    const input = reviseAgentRunV1Schema.parse(req.body);
    return agentStore.revise(scope(req), runParams.parse(req.params).runId, input.expectedRevision, input.goal);
  }));
  app.post("/agent/runs/:runId/control", { preHandler: [requireSession] }, (req, reply) => respond(reply, () => {
    const input = controlAgentRunV1Schema.parse(req.body);
    return agentStore.control(scope(req), runParams.parse(req.params).runId, input.expectedRevision, input.action);
  }));
}
