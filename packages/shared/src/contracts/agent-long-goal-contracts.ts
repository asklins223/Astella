import {z} from "zod";
import {agentLongGoalRefV1Schema,agentRunStatusV1Schema} from "./agent-contracts.ts";

export const agentLongGoalsQueryV1Schema=z.object({
  limit:z.coerce.number().int().min(1).max(50).default(20),
  cursor:z.string().min(1).max(1024).optional(),
  query:z.string().trim().max(200).optional(),memoryId:z.string().uuid().optional(),
}).strict();
export type AgentLongGoalsQueryV1=z.input<typeof agentLongGoalsQueryV1Schema>;

export const agentLongGoalV1Schema=z.object({
  ref:agentLongGoalRefV1Schema,content:z.string().min(1).max(8000),
  appliesWhen:z.string().max(200).nullable(),updatedAt:z.string().datetime(),
  tasks:z.array(z.object({runId:z.string().uuid(),revision:z.number().int().positive(),
    goalRevision:z.number().int().positive(),goal:z.string().max(8000),status:agentRunStatusV1Schema,
    summary:z.string().max(12000).nullable(),updatedAt:z.string().datetime()}).strict()).max(5),
  taskCount:z.number().int().nonnegative().default(0),
}).strict();
export const agentLongGoalsV1Schema=z.object({version:z.literal(1),items:z.array(agentLongGoalV1Schema).max(50),nextCursor:z.string().max(1024).nullable().default(null)}).strict();
export type AgentLongGoalV1=z.infer<typeof agentLongGoalV1Schema>;
