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
export const agentMemoryContextSourceV1Schema = z.object({
  memoryId: z.string().uuid(), revision: z.number().int().positive(),
}).strict();
export type AgentMemoryContextSourceV1 = z.infer<typeof agentMemoryContextSourceV1Schema>;
export const agentInputRefV1Schema = z.object({
  kind: z.literal("note_version"), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
}).strict();
export const agentLongGoalRefV1Schema = z.object({ memoryId:z.string().uuid(),revision:z.number().int().positive() }).strict();

/** Current-turn attention is an interpretation, never a grant to execute. */
export const agentAttentionObjectV1Schema = z.object({
  kind: z.enum(["note", "note_version", "card", "learning_run", "agent_run", "memory", "key_point"]),
  id: z.string().uuid(), revision: z.number().int().positive().optional(), versionId: z.string().uuid().optional(),
}).strict();
export type AgentAttentionObjectV1 = z.infer<typeof agentAttentionObjectV1Schema>;
export const agentTurnInterpretationProposalV1Schema = z.object({
  intent: z.enum(["conversation", "question", "task", "task_control", "mixed"]),
  toolUse: z.enum(["none", "read", "act", "uncertain"]),
  subjects: z.array(z.object({ description: z.string().max(120), objectIndex: z.number().int().nonnegative().optional() }).strict()).max(6),
  goalRelation: z.enum(["unrelated", "new", "continue", "revise", "control", "discuss", "unclear"]),
  goalObjectIndex: z.number().int().nonnegative().optional(),
  candidateOperations: z.array(z.string().min(1).max(100)).max(6),
  ambiguities: z.array(z.string().max(200)).max(6),
  /**
   * 伴星自己消息里**用户这一句没有接**的收尾邀请，按宿主给出的候选索引回填。
   *
   * 它是"哪一条"，不是"哪几个字"：由看得见她的上一条与用户这一句的那次解释来判断，
   * 下游只负责把那条消息的收尾改成记录形态。默认空 = 本轮没有待收的账。
   */
  pendingOfferIndexes: z.array(z.number().int().nonnegative()).max(8).default([]),
}).strict();
export const agentTurnInterpretationV1Schema = agentTurnInterpretationProposalV1Schema.omit({ subjects: true, goalObjectIndex: true }).extend({
  version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  subjects: z.array(z.object({ description: z.string().max(120), reference: agentAttentionObjectV1Schema.nullable() }).strict()).max(6),
  goalReference: agentAttentionObjectV1Schema.nullable(),
  status: z.enum(["interpreted", "uncertain"]),
}).strict();
export type AgentTurnInterpretationV1 = z.infer<typeof agentTurnInterpretationV1Schema>;

export const AGENT_GOAL_DELIVERY_CAPABILITY = "agent_deliver_goal";
export const agentGoalDeliveryV1Schema = z.object({
  outcome: z.enum(["completed", "needs_input", "failed"]),
  summary: z.string().trim().min(1).max(12000),
  requirements: z.array(z.object({
    requirement: z.string().trim().min(1).max(500),
    fulfilled: z.boolean(),
    evidenceCallIds: z.array(z.string().min(1).max(200)).max(10).default([]),
    textOnly: z.boolean().default(false),
  }).strict()).min(1).max(20),
}).strict();
export type AgentGoalDeliveryV1 = z.infer<typeof agentGoalDeliveryV1Schema>;

/**
 * 一次操作真正推进的是哪一个执行体：回执按 kind+id 绑定，换执行体不换身份。
 * `job` 落在 jobs 行上；`card_generation` 直接落在真实制卡 run 上（没有准备用的假 jobs）。
 */
export const agentExecutionRefV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("job"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("card_generation"), id: z.string().uuid() }).strict(),
]);
export type AgentExecutionRefV1 = z.infer<typeof agentExecutionRefV1Schema>;

/** 三类笔记产物保留 jobId（权威事实在那张 jobs 行上）；制卡候选没有 jobId。 */
export const agentArtifactRefV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("note_overview"),
    id: z.string().uuid(), jobId: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("note_dynamic_artifact"),
    id: z.string().uuid(), jobId: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("note_expansion"),
    id: z.string().uuid(), jobId: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  }).strict(),
  z.object({
    // id 是真实 card_generation_runs_v2.id。
    kind: z.literal("card_candidates"),
    id: z.string().uuid(), noteId: z.string().uuid(), noteVersionId: z.string().uuid(),
  }).strict(),
]);

