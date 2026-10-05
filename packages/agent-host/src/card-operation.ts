/** 在 store.invoke 的同一事务内创建领域 run，并仅绑定初始 outbox。 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  AgentStoreError, queryRows, requireVisibleInput,
} from "./store.ts";
import { projectAgentOperation, type AgentOperationRow } from "./history.ts";
import { cardAgentCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { agentInputRefV1Schema, type AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { createGenerationRunInTransaction, CardGenerationV2ServiceError, type CardGenerationRunCreationTx } from "@ailearn/card-generation";
import type { CreateCardGenerationRunRequestV2 } from "@ailearn/shared/card-generation-v2-contracts";
import type { AgentOperationStore } from "./operation-store.ts";

/** 现役制卡链的初始那一发 outbox。绑定只认这一个 jobType——审核台那几发不是它。 */
const SIMPLIFIED_OUTBOX_JOB_TYPE = "card_generation_simplified_v1";

/** 宿主读取领域创建的并发与日限额。 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** 一次调用里**影响生成**的规范参数（默认已填齐）。 */
export interface CardGenerationOptions {
  sourceScopeKind: "whole_note";
  learningGoal: string;
  detailThreshold: string;
  hardMaxCards: number;
}

/** 制卡仅允许整篇冻结材料，数量自适应且不超过八张。 */
export function cardGenerationOptions(input: {
  learningGoal?: unknown; detailThreshold?: unknown; hardMaxCards?: unknown;
}): CardGenerationOptions {
  return {
    sourceScopeKind: "whole_note",
    learningGoal: typeof input.learningGoal === "string" ? input.learningGoal : "understand",
    detailThreshold: typeof input.detailThreshold === "string" ? input.detailThreshold : "balanced",
    hardMaxCards: Math.max(1, Math.min(8, Number(input.hardMaxCards) || 8)),
  };
}

/** 同一目标与 revision 内，操作身份由材料和生成参数决定。 */
export function cardGenerationOperationKey(input: {
  noteId: string; noteVersionId: string;
  options: CardGenerationOptions;
}): string {
  return [
    "card_generation_generate", input.noteId, input.noteVersionId,
    input.options.sourceScopeKind, input.options.learningGoal,
    input.options.detailThreshold, String(input.options.hardMaxCards),
  ].join(":");
}

/** clientRequestId 使用目标、revision 和操作键的稳定哈希。 */
export function buildCardGenerationRequest(input: {
  noteVersionId: string;
  options: CardGenerationOptions;
  clientRequestId: string;
}): CreateCardGenerationRunRequestV2 {
  return {
    version: 2,
    noteVersionId: input.noteVersionId,
    sourceScope: { kind: input.options.sourceScopeKind },
    learningGoal: input.options.learningGoal as CreateCardGenerationRunRequestV2["learningGoal"],
    detailThreshold: input.options.detailThreshold as CreateCardGenerationRunRequestV2["detailThreshold"],
    quantity: { kind: "adaptive", hardMaxCards: input.options.hardMaxCards },
    clientRequestId: input.clientRequestId,
  };
}

/** 给模型看的回执形状：真实执行体 + 真实结果，不带任何内部诊断字段。 */
function projectToolResult(scope: AgentScopeV1, runId: string, row: AgentOperationRow) {
  const operation = projectAgentOperation(scope, runId, row);
  return {
    status: operation.status,
    operationId: operation.operationId,
    execution: operation.execution,
    ...(operation.result ? { result: operation.result } : {}),
  };
}

