import { z } from "zod";
import { sql } from "drizzle-orm";
import { agentTurnRequestSchema, agentTurnResultSchema, companionContentBlockV1Schema } from "@astella/shared";
import { stableStringify, sha256Utf8V1 } from "@astella/shared/content-hash";
import { lockCompanionRunForEventWrite } from "@astella/shared/companion-lock-order";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../../db.ts";
import { lockJobLease, JobLeaseLostError } from "../../lib/job-lease.ts";
import { CompanionContextChangedError } from "../../lib/non-retryable-errors.ts";
import { assertCompanionContextSourcesCurrent } from "../context/companion-context-sources.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";
import type { AgentToolExecutionResult } from "../tools/companion-tool-result.ts";

const count = z.number().int().nonnegative().safe();
export const companionRuntimeStateSchema = z.object({
  messages: agentTurnRequestSchema.shape.messages,
  compactedEvidence: agentTurnRequestSchema.shape.messages,
  stepCount: count, toolCallCount: count, elapsedMs: count,
  visibleSegments: z.array(z.string()), visibleSegmentDelivered: z.array(z.boolean()),
  richBlocks: z.array(companionContentBlockV1Schema),
  webSearchCalls: count, historyFoldApplied: z.boolean(),
  invalidArgumentCalls: z.array(z.string()), rejectedExecutionConstraints: z.array(z.string()),
  degenerateRetried: z.boolean(), outputRepairToolCount: count.nullable(),
  requirementCorrections: z.array(z.string()).default([]),
  actionSteerAttempts: count, quoteCorrectionUsed: z.boolean(), lookupClaimSteered: z.boolean(),
  steerSwapToFallback: z.boolean(), utterancePublished: z.boolean(),
  protocolFallback: z.boolean().default(false),
  /** Extra tools the model expanded via companion_load_tools. Default keeps old checkpoints readable. */
  loadedToolNames: z.array(z.string()).default([]),
  entryMode: z.enum(["classified", "direct_fast", "direct_thinking", "hybrid"]).default("classified"),
  deepened: z.boolean().default(false),
}).strict().refine(state => state.visibleSegments.length === state.visibleSegmentDelivered.length);
export type CompanionRuntimeState = z.infer<typeof companionRuntimeStateSchema>;
const completedSchema = z.object({ status: z.literal("completed"), text: z.string(),
  blocks: z.array(companionContentBlockV1Schema), memoryRefs: z.array(z.unknown()),
  // 交付闸要的权威事实（本轮是否真落下写回执）要跟着终答一起过检查点：
  // 少这一行，`finishBoundary` 编码快照时 strict() 直接抛 `unrecognized_keys`，每一轮都跑不完。
  writesLanded: z.boolean().optional(),
  reasoning: agentTurnResultSchema.shape.reasoning,
}).strict();
const snapshotSchema = z.object({ phase: z.enum(["input", "continue", "waiting", "settled"]), state: companionRuntimeStateSchema,
  proposalId: z.string().uuid().optional(), pendingCallId: z.string().min(1).max(200).optional(),
  result: completedSchema.optional() }).strict().refine(value => (value.phase === "settled") === Boolean(value.result)
    && (value.phase === "waiting") === Boolean(value.proposalId && value.pendingCallId)
    && (value.phase === "waiting" || (!value.proposalId && !value.pendingCallId)));