/** 唯一登记制卡能力的名字；card 侧两种结果只配它。 */
export const AGENT_CARD_GENERATION_CAPABILITY = "card_generation_generate";

/** 无卡推荐的依据条数与长度上限：理由取领域事件里已保存的 reasonCodes，不猜正文。 */
export const AGENT_OPERATION_RESULT_MAX_REASON_CODES = 20;
export const AGENT_OPERATION_REASON_CODE_MAX_LENGTH = 100;

/** artifact 与 no_cards_recommended 都是成功收口；伪造一个空 artifact 才是失败。 */
export const agentOperationResultV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), artifact: agentArtifactRefV1Schema }).strict(),
  z.object({
    kind: z.literal("no_cards_recommended"),
    reasonCodes: z.array(z.string().min(1).max(AGENT_OPERATION_REASON_CODE_MAX_LENGTH))
      .max(AGENT_OPERATION_RESULT_MAX_REASON_CODES),
  }).strict(),
]);
export type AgentOperationResultV1 = z.infer<typeof agentOperationResultV1Schema>;

/**
 * 结果必须真的属于这次 execution 与这个 capability——reducer 接受 `succeeded` 的硬条件，
 * 唯一一份判定：
 *   - note 三类：capability 非制卡 ∧ artifact.jobId === job execution.id；
 *   - card_candidates / no_cards_recommended：capability === card_generation_generate
 *     ∧ execution.kind === "card_generation"（前者再要求 artifact.id === execution.id）。
 */
export function agentOperationResultMatchesExecutionV1(
  execution: AgentExecutionRefV1,
  result: AgentOperationResultV1,
  capability: string,
): boolean {
  if (result.kind === "no_cards_recommended") {
    return capability === AGENT_CARD_GENERATION_CAPABILITY && execution.kind === "card_generation";
  }
  const artifact = result.artifact;
  if (artifact.kind === "card_candidates") {
    return capability === AGENT_CARD_GENERATION_CAPABILITY
      && execution.kind === "card_generation" && artifact.id === execution.id;
  }
  return execution.kind === "job" && artifact.jobId === execution.id;
}

