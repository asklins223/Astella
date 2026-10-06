import { z } from "zod";

/** 生命周期：这条方法现在处于哪一步（待确认／已确认／停用／有争议）。 */
export const agentMethodStateV1Schema = z.enum(["candidate", "active", "disabled", "disputed"]);
/**
 * 认识状态：她**凭什么**这么说（有据／暂定／争议）。
 *
 * 与 `state` 是两件事，不能互相顶替：
 * `state='active'` 只说明用户点过确认，`epistemicStatus` 才说明依据是否还站得住。
 * 把两者合成一个字段，就会出现「active 但依据已被纠正」被读成已确认可用的形状——
 * 那正是 0348/0374 把它拆成两列要挡的退化。
 */
export const agentMethodEpistemicStatusV1Schema = z.enum(["tentative", "supported", "disputed"]);
export const agentMethodCapabilityV1Schema = z.object({
  name: z.string().min(1).max(100), version: z.string().min(1).max(40),
}).strict();
export const agentMethodEvidenceV1Schema = z.object({
  memoryId: z.string().uuid().optional(), memoryRevision: z.number().int().positive().optional(),
  runId: z.string().uuid().optional(), runRevision: z.number().int().positive().optional(),
  eventId: z.string().min(1).max(240).optional(), note: z.string().max(400).optional(),
}).strict().refine(value => !!(value.memoryId || value.runId || value.eventId), "缺少经验来源");
export const agentMethodV1Schema = z.object({
  version: z.literal(1), methodId: z.string().uuid(), revision: z.number().int().positive(),
  title: z.string().min(1).max(120), appliesWhen: z.string().min(1).max(200),
  steps: z.array(z.string().min(1).max(400)).max(20), exceptions: z.array(z.string().min(1).max(400)).max(10),
  evidence: z.array(agentMethodEvidenceV1Schema).max(40),
  /**
   * 独立来源数（§6.4）：`evidence` 是完整的派生关系，而「有几条依据」要按**原始来源**
   * 算——同一次运行派生出的记忆、摘要与候选只算一条。两者不是同一个数，也不该合成一个。
   */
  evidenceIndependentCount: z.number().int().nonnegative(), capabilities: z.array(agentMethodCapabilityV1Schema).max(20),
  state: agentMethodStateV1Schema, userControlled: z.boolean(),
  epistemicStatus: agentMethodEpistemicStatusV1Schema,
  availability: z.enum(["available", "pending", "disabled", "source_changed", "capability_changed", "previous_version"]),
  author: z.enum(["user", "companion", "extractor", "maintenance"]),
  changeReason: z.string().max(500).nullable(), sourceRunId: z.string().uuid().nullable(), sourceRunRevision: z.number().int().positive().nullable(),
  // §6.3：三个计数各自独立。`offeredCount` 是**目录被提供**的次数——它不等于被读过，
  // 更不等于有用；`consultedCount` 只算真正读过正文的那些。
  offeredCount: z.number().int().nonnegative(), adoptedCount: z.number().int().nonnegative(),
  consultedCount: z.number().int().nonnegative(), helpfulCount: z.number().int().nonnegative(), unhelpfulCount: z.number().int().nonnegative(),
  lastConsultedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export const agentMethodListV1Schema = z.object({ version: z.literal(1), items: z.array(agentMethodV1Schema).max(100) }).strict();
export const agentMethodHistoryV1Schema = z.object({ version: z.literal(1), items: z.array(agentMethodV1Schema).max(30) }).strict();
export const proposeAgentMethodV1Schema = z.object({
  runId: z.string().uuid(), expectedRunRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(120), appliesWhen: z.string().trim().min(1).max(200),
}).strict();
export const reviseAgentMethodV1Schema = z.object({
  expectedRevision: z.number().int().positive(), title: z.string().trim().min(1).max(120),
  appliesWhen: z.string().trim().min(1).max(200), steps: z.array(z.string().trim().min(1).max(400)).min(1).max(20),
  exceptions: z.array(z.string().trim().min(1).max(400)).max(10), reason: z.string().trim().min(1).max(500),
}).strict();
export const controlAgentMethodV1Schema = z.object({
  expectedRevision: z.number().int().positive(), action: z.enum(["confirm", "disable", "restore"]),
  reason: z.string().trim().max(500).optional(),
}).strict();
export const agentMethodUseV1Schema = z.object({
  useId: z.string().uuid(), methodId: z.string().uuid(), methodRevision: z.number().int().positive(),
  /**
   * 这次记录处在哪一步（§6.3）：`offered` 只是出现在目录里，`read` 是读过正文，
   * `adopted` 是被实际采用。**效果评价只能挂在前两者之后**——没读过就判不了好坏。
   */
  stage: z.enum(["offered", "read", "adopted"]),
  contextKind: z.enum(["agent_goal", "conversation"]), contextId: z.string().uuid(), contextRevision: z.number().int().positive(),
  feedback: z.enum(["helpful", "unhelpful"]).nullable(), comment: z.string().max(500).nullable(),
  createdAt: z.string().datetime(), feedbackAt: z.string().datetime().nullable(),
}).strict();
export const agentMethodUsesV1Schema = z.object({ version: z.literal(1), items: z.array(agentMethodUseV1Schema).max(30) }).strict();
export const agentMethodFeedbackV1Schema = z.object({ feedback: z.enum(["helpful", "unhelpful"]), comment: z.string().trim().max(500).optional() }).strict();
export type AgentMethodV1 = z.infer<typeof agentMethodV1Schema>;
export type AgentMethodUseV1 = z.infer<typeof agentMethodUseV1Schema>;
export type AgentMethodEvidenceV1 = z.infer<typeof agentMethodEvidenceV1Schema>;
export type AgentMethodCapabilityV1 = z.infer<typeof agentMethodCapabilityV1Schema>;
export type AgentMethodEpistemicStatusV1 = z.infer<typeof agentMethodEpistemicStatusV1Schema>;