export type CompanionRuntimeSnapshot = z.infer<typeof snapshotSchema>;
const envelopeSchema = z.object({ version: z.literal(1), identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  stateJson: z.string(), stateSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type CompanionRuntimeCheckpoint = z.infer<typeof envelopeSchema>;
const toolResultSchema = z.object({ value: z.record(z.unknown()), safeSummary: z.string(), resultRef: z.string().optional(),
  route: z.record(z.unknown()).optional(), routeLabel: z.string().optional(), blocks: z.array(companionContentBlockV1Schema).optional() }).strict();
export function encodeCompanionToolResult(result: AgentToolExecutionResult) {
  const json = stableStringify(toolResultSchema.parse(result));
  return { version: 1, json, sha256: sha256Utf8V1(json) };
}
export function decodeCompanionToolResult(value: unknown): AgentToolExecutionResult | null {
  if (value == null) return null;
  const parsed = z.object({ version: z.literal(1), json: z.string(), sha256: z.string() }).strict().safeParse(value);
  if (!parsed.success || sha256Utf8V1(parsed.data.json) !== parsed.data.sha256) throw new CompanionContextChangedError();
  try { return toolResultSchema.parse(JSON.parse(parsed.data.json)); } catch { throw new CompanionContextChangedError(); }
}

export function encodeCompanionRuntimeCheckpoint(identity: unknown, snapshot: CompanionRuntimeSnapshot): CompanionRuntimeCheckpoint {
  const stateJson = stableStringify(snapshotSchema.parse(snapshot));
  return { version: 1, identitySha256: sha256Utf8V1(stableStringify(identity)), stateJson, stateSha256: sha256Utf8V1(stateJson) };
}
export function decodeCompanionRuntimeCheckpoint(value: unknown, identity: unknown): CompanionRuntimeSnapshot | null {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.identitySha256 !== sha256Utf8V1(stableStringify(identity))
    || sha256Utf8V1(parsed.data.stateJson) !== parsed.data.stateSha256) return null;
  try { return snapshotSchema.parse(JSON.parse(parsed.data.stateJson)); } catch { return null; }
}

export function withCompanionRecoveryTransaction<T>(event: AgentEventContext,
  run: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
  return withCompanionOwnedTransaction(event, run, true);
}

/** Failure receipts do not authorize execution. They may close owned work after
 * context/permission invalidation, but can never cross a replaced job or lease. */
export function withCompanionFailureTransaction<T>(event: AgentEventContext,
  run: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
  return withCompanionOwnedTransaction(event, run, false);
}

/**
 * 已经发生的事实回执（失败**或执行成功后的成功回执**）。
 *
 * 与失败事务同形：仍然挡被替换的 job／租约／代际／账号纪元，但不再重新断言
 * 「运行开始时冻结的上下文还成立」。理由：落一条"这一步已经这样了"的账不是新授权。
 *
 * 成功的工具回执也必须走这一支，否则会自锁：`companion_write_self_note` 这类
 * 「她改自己的记录」写完之后，当前版本天然不同于冻结时的 `revision`；而
 * `assertCompanionContextSourcesCurrent` 里那条"本轮自己有成功回执"的豁免要读的
 * 正是这个事务即将写入的 `status='succeeded'`——断言在 UPDATE 之前跑，豁免永远
 * 来不及成立，于是**写成功反而把自己判成 CONTEXT_STALE**（2026-10-16 实库复现）。
 */
export function withCompanionReceiptTransaction<T>(event: AgentEventContext,
  run: (tx: WorkerTransaction) => Promise<T>): Promise<T> {
  return withCompanionOwnedTransaction(event, run, false);
}

async function withCompanionOwnedTransaction<T>(event: AgentEventContext,
  run: (tx: WorkerTransaction) => Promise<T>, requireCurrentContext: boolean): Promise<T> {
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  try {
    return await withWorkerWorkspaceTransaction(scope, async tx => {
      await lockCompanionRunForEventWrite(tx, event.read.runId);
      await lockJobLease(tx, requireCurrentContext ? event.ctx : { ...event.ctx, signal: undefined });
      if (requireCurrentContext) await assertCompanionContextSourcesCurrent(tx, scope, event.read.runId);
      const [active] = await tx.execute(sql`SELECT r.id FROM companion_turn_runs r
        WHERE r.id=${event.read.runId} AND r.workspace_id=${scope.workspaceId} AND r.user_id=${scope.userId}
          AND (r.job_id IS NULL OR r.job_id=${event.ctx.id})
          AND r.generation=${event.read.generation} AND r.account_epoch=${event.read.accountEpoch}
          AND (${!requireCurrentContext} OR (r.status IN ('accepted','running')
            AND EXISTS (SELECT 1 FROM user_companion_account_state a
              WHERE a.user_id=r.user_id AND a.epoch=r.account_epoch AND a.global_enabled)))`);
      if (!active) throw new CompanionContextChangedError();
      return run(tx);
    });
  } catch (error) {
    if (error instanceof JobLeaseLostError || error instanceof CompanionContextChangedError) throw error;
    // 这句 "private recovery storage unavailable" 原本会把**任何**内部异常都盖成存储坏了
    // （2026-10-16 本地主动轮全挂，真因是一条校验错误，被这句挡了三轮排查）。
    // 消息照旧给外面，真凶挂成 cause，别再让人猜。
    throw new Error("companion private recovery storage unavailable", { cause: error });
  }
}

export function loadCompanionRuntimeCheckpoint(event: AgentEventContext, identity: unknown) {
  return withCompanionRecoveryTransaction(event, async tx => {
    const [row] = await tx.execute<{ id: string; status: string; runtime_checkpoint: unknown }>(sql`
      SELECT id,status,runtime_checkpoint FROM companion_agent_steps WHERE run_id=${event.read.runId}
        AND workspace_id=${event.ctx.workspaceId} AND user_id=${event.read.userId}
      ORDER BY step_no DESC LIMIT 1`);
    if (!row?.runtime_checkpoint) return null;
    const snapshot = decodeCompanionRuntimeCheckpoint(row.runtime_checkpoint, identity);
    // Existing private state must not silently reset into an empty execution.
    // A decided proposal can close its step before the next input commits.
    // Its waiting transcript still replays the ledger's actual decision/result.
    if (!snapshot || (snapshot.phase === "input" && row.status !== "running")) throw new CompanionContextChangedError();
    return { ...snapshot, stepId: row.id };
  });
}
export async function saveCompanionRuntimeInput(event: AgentEventContext, stepId: string, checkpoint: CompanionRuntimeCheckpoint) {
  await withCompanionRecoveryTransaction(event, async tx => {
    const [saved] = await tx.execute(sql`UPDATE companion_agent_steps SET runtime_checkpoint=${JSON.stringify(checkpoint)}::jsonb
      WHERE id=${stepId} AND run_id=${event.read.runId} AND status='running' RETURNING id`);
    if (!saved) throw new CompanionContextChangedError();
    // The new input contains the complete current transcript. Retain one
    // authoritative working state rather than copying long history per step.
    await tx.execute(sql`UPDATE companion_agent_steps SET runtime_checkpoint=NULL
      WHERE run_id=${event.read.runId} AND id<>${stepId}
        AND step_no<(SELECT step_no FROM companion_agent_steps WHERE id=${stepId})`);
  });
}