export const agentOperationV1Schema = z.object({
  operationId: z.string().uuid(), runId: z.string().uuid(), revision: z.number().int().positive(),
  scope: agentScopeV1Schema, capability: z.string().min(1).max(100),
  execution: agentExecutionRefV1Schema,
  status: agentOperationStatusV1Schema, lastEventSeq: z.number().int().nonnegative(),
  result: agentOperationResultV1Schema.nullable(), error: z.string().max(1000).nullable(),
}).strict().superRefine((operation, ctx) => {
  // 读出来的投影自身必须自洽：挂着别人的结果在被 reducer 看见之前就已非法。
  if (operation.result !== null
    && !agentOperationResultMatchesExecutionV1(operation.execution, operation.result, operation.capability)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "结果必须属于这一次 execution 与 capability" });
  }
});
export const agentOperationEventV1Schema = z.object({
  operationId: z.string().uuid(), runId: z.string().uuid(), revision: z.number().int().positive(),
  scope: agentScopeV1Schema, execution: agentExecutionRefV1Schema, seq: z.number().int().positive(),
  status: agentOperationStatusV1Schema,
  result: agentOperationResultV1Schema.nullable(), error: z.string().max(1000).nullable(),
  authoritative: z.boolean(),
}).strict();
export const agentRunV1Schema = z.object({
  version: z.literal(1), runId: z.string().uuid(), identityId: z.string().uuid(),
  revision: z.number().int().positive(), goal: z.string().min(1).max(8000),
  status: agentRunStatusV1Schema, conversationId: z.string().uuid().nullable(),
  inputs: z.array(agentInputRefV1Schema).max(20),
  longGoal:agentLongGoalRefV1Schema.nullable().optional(),
  operations: z.array(agentOperationV1Schema).max(100), artifacts: z.array(agentArtifactRefV1Schema).max(100),
  summary: z.string().max(12000).nullable(), error: z.string().max(1000).nullable(),
  modelCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().positive(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
// ─── 目标列表分页（方案 42 第一批 A）────────────────────────────────────────
//
// 列表要能往回翻到更早的真实目标，所以游标是「位置书签」而不是页码：
// offset 会在翻页途中被状态更新顶掉（同一页里出现重复或漏掉一条），
// 双字段 (updated_at, id) 比较则与并发更新无关地保持一个全序。
export const AGENT_RUN_LIST_DEFAULT_LIMIT = 20;
export const AGENT_RUN_LIST_MAX_LIMIT = 50;

/**
 * 游标载荷。`updatedAt` 必须保留 Postgres 的微秒精度：JS `Date` 只有毫秒，
 * 用它回读会把同一毫秒内的两行折叠成同一位置，翻页时漏读或重复读。
 * 编码由 agent-host 负责（base64url），服务端只认自己签发的这一种形状。
 */
export const agentRunListCursorV1Schema = z.object({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  updatedAt: z.string().datetime(),
  runId: z.string().uuid(),
  longGoalMemoryId: z.string().uuid().optional(),
}).strict();
export const agentRunListQueryV1Schema = z.object({
  limit: z.coerce.number().int().min(1).max(AGENT_RUN_LIST_MAX_LIMIT).optional().default(AGENT_RUN_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
  longGoalMemoryId: z.string().uuid().optional(),
}).strict();
export const agentRunListV1Schema = z.object({
  version: z.literal(1),
  items: z.array(agentRunV1Schema).max(AGENT_RUN_LIST_MAX_LIMIT),
  // 没有更早一页时为 null——「没有」和「空页」不是一回事，调用方据此停止翻页。
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();
export const createAgentRunV1Schema = z.object({
  requestId: z.string().uuid(), goal: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(), inputs: z.array(agentInputRefV1Schema).max(20).default([]),
  longGoal:agentLongGoalRefV1Schema.optional(),
}).strict();
export const reviseAgentRunV1Schema = z.object({
  expectedRevision: z.number().int().positive(), goal: z.string().trim().min(1).max(8000),
  longGoal: agentLongGoalRefV1Schema.nullable().optional(),
}).strict();
export const controlAgentRunV1Schema = z.object({
  expectedRevision: z.number().int().positive(), action: z.enum(["cancel", "pause", "resume"]),
}).strict();

// ─── 每个目标的版本历史（方案 42 第一批 A）──────────────────────────────────
//
// 一次「要求修订」或「失败后换一次继续」会在同一个事务里先把旧版本原样存档，
// 再推进 revision。历史项只带**它自己那一版**的 operation 与 artifact：
// 新版成果不能回填到旧版，旧版成果也不会被抹掉。
export const AGENT_RUN_HISTORY_DEFAULT_LIMIT = 20;
export const AGENT_RUN_HISTORY_MAX_LIMIT = 50;

export const agentRunRevisionV1Schema = z.object({
  version: z.literal(1), runId: z.string().uuid(), revision: z.number().int().positive(),
  goal: z.string().min(1).max(8000), status: agentRunStatusV1Schema,
  conversationId: z.string().uuid().nullable(),
  inputs: z.array(agentInputRefV1Schema).max(20),
  longGoal:agentLongGoalRefV1Schema.nullable().optional(),
  operations: z.array(agentOperationV1Schema).max(100),
  artifacts: z.array(agentArtifactRefV1Schema).max(100),
  summary: z.string().max(12000).nullable(), error: z.string().max(1000).nullable(),
  modelCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().positive(),
  // 功能部署之前已经开始的一版没有确切起始时间：给 null，不用迁移时间冒充。
  startedAt: z.string().datetime().nullable(),
  lastActiveAt: z.string().datetime(),
  // null 表示这一版仍是当前版；非 null 表示它已被 replace 掉，存档后不再变。
  recordedAt: z.string().datetime().nullable(),
  supersededByRevision: z.number().int().positive().nullable(),
}).strict();

/**
 * 历史按 revision 往回翻，不做无界遍历：一页最多 50 个 revision 号。
 * `beforeRevision` 是**含边界**——它就是本页第一版的 revision 号（缺省即当前版）。
 * `nextBeforeRevision` 只是「还有更早的号没读」，不保证那一页里有存档。
 */
export const agentRunHistoryQueryV1Schema = z.object({
  beforeRevision: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(AGENT_RUN_HISTORY_MAX_LIMIT).optional().default(AGENT_RUN_HISTORY_DEFAULT_LIMIT),
}).strict();

export const agentRunHistoryV1Schema = z.object({
  version: z.literal(1), runId: z.string().uuid(), currentRevision: z.number().int().positive(),
  // 按 revision 倒序；第一页的第一项是当前版，之后的页只含更早的存档。
  items: z.array(agentRunRevisionV1Schema).max(AGENT_RUN_HISTORY_MAX_LIMIT),
  nextBeforeRevision: z.number().int().positive().nullable(),
  // 诚实缺省：**本页范围内**没有存档的 revision 号。部署前走过的版本没有任何
  // 凭据，这里点名说明缺哪几版，不从模型聊天或 summary 反推「当时大概是这样」。
  unrecordedRevisions: z.array(z.number().int().positive()).max(AGENT_RUN_HISTORY_MAX_LIMIT),
}).strict().superRefine((history, ctx) => {
  const seen: number[] = [];
  for (const [index, item] of history.items.entries()) {
    const at = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if (item.runId !== history.runId) at(["items", index, "runId"], "历史项必须属于同一个目标");
    if (item.revision > history.currentRevision) at(["items", index, "revision"], "历史项不能比当前版本更新");
    if ((item.recordedAt === null) !== (item.supersededByRevision === null))
      at(["items", index], "当前版没有存档时间，被替换的版本必须有");
    if (item.supersededByRevision !== null && item.supersededByRevision <= item.revision)
      at(["items", index, "supersededByRevision"], "替代它的版本必须更新");
    if (item.operations.some(operation => operation.revision !== item.revision))
      at(["items", index, "operations"], "operation 必须属于它自己那一版，不能混进新版结果");
    if (item.operations.some(operation => operation.runId !== item.runId))
      at(["items", index, "operations"], "operation 必须属于同一个目标");
    seen.push(item.revision);
  }
  for (let index = 1; index < seen.length; index += 1) {
    if (seen[index]! >= seen[index - 1]!)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "历史项必须按 revision 严格倒序且不重复" });
  }
  for (const missing of history.unrecordedRevisions) {
    if (seen.includes(missing))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unrecordedRevisions"], message: "已经存档的版本不能算缺省" });
    if (missing >= history.currentRevision)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unrecordedRevisions"], message: "当前版本一定读得到，不该被列为缺省" });
  }
  if (history.nextBeforeRevision !== null && seen[0] !== undefined && history.nextBeforeRevision >= seen[0])
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextBeforeRevision"], message: "下一页必须指向更早的 revision" });
});

export type AgentRunV1 = z.infer<typeof agentRunV1Schema>;
export type CreateAgentRunV1 = z.infer<typeof createAgentRunV1Schema>;
export type AgentRunStatusV1 = z.infer<typeof agentRunStatusV1Schema>;
export type AgentOperationV1 = z.infer<typeof agentOperationV1Schema>;
export type AgentOperationEventV1 = z.infer<typeof agentOperationEventV1Schema>;
export type AgentOperationStatusV1 = z.infer<typeof agentOperationStatusV1Schema>;
export type AgentArtifactRefV1 = z.infer<typeof agentArtifactRefV1Schema>;
export type AgentInputRefV1 = z.infer<typeof agentInputRefV1Schema>;
export type AgentScopeV1 = z.infer<typeof agentScopeV1Schema>;
export type AgentRunListQueryV1 = z.infer<typeof agentRunListQueryV1Schema>;
export type AgentRunListCursorV1 = z.infer<typeof agentRunListCursorV1Schema>;
export type AgentRunRevisionV1 = z.infer<typeof agentRunRevisionV1Schema>;
export type AgentRunHistoryQueryV1 = z.infer<typeof agentRunHistoryQueryV1Schema>;
export type AgentRunHistoryV1 = z.infer<typeof agentRunHistoryV1Schema>;
