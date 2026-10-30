import { isCompanionAutonomousTool } from "@astella/shared/companion-autonomy";
/**
 * 伴星 agent 的**工具调用账本**（2026-09-30 拆出，B2）。
 *
 * ## 这一族是什么
 *
 * 「provider 说要调哪个工具」到「这次调用落到库里、结果是什么、要不要接着调」
 * 中间那一段：调用身份怎么收敛（`boundedToolCallIdentity`）、挡回不可信调用
 * （`recordRejectedToolCall`）、调用前后的围栏（`executeTool` / `updateToolCall`）、
 * 以及续跑时把上一轮的账读回来（`loadContinuation`）。
 *
 * 分开是因为它有**自己的一份账**：工具调用是独立的一行行，不混在事件流里。
 * 读「这一轮调用了什么、结果如何」只需要这个文件，不需要读整个 agent 运行时。
 *
 * ## 依赖方向
 *
 * 账本拒绝一次调用时会去建一条提案，所以它依赖 `companion-agent-proposal.ts`；
 * 提案**不**反向依赖账本。方向是单向的——这也是为什么提案先搬、账本后搬。
 *
 * ## 这一段是**照搬**的
 *
 * 判据、上限、账本字段一个字没改。
 */

import { randomUUID } from "node:crypto";
import { reconcileCompanionSavedNotes } from "@astella/agent-host";
import { companionEditedNoteV1Schema, companionWrittenAnnotationV1Schema } from "@astella/shared/companion-note-authoring-contracts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { sql } from "drizzle-orm";
import {
  canUseCompanionAgentTool,
  companionOperationAction,
  companionOperationDomainTool,
  companionDomainActionAutoExecutes,
  getCompanionAgentTool,
  companionToolLabel,
  type CompanionAgentToolDefinitionV1,
  type ProviderReasoningHandle,
} from "@astella/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { withWorkerWorkspaceTransaction } from "../../db.ts";
import { logger } from "../../lib/logger.ts";
import { ProviderRequestError } from "../../lib/provider-request-error.ts";
import { companionProviderFitsRequest } from "../agent/companion-provider-fit.ts";
import type { AIProvider } from "../../lib/ai-provider.ts";
import { appendAgentEvent, readRunMeta } from "../agent/companion-agent-events.ts";
import { createAgentProposal } from "../agent/companion-agent-proposal.ts";
import { prepareCompanionToolReview } from "./companion-tool-review.ts";
import { TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY } from "./companion-tool-outcome.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { companionNoteEditTarget } from "../note/companion-note-edit.ts";
import { readCreatedNoteReceipt } from "../note/companion-note-authoring.ts";
import {
  executeDirectTool,
  executeReadTool,
} from "./companion-tool-execution.ts";
import {
  CompanionToolError,
  CompanionToolBlockedError,
  CompanionToolOutcomeUnknownError,
  type AgentToolExecutionResult,
} from "./companion-tool-result.ts";

export type AgentMessage = AgentTurnRequest["messages"][number];
import { encodeCompanionToolResult, decodeCompanionToolResult, withCompanionReceiptTransaction, withCompanionRecoveryTransaction, withCompanionFailureTransaction } from "../agent/companion-runtime-checkpoint.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";

/** SSE contract bounds for provider-supplied tool-call identity. */
export const TOOL_CALL_ID_MAX_CHARS = 200;
export const TOOL_NAME_MAX_CHARS = 80;

/**
 * Provider-supplied tool-call identity is untrusted input. Bound it before it
 * reaches the audit table, the SSE contract (`toolCallId` ≤200, `name` ≤80) or
 * a tool message echoed back to the model. Returns null when unusable.
 */
export function boundedToolCallIdentity(
  call: { id: unknown; name: unknown },
): { id: string; name: string } | null {
  if (typeof call.id !== "string" || typeof call.name !== "string") return null;
  if (call.id.length === 0 || call.id.length > TOOL_CALL_ID_MAX_CHARS) return null;
  if (call.name.length === 0 || call.name.length > TOOL_NAME_MAX_CHARS) return null;
  return { id: call.id, name: call.name };
}

/**
 * steer 的提示里可以点名的工具。
 *
 * 为什么要点名而不是泛指：这个文件里已经写着"小模型对『你去调用工具』不敏感，
 * 对『调用 companion_search_notes』会照做"——可 action 那一支的提示以前就是泛指，
 * 于是"用户让她改边界，她两步只回『我记下了』"这种整轮空转一直留着（实机 2026-09-22 场景 T）。
 *
 * `consequential` 永远不点名，这是安全性质不是风格：一句纠正性提示里出现
 * `companion_start_learning`，等于系统自己把用户没要过的学习运行推上桌。
 */
/**
 * Unknown intent leaves capabilities available. The classifier sees only a
 * recent-message view, so a history/memory retrieval candidate cannot prove
 * that the complete main request lacks evidence. Let that model decide using
 * its full context. Callers pass candidates only for a read interpretation;
 * actions and other reads retain the existing required-tool contract.
 */
