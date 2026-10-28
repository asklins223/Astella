/**
 * Companion Agent v1 contracts.
 *
 * 这些合同描述的是**能力**，不是可执行代码：一个工具能声明自己的参数、风险档和
 * 是否需要确认，但不能带来新传输、任意代码或无界操作。
 *
 * 曾经还有一层"技能"（选工具 + 附加策略文本）。它现在整条删除了：工具面每轮全给、
 * 只按权限档过滤（方案 29 §4.1），而"按关键词挑一个技能"正是 90.7% 轮次拿不到
 * 工具的原因。留下一个不参与决策的层，比删掉它更容易骗到下一个读代码的人。
 */

import { z } from "zod";
import { isCompanionAutonomousAction, isCompanionAutonomousTool } from "../../companion/companion-autonomy.ts";
import { companionDomainActionAutoExecutes, companionDomainActionRequiresConfirmation } from "../../agent/companion-domain-tools.ts";
import { companionCreatedNoteV1Schema, companionEditedNoteV1Schema, companionWrittenAnnotationV1Schema } from "./companion-note-authoring-contracts.ts";

export const COMPANION_AGENT_CONTRACT_VERSION = 1 as const;
// Counts are observations, not task-completion rules. Null means no default
// count ceiling; hosts may freeze explicit deployment limits in the run receipt.
export const COMPANION_AGENT_MAX_STEPS = null;
export const COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP = null;
export const COMPANION_AGENT_MAX_TOOL_CALLS = null;
export const COMPANION_AGENT_MAX_MODEL_CALLS = null;
export const COMPANION_AGENT_DEADLINE_MS = null;

/**
 * 受"图片可以外发"这条政策管的能力档工具。
 *
 * 与权限档无关（读图在 read_only 下也是读），管的是**数据出境**：一张截图里可能
 * 有人脸、门牌、别人的屏幕，所以 `dataPolicy.sendImageContent=false` 时这些工具
 * **根本不下发**——她看不见就不会调，也就不会先答应再看不了。执行层独立再拦一次
 * （见 CompanionAgentToolExecutionConstraints），因为工具名是模型给的。
 */
export const VISION_GATED_COMPANION_TOOL_NAMES: readonly string[] = Object.freeze([
  // Only the action that sends image bytes abroad is gated. Displaying an image
  // locally and drawing a diagram do not leave the device, so the visual domain
  // tool itself stays available; read_image is rejected at execution.
  "visual.read_image",
]);

export function isVisionGatedCompanionTool(toolName: string): boolean {
  return VISION_GATED_COMPANION_TOOL_NAMES.includes(toolName);
}

/**
 * 一轮工具执行的环境约束（权限档之外的那一类：数据能出到哪里）。
 *
 * 只放**必须由服务端判定**的项。她的 `question`/`noteId` 是模型给的，不算约束。
 */
export interface CompanionAgentToolExecutionConstraints {
  /** 用户是否允许把图片发给外部模型（`dataPolicy.sendImageContent`）。 */
  visionEnabled?: boolean;
  /** Account opt-in plus current search-service availability. Missing means off. */
  webSearchEnabled?: boolean;
  /** The current user explicitly forbids searching or reading the note library. Missing means allowed. */
  noteLibraryReadEnabled?: boolean;
}

export const companionAgentPermissionLevelSchema = z.enum([
  "read_only",
  "guided",
  "full",
]);
export type CompanionAgentPermissionLevel = z.infer<
  typeof companionAgentPermissionLevelSchema
>;

export const companionAgentRiskClassSchema = z.enum([
  "read",
  "reversible_low",
  "consequential",
  "irreversible",
]);
export type CompanionAgentRiskClass = z.infer<typeof companionAgentRiskClassSchema>;