export async function invokeCardGenerationCapability(
  store: AgentOperationStore<CardGenerationRunCreationTx>,
  call: { id: string; name: string; arguments: Record<string, unknown> },
) {
  const manifest = cardAgentCapabilityManifest.find(m => m.definition.name === call.name);
  if (!manifest) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  const input = manifest.argumentSchema.parse(call.arguments) as {
    noteId: string; noteVersionId: string;
    learningGoal?: string; detailThreshold?: string; hardMaxCards?: number;
  };
  const ref = agentInputRefV1Schema.parse({ kind: "note_version", noteId: input.noteId, noteVersionId: input.noteVersionId });
  const options = cardGenerationOptions({
    learningGoal: input.learningGoal, detailThreshold: input.detailThreshold, hardMaxCards: input.hardMaxCards,
  });
  const baseKey = cardGenerationOperationKey({ noteId: ref.noteId, noteVersionId: ref.noteVersionId, options });

  return store.invoke(async (tx, run) => {
    if (store.scope.workspaceId !== run.workspace_id || store.scope.userId !== run.user_id)
      throw new AgentStoreError(403, "scope_mismatch", "这件事不在当前空间。");
    const direct = run.direct_request?.capability === call.name && run.direct_request.capability === "card_generation_generate"
      ? run.direct_request.request : null;
    const key = direct ? `${baseKey}:domain:${sha256Utf8V1(canonicalJsonV1(direct))}` : baseKey;
    // 领域幂等身份 = 目标 + revision + 规范操作键。少了前两样，同一个人在同一篇笔记
    // 上换一次要求就会复用上一个目标的领域 run/outbox——那是两次独立的工作被当成一次。
    // 取哈希而不是拼字符串：领域合同对长度有上界，截断恰好会把影响生成的参数切掉，
    // 截出来的键还会让两组不同参数撞进同一发。
    const identityHash = sha256Utf8V1(`${run.id}|${run.revision}|${key}`);
    const request = direct ? { ...direct, clientRequestId: `agent-card:${identityHash}` } : buildCardGenerationRequest({
      noteVersionId: ref.noteVersionId, options, clientRequestId: `agent-card:${identityHash}`,
    });
    const domainIdempotencyKey = `agent-card:${store.scope.workspaceId}:${identityHash}`;

    await requireVisibleInput(tx, store.scope, ref);
    if (!run.inputs.some(i => i.noteId === ref.noteId && i.noteVersionId === ref.noteVersionId))
      throw new AgentStoreError(403, "input_outside_goal", "这份材料不在当前目标范围内，请先把它交给伴星。");

    const [existing] = await queryRows<AgentOperationRow>(tx,
      sql`SELECT * FROM agent_operations
        WHERE run_id=${run.id} AND revision=${run.revision} AND tool_call_id=${key}`);
    if (existing?.card_generation_run_id) {
      return { ...projectToolResult(store.scope, run.id, existing), reused: true,
        noteId: ref.noteId, noteVersionId: ref.noteVersionId };
    }

    // 失败后换一次继续：捡回上一版已成功、且成果确实属于这一篇这一组参数的 run。
    // 只看 tool_call_id 不够——它保证参数一致，不保证成果指向的还是同一篇笔记。
    if (run.resume_from_revision) {
      const [saved] = await queryRows<AgentOperationRow>(tx, sql`
        SELECT * FROM agent_operations
        WHERE run_id=${run.id} AND revision<=${run.resume_from_revision} AND tool_call_id=${key}
          AND status='succeeded' AND result IS NOT NULL AND card_generation_run_id IS NOT NULL
        ORDER BY revision DESC LIMIT 1`);
      const reused = saved ? projectAgentOperation(store.scope, run.id, saved) : null;
      const artifact = reused?.result?.kind === "artifact" ? reused.result.artifact : null;
      if (reused && artifact?.kind === "card_candidates"
        && artifact.id === saved!.card_generation_run_id
        && artifact.noteId === ref.noteId && artifact.noteVersionId === ref.noteVersionId) {
        return { ...projectToolResult(store.scope, run.id, saved!), reused: true,
          noteId: ref.noteId, noteVersionId: ref.noteVersionId };
      }
    }

    const [count] = await queryRows<{ n: string }>(tx,
      sql`SELECT count(*) AS n FROM agent_operations WHERE run_id=${run.id}`);
    if (Number(count?.n) >= 8) throw new AgentStoreError(422, "operation_budget", "这件事已到生成上限，先保留当前结果。");

    const operationId = randomUUID();
    let created: { runId: string; status: string };
    try {
      created = await createGenerationRunInTransaction(
        tx,
        { workspaceId: store.scope.workspaceId, userId: store.scope.userId },
        ref.noteVersionId,
        request,
        domainIdempotencyKey,
        {
          maxInFlightRuns: parsePositiveIntEnv("CARD_GENERATION_V2_MAX_INFLIGHT_RUNS", 3),
          dailyRunLimit: parsePositiveIntEnv("CARD_GENERATION_V2_DAILY_RUN_LIMIT", 50),
        },
      );
    } catch (error) {
      // 领域拒绝（这篇已有在制批次、日限额、同笔记重复请求…）要**原样**带回一句人话，
      // 不能塌成「这一步没有执行」：那会让模型去重试一件领域已经明确拒绝的事。
      if (error instanceof CardGenerationV2ServiceError) {
        throw new AgentStoreError(error.statusCode, error.code, error.message);
      }
      throw error;
    }

    // 这一发初始 outbox：随 run 一起写下的那一条。Agent 只拥有它（审核台之后的新
    // outbox 不绑），worker 侧的父围栏与预算都从这一行找回来。
    const [outbox] = await queryRows<{ id: string }>(tx, sql`
      SELECT id FROM public.card_generation_run_outbox_v2
      WHERE workspace_id=${store.scope.workspaceId} AND run_id=${created.runId}
        AND job_type=${SIMPLIFIED_OUTBOX_JOB_TYPE}
      ORDER BY created_at,id LIMIT 1`);
    if (!outbox) throw new AgentStoreError(500, "card_outbox_missing", "这批学习卡没有排进生成队列，请稍后再试。");

    await tx.execute(sql`
      INSERT INTO agent_operations(id,run_id,workspace_id,user_id,revision,tool_call_id,capability,
        job_id,card_generation_run_id,card_generation_outbox_id)
      VALUES(${operationId},${run.id},${store.scope.workspaceId},${store.scope.userId},${run.revision},
        ${key},${call.name},NULL,${created.runId},${outbox.id})`);

    return {
      status: "accepted" as const,
      operationId,
      execution: { kind: "card_generation" as const, id: created.runId },
      noteId: ref.noteId,
      noteVersionId: ref.noteVersionId,
      outboxId: outbox.id,
    };
  });
}