const CONTEXT_RETRIEVAL_TOOLS = new Set([
  "observe.history", "memory.read.past_conversation",
  "memory.read.recall", "memory.read.read",
]);
export function companionStepRequiresTool(decision: boolean | null, readCandidates?: readonly string[]): boolean {
  return decision === true && (!readCandidates?.length
    || readCandidates.some(name => !CONTEXT_RETRIEVAL_TOOLS.has(name)));
}

/**
 * 这一步的工具面与 `tool_choice`，**由同一个数组派生**。
 *
 * `tools: []` 配 `tool_choice: "required"` 是 provider 直接 400 的那一对（2026-09-22
 * 实测 3 次 INTERNAL_ERROR 里 2 次是它）。写成两个各带条件的表达式迟早分叉，
 * 而 P3-alt 之后"要工具"的轮次变多，分叉的代价会从偶发变成每轮。
 */
export function companionStepToolShape(args: {
  tools: AgentTurnRequest["tools"];
  finalAnswerOnly: boolean;
  requiresTool: boolean;
  toolCallCount: number;
  requireStructuredResponse?: boolean;
  deliveryDraftAvailable?: boolean;
}): { tools: AgentTurnRequest["tools"]; toolChoice: NonNullable<AgentTurnRequest["toolChoice"]> } {
  const tools = args.finalAnswerOnly ? [] : args.tools.map(tool => {
    if (tool.name !== "companion_finish" || args.deliveryDraftAvailable !== false) return tool;
    const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
    return { ...tool, parameters: { ...tool.parameters, required: [...new Set([...required, "text"])] } };
  });
  return {
    tools,
    // Require the protocol shape, never a particular business operation. Finish
    // is itself a valid choice for an answer from already supplied material.
    toolChoice: tools.length > 0 && (args.requireStructuredResponse
      || (args.requiresTool && args.toolCallCount === 0)) ? "required" : "auto",
  };
}

/**
 * 某些 OpenAI-compatible 端点不接受 `tool_choice: "required"`。只在 provider
 * 明确返回这一个合同错误时，才用已配置的跨模型兜底重发同一请求；其余错误仍按原
 * 路径失败，避免把鉴权、限流或网络故障误当成模型能力差异。
 */
export async function executeCompanionAgentTurnWithToolChoiceFallback(args: {
  request: AgentTurnRequest;
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  signal: AbortSignal;
  executeTurn: (provider: AIProvider, request: AgentTurnRequest, signal: AbortSignal) => Promise<AgentTurnResult>;
  onFallback?: (error: ProviderRequestError, fallbackProvider: AIProvider) => void;
}): Promise<{ result: AgentTurnResult; provider: AIProvider }> {
  if (typeof args.provider.executeAgentTurn !== "function") {
    throw new Error("provider does not support companion agent turns");
  }
  const executeTurn = args.executeTurn;
  try {
    return {
      result: await executeTurn(args.provider, args.request, args.signal),
      provider: args.provider,
    };
  } catch (error) {
    const fallback = args.fallbackProvider;
    const canRetryOnFallback = args.request.toolChoice === "required"
      && args.request.tools.length > 0
      && error instanceof ProviderRequestError
      && error.providerCode === "MODEL_TOOL_CHOICE_NOT_SUPPORTED"
      && typeof fallback?.executeAgentTurn === "function"
      && fallback !== args.provider
      && fallback.modelId !== args.provider.modelId;
    if (!canRetryOnFallback || !fallback?.executeAgentTurn
      || !await companionProviderFitsRequest(fallback, args.request)) throw error;

    args.onFallback?.(error, fallback);
    return {
      result: await executeTurn(fallback, args.request, args.signal),
      provider: fallback,
    };
  }
}

export function steerableToolNames(
  definitions: readonly { name: string; riskClass: string }[],
  kind: "lookup" | "action",
  limit = 10,
): string[] {
  const wanted = kind === "lookup" ? "read" : "reversible_low";
  return definitions.filter((definition) => definition.riskClass === wanted)
    .map((definition) => definition.name)
    .slice(0, limit);
}

/** Hash of a rejected call's arguments; never throws on odd provider payloads. */
export function safeArgumentsHash(value: unknown): string {
  try {
    return sha256Utf8V1(canonicalJsonV1(value));
  } catch {
    return sha256Utf8V1(`unserializable:${typeof value}`);
  }
}

/**
 * 审计哈希（步骤 request/result hash）。
 *
 * canonicalJsonV1 是**载荷哈希合同**（03 §2.1：只接受 finite safe integer），而
 * provider 请求天然带小数（temperature 0.9），模型自造的工具参数也可能带小数。
 * 用它哈希整个请求会让每一步都抛错——Agent loop 在真实 DB 上完全跑不通。
 *
 * 这些 hash 只进审计表（方案 §6「只记录必要的安全元数据、hash、状态、摘要和
 * 时间」），不参与任何幂等比对，因此允许在 canonical 不可用时退化到确定性 JSON
 * 串哈希；冻结语义的 payload_sha256 / arguments_sha256 仍走严格 canonical。
 */