/**
 * **落库与广播**的工具状态（账本列 + SSE `agent.tool.status`）。
 *
 * 这个集合**不是** 40b §3.2 的全部状态，而它的**子集**：
 * 值域被数据库 CHECK 约束（`0331_companion_agent_tool_outcome_unknown.sql` 写下的八个词）
 * 与客户端节点投影（`companion-agent-nodes.ts` 的 `TOOL_STATE`）同时钉住，
 * 两边都认不出的词会落到「工具状态无法识别」。
 *
 * 所以**新增状态词不等于往这里加一行**：先确认客户端能渲染、约束能落库，
 * 否则按 `companionToolReportedStatusSchema` 报告给模型，由 worker 侧映射回来。
 */
export const companionAgentToolStatusSchema = z.enum([
  "requested",
  "executing",
  "waiting_confirmation",
  "succeeded",
  "outcome_unknown",
  "failed",
  "blocked",
  "expired",
  // 40b §3.2 的另两类调用级状态（0349 起可落库）。
  // 它们与 failed/blocked 不可互折：not_executed 要模型改参数再来一次，
  // unavailable 要它换一条能力——都压成 failed 就等于让模型在两种相反的
  // 处境里做同一件事。
  "not_executed",
  "unavailable",
]);
export type CompanionAgentToolStatus = z.infer<typeof companionAgentToolStatusSchema>;

/**
 * **报告给模型**的失败状态（40b §3.2 中落在"一次工具调用成败"上的那几类）。
 *
 * ## 为什么要与 `companionAgentToolStatusSchema` 分成两个集合
 *
 * §3.2 的表是按**下一步**分的，不是按"能不能落库"分的：
 * `not_executed`（从未开始——改对参数再来一次有意义）与
 * `unavailable`（能力这一轮没有——重调同一个工具没有意义）
 * 各自要求模型做出**不同**的动作，把它们都压成 `failed` 就等于让模型在两种
 * 相反的处境里做同一件事。
 *
 * 但它们暂时进不了账本列与 SSE：前者要一条迁移放宽 CHECK 约束，后者要客户端
 * 的 `TOOL_STATE` 给出确定性文案。两件都不是"顺手加一行枚举"的事，
 * 所以这一层先独立成合同，映射收敛在 worker 的 `companionToolLedgerStatusFor`。
 *
 * `folded/omitted` 与 `pending` 不在这里：前者是**注入面**（预算内没注入的来源），
 * 后者是**在途面**（已开始未完成、给运行身份与查询方式），都不描述这一次调用的结果。
 */
export const companionToolReportedStatusSchema = z.enum([
  "not_executed",
  "unavailable",
  "blocked",
  "failed",
  "outcome_unknown",
]);
export type CompanionToolReportedStatus = z.infer<typeof companionToolReportedStatusSchema>;

export const companionAgentStepKindSchema = z.enum([
  "model",
  "tool",
  "confirmation",
  "final",
  "error",
]);
export type CompanionAgentStepKind = z.infer<typeof companionAgentStepKindSchema>;

export const companionAgentStepStatusSchema = z.enum([
  "running",
  "succeeded",
  "waiting",
  "failed",
  "cancelled",
]);
export type CompanionAgentStepStatus = z.infer<typeof companionAgentStepStatusSchema>;

/**
 * 伴星 agent 的账号设置：权限档与可选联网搜索。
 *
 * 这里曾有 `enabledSkillIds`（勾哪些技能）。技能层不再参与工具面的发现
 * （方案 29 §4.1：每轮全给、只按权限过滤），那个开关就变成**界面上能勾、
 * 勾了没有任何效果**的东西——留着比删掉更坏，删。
 */
export const companionAgentSettingsV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  permissionLevel: companionAgentPermissionLevelSchema,
  webSearchEnabled: z.boolean().optional(),
}).strict();
export type CompanionAgentSettingsV1 = z.infer<typeof companionAgentSettingsV1Schema>;

export const companionAgentToolDefinitionV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
  toolVersion: z.string().min(1).max(40),
  description: z.string().min(1).max(800),
  parameters: z.record(z.unknown()),
  riskClass: companionAgentRiskClassSchema,
  requiresConfirmation: z.boolean(),
  confirmationStage: z.enum(["before_execute", "after_preview"]).optional(),
  // Editing carries both expected original blocks and replacement Markdown, including JSON escapes.
  maxInputChars: z.number().int().positive().nullable(),
  maxOutputChars: z.number().int().positive().nullable(),
}).strict();
export type CompanionAgentToolDefinitionV1 = z.infer<
  typeof companionAgentToolDefinitionV1Schema
