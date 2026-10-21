import { z } from "zod";
import { QWEN_TTS_SUPPORTED_DIALECTS } from "../../companion/tts-voice-catalog.ts";

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
  kind: z.enum(["note", "note_version", "card", "agent_run", "memory"]),
  id: z.string().uuid(), revision: z.number().int().positive().optional(), versionId: z.string().uuid().optional(),
}).strict();
export type AgentAttentionObjectV1 = z.infer<typeof agentAttentionObjectV1Schema>;
export const agentPersistentVoicePreferenceV1Schema = z.object({
  action: z.enum(["keep", "set", "clear"]),
  dialect: z.enum(QWEN_TTS_SUPPORTED_DIALECTS).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "set") !== (value.dialect !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dialect"], message: "set requires a dialect; keep/clear require null" });
  }
});
export type AgentPersistentVoicePreferenceV1 = z.infer<typeof agentPersistentVoicePreferenceV1Schema>;
const agentPersistentVoicePreferenceV1WithDefaultSchema = agentPersistentVoicePreferenceV1Schema
  .default({ action: "keep", dialect: null });
export const agentVoiceStyleDecisionV1Schema = z.object({
  decision: z.enum(["none", "apply", "clarify"]),
  instruction: z.string().trim().min(1).max(50).nullable(),
  /** Durable dialect is independent from a one-turn override and from voice tone settings. */
  persistentPreference: agentPersistentVoicePreferenceV1WithDefaultSchema,
}).strict();
export const agentVoicePreferenceWriteStatusV1Schema = z.enum(["not_requested", "saved", "unchanged", "failed"]);
export type AgentVoicePreferenceWriteStatusV1 = z.infer<typeof agentVoicePreferenceWriteStatusV1Schema>;
const agentVoiceStyleDecisionV1WithDefaultSchema = agentVoiceStyleDecisionV1Schema
  .default({ decision: "none", instruction: null, persistentPreference: { action: "keep", dialect: null } });
/** Input view keeps legacy/unit callers able to omit host-managed preference metadata. */
export type AgentVoiceStyleDecisionV1 = z.input<typeof agentVoiceStyleDecisionV1Schema>;
export const agentTurnInterpretationProposalV1Schema = z.object({
  intent: z.enum(["conversation", "question", "task", "task_control", "mixed"]),
  toolUse: z.enum(["none", "read", "act", "uncertain"]),
  // 解释的条目数不在这里收口：提示词要求「窗口里每一条这样的消息都要列出来」，
  // 合同再封顶就是让它在说完之后被判非法。单条描述仍按字段长度校验。
  subjects: z.array(z.object({ description: z.string().max(120), objectIndex: z.number().int().nonnegative().optional() }).strict()),
  goalRelation: z.enum(["unrelated", "new", "continue", "revise", "control", "discuss", "unclear"]),
  goalObjectIndex: z.number().int().nonnegative().optional(),
  candidateOperations: z.array(z.string().min(1).max(100)),
  ambiguities: z.array(z.string().max(200)),
  /** Semantic, current-turn TTS direction. `none` never inherits a past request implicitly. */
  voiceStyle: agentVoiceStyleDecisionV1Schema,
  /** Current-turn restrictions narrow execution, never grant authority.
   * Optional for stored interpretations predating this contract. */
  executionConstraints: z.object({ timeBasedWakeups: z.enum(["forbid", "unspecified"]),
    sourceQuote: z.string().max(2000).nullable().optional() }).strict().optional(),
  /**
   * 伴星自己消息里**用户这一句没有接**的收尾邀请，按宿主给出的候选索引回填。
   *
   * 它是"哪一条"，不是"哪几个字"：由看得见她的上一条与用户这一句的那次解释来判断，
   * 下游只负责把那条消息的收尾改成记录形态。默认空 = 本轮没有待收的账。
   */
  pendingOfferIndexes: z.array(z.number().int().nonnegative()).default([]),
}).strict();
export const agentTurnInterpretationV1Schema = agentTurnInterpretationProposalV1Schema.omit({ subjects: true, goalObjectIndex: true }).extend({
  // Older persisted turn interpretations predate voiceStyle; safely replay them as no request.
  voiceStyle: agentVoiceStyleDecisionV1WithDefaultSchema,
  /** Host receipt: the semantic preference write was committed before generation. */
  voicePreferenceWrite: agentVoicePreferenceWriteStatusV1Schema.default("not_requested"),
  version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  subjects: z.array(z.object({ description: z.string().max(120), reference: agentAttentionObjectV1Schema.nullable() }).strict()),
  goalReference: agentAttentionObjectV1Schema.nullable(),
  status: z.enum(["interpreted", "uncertain"]),
  // Existing experimental rows may carry this key. Discard it before any replay
  // or cached interpretation can influence the active conversation.
  dialogueFrame: z.unknown().optional(),
}).strict().transform(({ dialogueFrame: _retired, ...current }) => current);
export type AgentTurnInterpretationV1 = z.infer<typeof agentTurnInterpretationV1Schema>;