export function auditHash(value: unknown): string {
  try {
    return sha256Utf8V1(canonicalJsonV1(value));
  } catch {
    return sha256Utf8V1(JSON.stringify(value) ?? "null");
  }
}

/**
 * Audit a tool call that never reached execution: unregistered name, invalid
 * arguments, or oversized input. The audit trail must show the attempt, but the
 * raw model-provided arguments are never persisted — only their hash and a
 * bounded safe summary (plan §6: no full provider payload, no sensitive data).
 */
export async function recordRejectedToolCall(
  event: AgentEventContext,
  stepId: string,
  identity: { id: string; name: string },
  argsHash: string,
  definition: CompanionAgentToolDefinitionV1 | null,
  // 40b §3.2 的三类"没拿到结果"：被拒绝、从未开始、能力不可用。
  // 三者在账本里必须分得开——折叠成 failed 之后 doctor 与回放就查不出
  // 真实原因，而用户看到的那句话也会失去可行动性。
  status: "blocked" | "failed" | "not_executed" | "unavailable",
  safeSummary: string,
): Promise<void> {
  await withCompanionRecoveryTransaction(event,
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO companion_agent_tool_calls
          (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id,
           name, tool_version, arguments, arguments_sha256, risk_class,
           status, result_safe_summary, updated_at)
        VALUES
          (${randomUUID()}, ${event.ctx.workspaceId}, ${event.read.userId}, ${event.read.conversationId},
           ${event.read.runId}, ${stepId}, ${identity.id}, ${identity.name},
           ${definition?.toolVersion ?? "unknown"}, '{}'::jsonb,
           ${argsHash}, ${definition?.riskClass ?? "irreversible"}, ${status}, ${safeSummary}, now())
        ON CONFLICT (run_id, tool_call_id) DO NOTHING
      `);
    },
  );
}

/**
 * 工具调用的"已放弃"标志。
 *
 * runWithAbortBudget 超时只让调用方立刻拿到错误，**不会**回滚在途的 executeTool：
 * 后者仍会继续写审计表与 SSE。超时分支置位 fence 后，迟到的执行链在写结果前
 * 必须检查它（审计表另有 status IN ('requested','executing') 的 SQL fence 兜底）。
 */
export interface ToolExecutionFence {
  abandoned: boolean;
}

export async function executeTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  call: { id: string; arguments: Record<string, unknown> },
  fence: ToolExecutionFence,
  /**
   * 子步骤预算的 AbortSignal（40b §4.1-2「向下传播 abort」）。
   *
   * 为什么不是"能取消在途 SQL"：worker 用 postgres.js 驱动，它没有逐查询的
   * AbortSignal，能做到的是**在写之前发现已经超时**。那已经能挡住真正要紧的
   * 那一类——一个被放弃的写工具继续跑完并落库。已经在途的那条查询只能等它
   * 自己回来，回来之后由下面那道迟到复查处理。
   */
  signal?: AbortSignal,
): Promise<AgentToolExecutionResult | { waiting: true; proposalId: string }> {
  let confirmedProposalId: string | undefined;
  if (event.read.initiativeInput && !(isCompanionAutonomousTool(definition.name)
    || companionDomainActionAutoExecutes(definition.name, call.arguments))
    && (definition.riskClass !== "read" || ["open.page", "open.note", "open.card"].includes(definition.name)))
    throw new CompanionToolBlockedError("这次只有内部关注，不能替用户执行业务操作。");
  let authorization = canUseCompanionAgentTool(
    (await readRunMeta(event)).permissionLevel,
    definition,
    call.arguments,
  );
  if (authorization.requiresConfirmation) {
    const rows = await withWorkerWorkspaceTransaction({ workspaceId: event.ctx.workspaceId, userId: event.read.userId },
      tx => tx.execute<{ confirmed: boolean; proposal_id: string; proposal_status: string; decision: string; proposal_kind: string }>(sql`SELECT c.proposal_id,
        p.status AS proposal_status,p.decision,p.payload->>'kind' AS proposal_kind,
        astella_companion_tool_confirmed_v1(${event.read.runId}::uuid,${call.id}) AS confirmed
        FROM companion_agent_tool_calls c LEFT JOIN companion_action_proposals p ON p.id=c.proposal_id
        WHERE c.run_id=${event.read.runId} AND c.tool_call_id=${call.id}`));
    if (rows[0]?.proposal_kind === "agent_tool_review" && rows[0].proposal_status === "accepted"
      && rows[0].decision === "confirm" && !rows[0].confirmed)
      throw new CompanionToolBlockedError("这次确认的权限、原文或运行状态已经失效，没有重复执行操作。");
    if (rows[0]?.confirmed) {
      confirmedProposalId = rows[0].proposal_id;
      authorization = { allowed: true, requiresConfirmation: false };
    }
  }
  if (!authorization.allowed) {
    await updateToolCall(event, call.id, { status: "blocked", safeSummary: authorization.reason ?? "操作被权限阻止" });
    // `reason` 缺失时的兜底也会当 safeSummary 上屏（渲染层原样取用），所以这句同样是写给用户的。
    throw new CompanionToolBlockedError(authorization.reason ?? "这一步超出了你给伴星的权限，我先不做");
  }
  if (authorization.requiresConfirmation) {
    const payload = await prepareCompanionToolReview(event, definition, call.arguments);
    if (!payload) throw new CompanionToolError("这一步现在做不了（要做的那件东西已经不在了）");
    const proposal = await createAgentProposal(event, definition, call, payload);
    await appendAgentEvent(event, "agent.tool", {
      tool: {
        toolCallId: call.id,
        name: definition.name,
        toolVersion: definition.toolVersion,
        riskClass: definition.riskClass,
        status: "waiting_confirmation",
        safeLabel: companionToolLabel(definition.name) ?? definition.description.slice(0, 240),
        proposalId: proposal.proposalId,
        safeSummary: proposal.safeSummary,
      },
    });
    return { waiting: true, proposalId: proposal.proposalId };
  }
  if (!await updateToolCall(event, call.id, { status: "executing" })) {
    throw new CompanionToolOutcomeUnknownError(TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY);
  }
  await appendAgentEvent(event, "agent.tool", {
    tool: {
      toolCallId: call.id,
      name: definition.name,
      toolVersion: definition.toolVersion,
      riskClass: definition.riskClass,
      status: "executing",
      ...(confirmedProposalId ? { proposalId: confirmedProposalId } : {}),
      ...(definition.name === "notes.write.edit" ? { noteEditTarget: companionNoteEditTarget(call.arguments, event.read.pageContext) } : {}),
      safeLabel: companionToolLabel(definition.name) ?? definition.description.slice(0, 240),
    },
  });
  // 读类走既有 read 执行器；其余工具通过本轮授权与能力定义的确认判据后直执行。
  // Low-permission writes reach this point only with one frozen user decision.
  const result = definition.riskClass === "read"
    ? await executeReadTool(event, definition, call.arguments)
    : await executeDirectTool(event, definition, call.arguments, signal, call.id);
  // 超时已被判定的调用不再写 succeeded（审计表由 SQL fence 兜底，这里同时
  // 阻止迟到的 succeeded SSE 事件覆盖已下发的 failed）。
  if (fence.abandoned) return result;
  const recorded = await updateToolCall(event, call.id, {
    status: "succeeded",
    safeSummary: result.safeSummary,
    resultRef: result.resultRef ?? (result.route ? JSON.stringify(result.route) : undefined),
    resultPayload: result,
  });
  // Recovery may have changed an interrupted write to outcome_unknown while
  // this process was still finishing. Do not publish a late success over it.
  //
  // 2026-10-01：这里原本是 `if (!recorded) return result;`——**账本说
  // outcome_unknown，模型却被告知 ok:true**。40b §6.4 明令「禁止把 fail-closed
  // 解释成静默成功」：账本是业务合同，它这一写没落下来，就没人能证明这次调用
  // 发生过。工具本身的业务结果也许是真的，但**不能拿它当回执**。
  //
  // 所以这里抛，让上层走同一条失败路径：模型拿到 `ok:false` + 确定状态，
  // SSE 与审计行也就说同一句话。抛的是**不继承** CompanionToolError 的那一类，
  // 否则会被 `classifyCompanionToolFailure` 归成 failed（= 确定没发生）。
  if (!recorded) throw new CompanionToolOutcomeUnknownError(TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY);
  // 迟到复查（40b §4.1-2「迟到结果在提交前复查取消、租约、权限和内容版本」）。
  //
  // 上面那道 fence 只覆盖"超时那一刻已经知道"的情形；这一支覆盖"调用方在预算
  // 到期之后才把 signal 断掉"的路径。两者都不该让一次**结果不确定**的写被说成成功。
  if (signal?.aborted) throw new CompanionToolOutcomeUnknownError(TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY);
  // autoExecute（2026-09-19 对齐权限分级原设计）：full = 用户预授权，路由类结果
  // 客户端应直接执行，不再等「前往」。授权判定只在服务端做，客户端只服从标志。
  const permissionLevel = (await readRunMeta(event)).permissionLevel;
  const autoExecute = result.route !== undefined && permissionLevel === "full";
  const noteCreated = definition.name === "notes.write.create" ? readCreatedNoteReceipt(result.resultRef ?? null) : null;
  await appendAgentEvent(event, "agent.tool", {
    tool: {
      toolCallId: call.id,
      name: definition.name,
      toolVersion: definition.toolVersion,
      riskClass: definition.riskClass,
      status: "succeeded",
      ...(confirmedProposalId ? { proposalId: confirmedProposalId } : {}),
      ...(definition.name === "notes.write.edit" && result.resultRef ? { noteEdit: companionEditedNoteV1Schema.parse(JSON.parse(result.resultRef)) } : {}),
      ...(definition.name === "notes.write.annotate" && result.resultRef ? { noteAnnotation: companionWrittenAnnotationV1Schema.parse(JSON.parse(result.resultRef)) } : {}),
      safeLabel: companionToolLabel(definition.name) ?? definition.description.slice(0, 240),
      safeSummary: result.safeSummary,
      occurredAt: new Date().toISOString(),
      ...(noteCreated ? { noteCreated } : {}),
      ...(result.route ? { route: result.route } : {}),
      ...(autoExecute ? { autoExecute: true } : {}),
    },
  });
  return result;
}

export async function updateToolCall(
  event: AgentEventContext,
  toolCallId: string,
  patch: { status: string; proposalId?: string; resultRef?: string; safeSummary?: string; resultPayload?: AgentToolExecutionResult },
): Promise<boolean> {
  // 终态回执落的是"已经发生的事实"（**含成功的工具回执**），走事实回执事务：
  // 仍挡被替换的 job／租约／代际／账号纪元，但不再重新断言运行开始时冻结的上下文。
  // 成功的回执也必须这样，否则会自锁：她改自己的记录（如 companion_write_self_note）
  // 之后当前版本天然不同于冻结时的 revision，而"本轮自己有成功回执"那条豁免要读的
  // 正是这个事务即将写入的 status='succeeded'（断言跑在 UPDATE 之前）。
  // `executing` 是**在工具跑之前**写的，那时上下文还没被这次调用改变，照旧走恢复事务。
  const terminal = ["succeeded", "failed", "outcome_unknown", "blocked", "not_executed", "unavailable"].includes(patch.status);
  const write = terminal ? withCompanionReceiptTransaction : withCompanionRecoveryTransaction;
  return write(event,
    async (tx) => {
      const updated = await tx.execute<{ tool_call_id: string; proposal_id: string | null }>(sql`
        UPDATE companion_agent_tool_calls
        SET status = ${patch.status},
            proposal_id = COALESCE(${patch.proposalId ?? null}, proposal_id),
            result_ref = COALESCE(${patch.resultRef ?? null}, result_ref),
            result_safe_summary = COALESCE(${patch.safeSummary ?? null}, result_safe_summary),
            result_payload = COALESCE(${patch.resultPayload ? JSON.stringify(encodeCompanionToolResult(patch.resultPayload)) : null}::jsonb,result_payload),
            updated_at = now()
        WHERE run_id = ${event.read.runId} AND tool_call_id = ${toolCallId}
          -- 单调状态机：只有未终结的调用可被推进。工具执行超时后，在途事务
          -- 迟到的 succeeded 不得把已判定 outcome_unknown/failed/blocked 的审计行改回去
          -- （否则审计表与发给模型/客户端的 tool result 互相矛盾）。
          AND status IN ('requested', 'executing')
        RETURNING tool_call_id, proposal_id
      `);
      const proposalId = updated[0]?.proposal_id;
      if (patch.status === "succeeded" && proposalId) {
        // Commit the confirmed card and complete tool receipt together. A crash
        // between separate commits must not leave a successful write "pending".
        await tx.execute(sql`UPDATE companion_action_proposals SET status='succeeded',result_ref=${toolCallId},
          result_safe_summary=${patch.safeSummary ?? null},
          result_route=${JSON.stringify(patch.resultPayload?.route ?? null)}::jsonb,updated_at=now()
          WHERE id=${proposalId}::uuid AND agent_run_id=${event.read.runId}
            AND status='accepted' AND decision='confirm'`);
      }
      return updated.length > 0;
    },
  );
}

/**
 * 这一轮**真正写成**的操作名（只读调用不算）。
 *
 * 失败面要说清"什么没完成"，前提是先知道什么已经完成了：引文核对不过会让整轮判失败，
 * 但同一轮里已落库的写操作不会因为终答被丢弃而回滚。只回一句"答复没有完成"，就等于
 * 把她已经做成的事报成没做（2026-10-12 真窗实测：`companion_save_memory` 与
 * `companion_write_self_note` 都是 succeeded，界面上却是"答复没有完成"）。
 *
 * 判据取账本里的 `risk_class`，不另写一份"哪些工具算写"的名单——那份名单已经有
 * 权限档、提案路由、chip 文案三处在读账本，再加一处就是第四份真相。
 */
export async function listSucceededWriteToolNames(
  input: { workspaceId: string; userId: string },
  runId: string,
): Promise<string[]> {
  return withWorkerWorkspaceTransaction(input, async (tx) => {
    const rows = await tx.execute<{ name: string }>(sql`
      SELECT DISTINCT name FROM companion_agent_tool_calls
      WHERE run_id = ${runId} AND status = 'succeeded' AND risk_class <> 'read'
      ORDER BY name
    `);
    return rows.map((row) => row.name);
  });
}

export type AgentToolCallRecord = {
  isNew: boolean;
  /** 已冻结业务操作对应的原始调用 id；重试可换 provider call id。 */
  toolCallId: string;
  status: string;
  proposalId: string | null;
  resultRef: string | null;
  safeSummary: string | null;
  resultPayload?: AgentToolExecutionResult | null;
};

/**
 * Create the durable tool-call fence before execution. A retry of the same
 * provider call must consume the recorded result instead of executing again.
 * A different provider call id with the same run/tool/argument fingerprint also
 * reuses terminal outcomes, including `outcome_unknown`, rather than submitting again.
 *
 * 导出仅为可测：写入 reasoning 句柄的 SQL 只有这里一处，类型检查覆盖不到
 * 列名/参数绑定，需要实库往返验证（写 → loadContinuation 读回）。
 */
export async function ensureAgentToolCall(
  event: AgentEventContext,
  stepId: string,
  definition: CompanionAgentToolDefinitionV1,
  call: { id: string; arguments: Record<string, unknown> },
  argsHash: string,
  /**
   * 本轮的 provider 不透明 reasoning item。落库是为了让「用户确认 → 新 job 续跑」
   * 能从数据反建出带句柄的 assistant 消息（见 loadContinuation）。非思考模型为 undefined。
   * 2026-10-14 起含明文思维链：网关在思考模式下要求交回它，只带 encrypted_content
   * 会 400（0435 解除"明文不落库"约束，同一份原文三发实测见 probe-plaintext-reasoning.ts）。
   */
  reasoning?: ProviderReasoningHandle[],
): Promise<AgentToolCallRecord> {
  return withCompanionRecoveryTransaction(event,
    async (tx) => {
      type ExistingCallRow = {
        status: string;
        name: string;
        tool_call_id: string;
        proposal_id: string | null;
        result_ref: string | null;
        result_safe_summary: string | null;
        arguments_sha256: string;
        result_payload: unknown;
      };
      const readByCallId = (toolCallId = call.id) => tx.execute<ExistingCallRow>(sql`
        SELECT status, name, tool_call_id, proposal_id, result_ref, result_safe_summary, arguments_sha256, result_payload
        FROM companion_agent_tool_calls
        WHERE run_id = ${event.read.runId} AND tool_call_id = ${toolCallId}
        LIMIT 1
      `);
      const recordFromRow = (row: ExistingCallRow): AgentToolCallRecord => ({
        isNew: false,
        toolCallId: row.tool_call_id,
        status: row.status,
        proposalId: row.proposal_id,
        resultRef: row.result_ref,
        safeSummary: row.result_safe_summary,
        ...(row.result_payload == null ? {} : { resultPayload: decodeCompanionToolResult(row.result_payload) }),
      });
      const blockedRecord = (): AgentToolCallRecord => ({
        isNew: false,
        toolCallId: call.id,
        status: "blocked",
        proposalId: null,
        resultRef: null,
        safeSummary: "重复工具调用的参数与已冻结记录不一致，已阻止重放",
      });
      const reuseRow = async (source: ExistingCallRow): Promise<AgentToolCallRecord> => {
        let row = source;
        if (row.arguments_sha256 !== argsHash || row.name !== definition.name) {
          return blockedRecord();
        }
        if (["notes.write.create", "notes.write.edit"].includes(definition.name) && ["executing", "outcome_unknown"].includes(row.status)) {
          const checked = await reconcileCompanionSavedNotes(tx, { workspaceId: event.ctx.workspaceId,
            userId: event.read.userId, runId: event.read.runId }, row.tool_call_id);
          if (checked.resolved.length) {
            const [saved] = await readByCallId(row.tool_call_id);
            if (saved) row = saved;
          }
        }
        // A process can die after a write entered execution. On recovery the
        // old transaction may have committed, so preserve uncertainty instead
        // of replaying the operation. Reads remain safe to retry.
        if (row.status === "executing" && definition.riskClass !== "read") {
          const markedUnknown = await tx.execute<{ tool_call_id: string }>(sql`
            UPDATE companion_agent_tool_calls
            SET status = 'outcome_unknown',
                result_safe_summary = ${TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY},
                updated_at = now()
            WHERE run_id = ${event.read.runId}
              AND tool_call_id = ${row.tool_call_id}
              AND status = 'executing'
            RETURNING tool_call_id
          `);
          if (markedUnknown[0]) {
            row = { ...row, status: "outcome_unknown", result_safe_summary: TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY };
          } else {
            const latest = await readByCallId(row.tool_call_id);
            if (latest[0]) row = latest[0];
          }
        }
        return recordFromRow(row);
      };

      const existingById = await readByCallId();
      if (existingById[0]) return reuseRow(existingById[0]);

      if (definition.riskClass !== "read") {
        // Provider 重试可能给同一写操作换一个 call id。用稳定的 run + 工具名 +
        // 参数指纹串行化登记过程，再复用已完成、等确认或结果不明的账本行。
        // 只读调用不做这层折叠：相同查询可在同一轮再次读取最新状态。
        const operationLockKey = `companion-agent-tool:${event.read.runId}:${definition.name}:${argsHash}`;
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${operationLockKey}, 0))
        `);
        // 同 call id、不同参数的并发请求使用不同 operation lock；第二次检查避免它们
        // 在第一次提交后落到下面的业务操作去重分支，掩盖 call-id 冲突。
        const existingAfterLock = await readByCallId();
        if (existingAfterLock[0]) return reuseRow(existingAfterLock[0]);
        const settledOperation = await tx.execute<ExistingCallRow>(sql`
          SELECT status, name, tool_call_id, proposal_id, result_ref, result_safe_summary, arguments_sha256, result_payload
          FROM companion_agent_tool_calls
          WHERE run_id = ${event.read.runId}
            AND name = ${definition.name}
            AND arguments_sha256 = ${argsHash}
            AND (status IN ('requested', 'executing', 'succeeded', 'waiting_confirmation', 'outcome_unknown')
              OR (status='not_executed' AND proposal_id IN (SELECT id FROM companion_action_proposals
                WHERE agent_run_id=${event.read.runId} AND decision='reject')))
          ORDER BY created_at ASC
          LIMIT 1
        `);
        const settled = settledOperation[0];
        if (settled) return reuseRow(settled);
      }

      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO companion_agent_tool_calls
          (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id,
           name, tool_version, arguments, arguments_sha256, risk_class, status,
           reasoning_handles)
        VALUES
          (${randomUUID()}, ${event.ctx.workspaceId}, ${event.read.userId}, ${event.read.conversationId},
           ${event.read.runId}, ${stepId}, ${call.id}, ${definition.name}, ${definition.toolVersion},
           ${JSON.stringify(call.arguments)}, ${argsHash},
           ${definition.riskClass}, 'requested',
           ${reasoning && reasoning.length > 0 ? JSON.stringify(reasoning) : null}::jsonb)
        ON CONFLICT (run_id, tool_call_id) DO NOTHING
        RETURNING id
      `);
      if (inserted[0]) {
        return {
          isNew: true,
          toolCallId: call.id,
          status: "requested",
          proposalId: null,
          resultRef: null,
          safeSummary: null,
        };
      }
      const existing = await readByCallId();
      const row = existing[0];
      return row ? reuseRow(row) : blockedRecord();
    },
  );
}

/**
 * 从冻结的确认提案反建续跑消息（用户确认 → 新 job）。
 *
 * 导出仅为可测：这是「冷启动续跑是否带回 reasoning 句柄」的唯一实现点，
 * 而 runCompanionDialogue 没有 provider 注入缝，无法从外层断言消息形状。
 */
/** Rebuild the model-facing domain call from a frozen ledger operation row. */
function domainCallArguments(operation: string, arguments_: Record<string, unknown>): Record<string, unknown> {
  const action = companionOperationAction(operation);
  return action === null ? arguments_ : { action, ...arguments_ };
}

export async function loadContinuation(
  event: AgentEventContext,
  baseMessages: AgentMessage[],
  proposalId: string,
  deadlineAt = Infinity,
  recovery?: { pendingCallId: string; onExecution: (result: AgentToolExecutionResult) => void },
): Promise<AgentMessage[]> {
  const rows = await withWorkerWorkspaceTransaction(
    { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
    (tx) => tx.execute<{
      tool_call_id: string;
      name: string;
      arguments: Record<string, unknown>;
      result_ref: string | null;
      result_safe_summary: string | null;
      result_payload: unknown;
      status: string;
      decision: string | null;
      reasoning_handles: ProviderReasoningHandle[] | null;
      proposal_status: string;
      proposal_payload: { kind?: string };
      step_id: string;
    }>(sql`
      SELECT tc.tool_call_id, tc.name, tc.arguments, tc.result_ref,
             tc.result_safe_summary, tc.result_payload, tc.status, p.decision, tc.reasoning_handles,
             p.status AS proposal_status,p.payload AS proposal_payload,tc.step_id
      FROM companion_agent_tool_calls tc
      JOIN companion_action_proposals p ON p.id = tc.proposal_id
      WHERE tc.run_id = ${event.read.runId} AND p.id = ${proposalId}
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row || (row.decision !== "confirm" && row.decision !== "reject")) {
    throw new Error("agent continuation proposal is not decided");
  }
  let execution = decodeCompanionToolResult(row.result_payload);
  if (row.decision === "confirm" && row.proposal_payload?.kind === "agent_tool_review"
    && row.proposal_status === "accepted" && row.status === "requested") {
    const definition = getCompanionAgentTool(row.name);
    if (!definition) throw new CompanionToolError("这项能力已经不可用，确认的改动没有执行。");
    const { runCompanionToolExecution } = await import("./companion-tool-execution-run.ts");
    // The ledger stores only the fields this operation's executor accepts. The
    // dispatcher needs the action back, or every confirmed card dies on
    // "没有说明要执行哪一类动作" after the user has already said yes.
    const run = await runCompanionToolExecution({ event, definition, arguments: domainCallArguments(row.name, row.arguments),
      operationCallId: row.tool_call_id, toolCallId: row.tool_call_id, reviewProposalId: proposalId,
      deadlineAt, signal: event.ctx.signal, runId: event.read.runId,
      logger });
    if (run.kind === "waiting") throw new CompanionToolError("确认状态已变化，没有重复执行这次操作。");
    row.status = run.kind === "success" ? "succeeded" : run.ledgerStatus;
    row.result_safe_summary = run.kind === "success" ? run.execution.safeSummary : run.safeSummary;
    row.result_ref = run.kind === "success" ? run.execution.resultRef ?? null : null;
    if (run.kind === "success") execution = run.execution;
    // 确认落地之后的收尾同样是"事实回执"：成功那一支不再重新断言冻结上下文
    // （理由见 updateToolCall；确认的写已经发生，回执必须落得下来）。
    const finish = run.kind === "failure" ? withCompanionFailureTransaction : withCompanionReceiptTransaction;
    await finish(event, async tx => {
      await tx.execute(sql`UPDATE companion_agent_steps SET status=${run.kind === "success" ? "succeeded" : "failed"},finished_at=now()
        WHERE id=${row.step_id}::uuid AND status='waiting'`);
      if (run.kind === "failure") await tx.execute(sql`UPDATE companion_action_proposals SET status='failed',
        result_safe_summary=${run.safeSummary},updated_at=now() WHERE id=${proposalId}::uuid AND status='accepted'`);
    });
  }
  const toolResult = row.decision === "confirm" && row.status === "succeeded"
    ? { ok: true, summary: row.result_safe_summary ?? "操作已完成", resultRef: row.result_ref,
      ...(execution ? { data: execution.value } : {}) }
    : { ok: false, status: row.status, summary: row.decision === "reject"
      ? "用户取消了这次预览或操作，原内容保持当前状态；不要重新执行或自动再次提出这次写入。"
      : row.result_safe_summary ?? "操作尚未得到保存回执，请先核对结果。" };
  if (recovery) {
    const index = baseMessages.findIndex(message => message.role === "tool" && message.toolCallId === recovery.pendingCallId);
    // The pending call may be named by its operation or by the domain tool it
    // belongs to; both identify the same frozen call.
    const domainName = companionOperationDomainTool(row.name) ?? row.name;
    const pendingName = baseMessages.find(message => message.role === "assistant"
      && message.toolCalls?.some(call => call.id === recovery.pendingCallId))?.toolCalls
      ?.find(call => call.id === recovery.pendingCallId)?.name;
    if (index < 0 || (pendingName !== row.name && pendingName !== domainName))
      throw new CompanionContextChangedError();
    const finish = row.status === "succeeded" ? withCompanionRecoveryTransaction : withCompanionFailureTransaction;
    await finish(event, async tx => {
      await tx.execute(sql`UPDATE companion_agent_steps
        SET status=${row.decision === "reject" ? "cancelled" : row.status === "succeeded" ? "succeeded" : "failed"},finished_at=now()
        WHERE id=${row.step_id}::uuid AND run_id=${event.read.runId} AND status='waiting'`);
    });
    if (row.decision === "confirm" && row.status === "succeeded" && execution) recovery.onExecution(execution);
    return baseMessages.map((message, position) => position === index ? { ...message, content: JSON.stringify(toolResult) } : message);
  }
  // 续跑是新 job：首轮 reasoning 已不在内存里，只能从列里取回，否则要求回传
  // reasoning 的模型（deepseek 思考模式）会在这一步 400。0218 之前创建的历史
  // 待确认提案该列为 NULL，只能不带句柄续跑（muse-spark/grok-4.6 正常，
  // deepseek 以非重试 400 失败）。
  const reasoning = row.reasoning_handles;
  return [
    ...baseMessages,
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: row.tool_call_id, name: companionOperationDomainTool(row.name) ?? row.name,
        arguments: domainCallArguments(row.name, row.arguments) }],
      ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
    },
    {
      role: "tool",
      toolCallId: row.tool_call_id,
      content: JSON.stringify(toolResult),
    },
  ];
}
