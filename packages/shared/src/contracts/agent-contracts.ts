import { z } from "zod";

export const agentRunStatusV1Schema = z.enum([
  "queued", "running", "waiting", "paused", "completed", "failed", "cancelled",
]);
export const agentOperationStatusV1Schema = z.enum([
  "accepted", "running", "succeeded", "failed", "cancelled", "outcome_unknown",
]);
export const agentScopeV1Schema = z.object({
  workspaceId: z.string().uuid(), userId: z.string().uuid(),
}).strict();
export const agentInputRefV1Schema = z.object({
  kind: z.literal("note_version"), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
}).strict();
export const agentArtifactRefV1Schema = z.object({
  kind: z.enum(["note_overview", "note_dynamic_artifact"]),
  id: z.string().uuid(), jobId: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
}).strict();
export const agentOperationV1Schema = z.object({
  operationId: z.string().uuid(), runId: z.string().uuid(), revision: z.number().int().positive(),
  scope: agentScopeV1Schema, capability: z.string().min(1).max(100), jobId: z.string().uuid(),
  status: agentOperationStatusV1Schema, lastEventSeq: z.number().int().nonnegative(),
  artifact: agentArtifactRefV1Schema.nullable(), error: z.string().max(1000).nullable(),
}).strict();
export const agentOperationEventV1Schema = z.object({
  operationId: z.string().uuid(), runId: z.string().uuid(), revision: z.number().int().positive(),
  scope: agentScopeV1Schema, jobId: z.string().uuid(), seq: z.number().int().positive(),
  status: agentOperationStatusV1Schema,
  artifact: agentArtifactRefV1Schema.nullable(), error: z.string().max(1000).nullable(),
  authoritative: z.boolean(),
}).strict();
export const agentRunV1Schema = z.object({
  version: z.literal(1), runId: z.string().uuid(), identityId: z.string().uuid(),
  revision: z.number().int().positive(), goal: z.string().min(1).max(8000),
  status: agentRunStatusV1Schema, conversationId: z.string().uuid().nullable(),
  inputs: z.array(agentInputRefV1Schema).max(20),
  operations: z.array(agentOperationV1Schema).max(100), artifacts: z.array(agentArtifactRefV1Schema).max(100),
  summary: z.string().max(12000).nullable(), error: z.string().max(1000).nullable(),
  modelCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().positive(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const agentRunListV1Schema = z.object({ version: z.literal(1), items: z.array(agentRunV1Schema) }).strict();
export const createAgentRunV1Schema = z.object({
  requestId: z.string().uuid(), goal: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(), inputs: z.array(agentInputRefV1Schema).max(20).default([]),
}).strict();
export const reviseAgentRunV1Schema = z.object({
  expectedRevision: z.number().int().positive(), goal: z.string().trim().min(1).max(8000),
}).strict();
export const controlAgentRunV1Schema = z.object({
  expectedRevision: z.number().int().positive(), action: z.enum(["cancel", "pause", "resume"]),
}).strict();

export type AgentRunV1 = z.infer<typeof agentRunV1Schema>;
export type AgentRunStatusV1 = z.infer<typeof agentRunStatusV1Schema>;
export type AgentOperationV1 = z.infer<typeof agentOperationV1Schema>;
export type AgentOperationEventV1 = z.infer<typeof agentOperationEventV1Schema>;
export type AgentArtifactRefV1 = z.infer<typeof agentArtifactRefV1Schema>;
export type AgentInputRefV1 = z.infer<typeof agentInputRefV1Schema>;
export type AgentScopeV1 = z.infer<typeof agentScopeV1Schema>;