>;

export const companionAgentToolEventV1Schema = z.object({
  toolCallId: z.string().min(1).max(200),
  /** A streamed preparation may resolve to an existing durable operation. */
  preparationToolCallId: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(80),
  toolVersion: z.string().min(1).max(40),
  riskClass: companionAgentRiskClassSchema,
  status: companionAgentToolStatusSchema,
  safeLabel: z.string().min(1).max(240),
  proposalId: z.string().uuid().optional(),
  safeSummary: z.string().max(240).optional(),
  /** A durable receipt, published as soon as the save commits, before the final reply. */
  noteCreated: companionCreatedNoteV1Schema.optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  noteEdit: companionEditedNoteV1Schema.optional(),
  noteAnnotation: companionWrittenAnnotationV1Schema.optional(),
  noteEditTarget: z.object({ noteId: z.string().uuid(), startBlock: z.number().int().nonnegative(), endBlock: z.number().int().nonnegative() }).strict().optional(),
  route: z.record(z.unknown()).optional(),
  /**
   * 客户端可直接执行（2026-09-19 对齐权限分级原设计）。
   *
   * 只在**用户预授权**（permissionLevel = full）且该次执行不需要确认时为 true：
   * 带 route 的读类结果客户端应立即跳转，不再要求点「前往」；chip 仍下发作为留痕。
   * 服务端是唯一的授权判定点——客户端只服从这个标志，不自行判断权限。
   */
  autoExecute: z.boolean().optional(),
}).strict();
export type CompanionAgentToolEventV1 = z.infer<typeof companionAgentToolEventV1Schema>;

export const companionAgentBudgetSnapshotV1Schema = z.object({
  maxSteps: z.number().int().positive().nullable(),
  maxToolCallsPerStep: z.number().int().positive().nullable(),
  maxToolCalls: z.number().int().positive().nullable(),
  maxModelCalls: z.number().int().positive().nullable().optional(),
  maxWebSearchCalls: z.number().int().positive().nullable().optional(),
  // Saved receipts describe the budget used then, including pre-renewal 120s runs.
  deadlineMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict();
export type CompanionAgentBudgetSnapshotV1 = z.infer<
  typeof companionAgentBudgetSnapshotV1Schema
>;

/** Exact tool surface offered to one Companion Agent run, without prompt or argument data. */
export const companionAgentCapabilitySnapshotV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  level: companionAgentPermissionLevelSchema,
  // 工具面每轮全给（§4.1），这里不给它封顶：新增能力不该先撞上这层快照校验。
  offeredTools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
    toolVersion: z.string().min(1).max(40),
    riskClass: companionAgentRiskClassSchema,
  }).strict()),
}).strict();
export type CompanionAgentCapabilitySnapshotV1 = z.infer<
  typeof companionAgentCapabilitySnapshotV1Schema
>;

/**
 * 这几条命令的**执行处在提案确认那条路**（`decideCompanionProposal` 按 payload 的 `kind`
 * 分支），worker 侧没有直执行器。
 *
 * 为什么这件事要写在权限判据里：full 档的语义是"这类动作不必每次问她"，
 * 于是 `canUseCompanionAgentTool` 会把 `requiresConfirmation` 判成 false，worker 就直接
 * 去找执行器——找不到，那一轮以一句「这一步我这边还做不了」报错。**结果是权限越高越差**：
 * guided 档这六条出提案卡（能用），full 档反而失败。这条清单就是用来堵那个反差的：
 * 命令由提案路径执行的工具，**任何一档都走提案**，worker 不去直执行它们。
 *
 * 这**不等于** full 档已经"免确认"——提案卡仍然要点一下。真正的服务端自动确认还欠着
 * （它是 39d #16 剩下的那半步，要 API 侧在自己进程里确认同一份提案，不能拿"我权限高"
 * 去绕开唯一的那个执行处）。
 */