export const AGENT_GOAL_DELIVERY_CAPABILITY = "agent_deliver_goal";
/**
 * 交付说明是她自己写的那一段话，篇幅不在这里定：一步能说多少由模型档案声明的输出
 * 额度决定。条目数同样不设上限——用户交代了 24 条要求时要能逐条对上，
 * 而不是合同只收 20 条，剩下的悄悄不算交付。ID 类字段仍按身份校验。
 */
export const agentGoalDeliveryV1Schema = z.object({
  outcome: z.enum(["completed", "needs_input", "failed"]),
  summary: z.string().trim().min(1),
  requirements: z.array(z.object({
    requirement: z.string().trim().min(1),
    fulfilled: z.boolean(),
    evidenceCallIds: z.array(z.string().min(1).max(200)).default([]),
    textOnly: z.boolean().default(false),
  }).strict()).min(1),
}).strict();
export type AgentGoalDeliveryV1 = z.infer<typeof agentGoalDeliveryV1Schema>;

/** Plan 57: operations and saved note artifacts use the current job chain. */
export const agentExecutionRefV1Schema = z.object({ kind: z.literal("job"), id: z.string().uuid() }).strict();
export type AgentExecutionRefV1 = z.infer<typeof agentExecutionRefV1Schema>;

/** Saved note artifacts carry the identity of their current job. */
export const agentArtifactRefV1Schema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("note_mind_map"),id:z.string().uuid(),jobId:z.string().uuid(),noteId:z.string().uuid(),noteVersionId:z.string().uuid()}).strict(),
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
]);

/**
 * 这一样成果在界面上的叫法，**只有这一处**（2026-10-14）：手记里的成果卡、聊天里的推荐卡
 * 说的是同一个东西，词分叉的那天，用户就会看到"互动演示"和"演示页面"两张卡。
 * 伴星以前只能把这些名字自己抄进正文，抄出来的不一定是页面上那个。
 */
export const AGENT_ARTIFACT_KIND_LABELS_V1: Record<AgentArtifactRefV1["kind"], string> = {
  note_mind_map: "思维导图",
  note_overview: "速看",
  note_dynamic_artifact: "互动演示",
  note_expansion: "拓展草稿",
};
/** A result is a saved artifact belonging to this operation. */
export const agentOperationResultV1Schema = z.object({ kind: z.literal("artifact"), artifact: agentArtifactRefV1Schema }).strict();
export type AgentOperationResultV1 = z.infer<typeof agentOperationResultV1Schema>;

/** Plan 57: operations and saved note artifacts use the current job chain. */
export function agentOperationResultMatchesExecutionV1(
  execution: AgentExecutionRefV1,
  result: AgentOperationResultV1,
  capability: string,
): boolean {
  const expectedCapability = { note_overview: "note_overview_generate", note_mind_map: "note_mind_map_generate",
    note_dynamic_artifact: "note_dynamic_artifact_generate", note_expansion: "note_expansion_generate" }[result.artifact.kind];
  return execution.kind === "job" && result.artifact.jobId === execution.id && capability === expectedCapability;
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
  // A run's own trajectory is never capped here: the operations and artifacts it
  // actually produced are the record, and a long job legitimately has more than
  // any fixed count of them. `maxModelCalls` is null when nothing ceilings it.
  operations: z.array(agentOperationV1Schema), artifacts: z.array(agentArtifactRefV1Schema),
  summary: z.string().nullable(), error: z.string().max(1000).nullable(),
  modelCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().positive().nullable(),
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
  operations: z.array(agentOperationV1Schema),
  artifacts: z.array(agentArtifactRefV1Schema),
  summary: z.string().nullable(), error: z.string().max(1000).nullable(),
  modelCalls: z.number().int().nonnegative(), maxModelCalls: z.number().int().positive().nullable(),
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
