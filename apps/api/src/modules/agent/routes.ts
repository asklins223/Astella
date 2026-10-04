import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AgentStoreError } from "@ailearn/agent-host";
import { z } from "zod";
import {
  createAgentRunV1Schema, reviseAgentRunV1Schema, controlAgentRunV1Schema,
  agentRunListQueryV1Schema, agentRunHistoryQueryV1Schema,
} from "@ailearn/shared/agent-contracts";
import { requireSession } from "../identity/middleware.ts";
import { buildSimpleErrorBody } from "../../lib/error-envelope.ts";
import { agentStore } from "./service.ts";

const runParams = z.object({ runId: z.string().uuid() });
/** Workspace packages can resolve distinct Zod instances. */
function isZodError(error: unknown): boolean {
  return error instanceof z.ZodError
    || (error instanceof Error && error.name === "ZodError"
      && Array.isArray((error as Error & { issues?: unknown }).issues));
}
async function respond(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof AgentStoreError) {
      return reply.code(error.statusCode).send(buildSimpleErrorBody(error, { maskServerErrors: true }));
    }
    if (isZodError(error)) return reply.code(400).send({ error: "invalid_request", message: "输入格式不正确。" });
    throw error;
  }
}
// 空间与用户只来自会话：查询串里带的不信，游标里带的也必须逐字对上。
function scope(req: FastifyRequest) { return { workspaceId: req.session!.workspaceId, userId: req.session!.userId }; }
type Scope = ReturnType<typeof scope>;

/** 路由真正执行的那几个动作。抽出来是为了能带着假 store 走真实解析与错误映射。 */
export function createAgentRouteHandlers(store: {
  list(scope: Scope, query: { limit?: unknown; cursor?: string }): Promise<unknown>;
  get(scope: Scope, id: string): Promise<unknown>;
  create(scope: Scope, input: unknown): Promise<unknown>;
  revise(scope: Scope, id: string, expectedRevision: number, goal: string): Promise<unknown>;
  control(scope: Scope, id: string, expectedRevision: number, action: "cancel" | "pause" | "resume"): Promise<unknown>;
  history(scope: Scope, id: string, query: { limit?: unknown; beforeRevision?: number }): Promise<unknown>;
}) {
  return {
    list: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () =>
      store.list(scope(req), agentRunListQueryV1Schema.parse(req.query ?? {}))),
    get: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () =>
      store.get(scope(req), runParams.parse(req.params).runId)),
    create: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () =>
      store.create(scope(req), createAgentRunV1Schema.parse(req.body))),
    revise: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () => {
      const input = reviseAgentRunV1Schema.parse(req.body);
      return store.revise(scope(req), runParams.parse(req.params).runId, input.expectedRevision, input.goal);
    }),
    control: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () => {
      const input = controlAgentRunV1Schema.parse(req.body);
      return store.control(scope(req), runParams.parse(req.params).runId, input.expectedRevision, input.action);
    }),
    history: (req: FastifyRequest, reply: FastifyReply) => respond(reply, () =>
      store.history(scope(req), runParams.parse(req.params).runId, agentRunHistoryQueryV1Schema.parse(req.query ?? {}))),
  };
}

export async function agentRoutes(app: FastifyInstance) {
  const handlers = createAgentRouteHandlers(agentStore);
  // 默认第一页 20 条；还有结果时返回 nextCursor。
  app.get("/agent/runs", { preHandler: [requireSession] }, handlers.list);
  app.get("/agent/runs/:runId", { preHandler: [requireSession] }, handlers.get);
  app.post("/agent/runs", { preHandler: [requireSession] }, handlers.create);
  app.patch("/agent/runs/:runId", { preHandler: [requireSession] }, handlers.revise);
  app.post("/agent/runs/:runId/control", { preHandler: [requireSession] }, handlers.control);
  app.get("/agent/runs/:runId/history", { preHandler: [requireSession] }, handlers.history);
}