export const COMPANION_PROPOSAL_EXECUTED_TOOLS: ReadonlySet<string> = new Set([]);

export function canUseCompanionAgentTool(
  permission: CompanionAgentPermissionLevel,
  definition: Pick<CompanionAgentToolDefinitionV1, "riskClass" | "requiresConfirmation" | "name" | "confirmationStage">,
  arguments_: Record<string, unknown> = {},
): { allowed: boolean; requiresConfirmation: boolean; reason?: string } {
  if (!companionAgentPermissionLevelSchema.safeParse(permission).success)
    return { allowed: false, requiresConfirmation: false, reason: "权限状态暂时无法确认，这次操作没有执行。" };
  if (definition.riskClass === "read" || isCompanionAutonomousTool(definition.name)
    // Turn voice controls keep the interpreter's account-scoped preference
    // semantics. Their handler requires current user wording and cannot write
    // notes, launch goals or grant any business capability.
    || ["companion_configure_turn"].includes(definition.name)
    || definition.name === "companion_send_message"
    || companionDomainActionAutoExecutes(definition.name, arguments_)
    || isCompanionAutonomousAction(definition.name, typeof arguments_.action === "string" ? arguments_.action : undefined)
    ) {
    return { allowed: true, requiresConfirmation: false };
  }
  if (companionDomainActionRequiresConfirmation(definition.name, arguments_)) {
    return { allowed: true, requiresConfirmation: true };
  }
  if (definition.confirmationStage === "before_execute" || definition.riskClass === "irreversible"
    || (definition.riskClass === "consequential" && definition.requiresConfirmation) || (definition.name === "notes.write.edit"
    && typeof arguments_.operation === "string" && arguments_.operation.startsWith("delete"))) {
    return { allowed: true, requiresConfirmation: true };
  }
  // 命令本体只在提案那条路执行的工具：直执行会撞「没有执行器」，所以 full 档也出提案。
  // 放在 guided 分支**之前**——否则 guided 只是恰好也返回 true，看不出这条规则在管什么。
  if (COMPANION_PROPOSAL_EXECUTED_TOOLS.has(definition.name)) {
    return { allowed: true, requiresConfirmation: true };
  }
  if (permission === "guided" || permission === "read_only") {
    return { allowed: true, requiresConfirmation: true };
  }
  // full = 用户预授权（2026-09-19 对齐产品原设计：权限分级就是用户的授权开关）。
  // 用户把权限开到 full，就表示"这类动作不必每次都问我"——工具直接执行，
  // 路由类结果直接自动跳转（见 companionAgentRouteEventV1.autoExecute）。
  // 安全底线只有一条：irreversible 已在上方被拦下（无论授权到哪一档都要人点头）。
  return { allowed: true, requiresConfirmation: false };
}

export function companionToolConfirmationStage(
  definition: Pick<CompanionAgentToolDefinitionV1, "riskClass" | "name" | "confirmationStage">,
  arguments_: Record<string, unknown>,
  options?: { originClientKind?: string | null },
): "after_preview" | "before_execute" {
  // 扩展 C（2026-10-15）：手机发起的回合里，笔记正文修改一律先经人确认
  // （产品规则「手机上人不改正文，伴星改」的交互面：改写建议 + 前后对照，
  // 用户确认后才经伴星通道落库）。桌面（缺省）行为不变。
  if (options?.originClientKind === "mobile" && (definition.name === "notes.write.edit"
    || (definition.name === "companion_notes_write" && arguments_.action === "edit"))) {
    return "before_execute";
  }
  if (companionDomainActionRequiresConfirmation(definition.name, arguments_)) return "before_execute";
  if (companionDomainActionAutoExecutes(definition.name, arguments_)) return "after_preview";
  return definition.confirmationStage === "before_execute" || definition.riskClass !== "reversible_low" || (definition.name === "notes.write.edit"
    && String(arguments_.operation).startsWith("delete")) ? "before_execute" : "after_preview";
}
