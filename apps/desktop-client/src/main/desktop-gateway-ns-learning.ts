/**
 * 网关的「学习运行（学习轮次 / 草稿 / 产物）」那一族 —— **2026-09-30 从 `DesktopGateway` 类搬出**。
 *
 * ## 为什么它们现在能搬
 *
 * AST 实测：这一族对类状态的依赖**只剩同命名空间内部**。而且 5 个私有助手
 * **只被同族方法使用**——助手与通道方法整族一起搬；分开搬等于把它们拆散。
 *
 * 下面**逐字搬移**：成员由脚本按 TS AST 的精确源区间从 `desktop-gateway.ts`
 * 切出，只做三处改写——签名前加 `t: GatewayTransport`、`this.transport.` 换成 `t.`、
 * 同族方法互相调用改成直接按函数名。
 */
import {
  DesktopGatewayFailure,
} from "./desktop-gateway-failure";
import {
  GatewayTransport as GatewayTransportFromDesktopgatewaytransport,
} from "./desktop-gateway-transport";
import {
  safeUuid,
} from "./desktop-gateway-uuid";
import {
  DesktopCreateLearningRunV2Request,
  DesktopLearningRunAbandonRequestV2,
  DesktopLearningRunActionRequestV2,
  DesktopPutLearningTaskDraftV2Request,
  DesktopRecordLearningRunActivityLeaseRequestV2,
  DesktopSubmitTaskArtifactV2,
  recordLearningRunActivityLeaseOutputV2Schema,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  getLearningRunResultResponseV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  learningRunReturnContractV2Schema,
  learningRunTargetRevealV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared/learning-run-v2-contracts";
import {
  isDeepStrictEqual,
} from "node:util";
import {
  z,
} from "zod";
import type {
  GatewayTransport,
} from "./desktop-gateway-transport";


export function ensureLearningRunBinding<T extends { runId: string; snapshotId: string }>(t: GatewayTransport, 
    value: T,
    expectedRunId: string,
    expectedSnapshotId?: string,
  ): T {
    if (value.runId !== expectedRunId || (expectedSnapshotId !== undefined && value.snapshotId !== expectedSnapshotId)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return value;
  }

export function ensureLearningTaskBinding<T extends { runId: string; snapshotId: string; taskId: string }>(t: GatewayTransport, 
    value: T,
    expectedRunId: string,
    expectedTaskId: string,
    expectedSnapshotId?: string,
  ): T {
    ensureLearningRunBinding(t, value, expectedRunId, expectedSnapshotId);
    if (value.taskId !== expectedTaskId) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return value;
  }

export async function getLearningRunV2<T>(t: GatewayTransport, 
    expectedRunId: string,
    path: string,
    // 输入侧写 `unknown`：带 `.default()` 的 schema 输入比输出宽（字段可省），
    // 若这里沿用默认的 `Input = Output`，T 会被推断到输入侧，调用方的返回类型
    // 就变成"字段可有可无"，与解析后的真实形状不符（审计 F28 的 checkpointReason
    // 就是这么把桌面端 typecheck 顶红的）。解析结果只以输出侧为准。
    schema: z.ZodType<T & { runId: string; snapshotId: string }, z.ZodTypeDef, unknown>,
    requestId?: string,
  ): Promise<T & { runId: string; snapshotId: string }> {
    await t.ensureConnected(requestId);
    const result = await t.request(path, { method: "GET" }, true, true, requestId);
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return ensureLearningRunBinding(t, parsed.data, expectedRunId);
  }

export function learningRunMutationResult(t: GatewayTransport, error: unknown): never {
    // A transport failure can happen after the API has committed a draft,
    // locked an artifact, or accepted an action.  These commands must never
    // be replayed from the renderer without first reading the authoritative
    // LearningRun state.
    if (error instanceof DesktopGatewayFailure && (error.code === "api_unavailable" || error.code === "network_timeout")) {
      throw new DesktopGatewayFailure("result_unknown", "resync_first", {
        ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      });
    }
    throw error;
  }

export async function applyLearningRunAction(t: GatewayTransport, runId: string, request: DesktopLearningRunActionRequestV2, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunActionResponseV2Schema>> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const body = { ...request, version: 2 as const, idempotencyKey: t.idempotencyKey("learningRun-action", commandId) };
    try {
      const result = await t.request(`/v2/learning-runs/${safeRunId}/actions`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = learningRunActionResponseV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return ensureLearningRunBinding(t, parsed.data, safeRunId, request.snapshotId);
    } catch (error) {
      throw learningRunMutationResult(t, error);
    }
  }

export async function abandonLearningRun(t: GatewayTransport, runId: string, request: DesktopLearningRunAbandonRequestV2, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunActionResponseV2Schema>> {
    return applyLearningRunAction(t, runId, {
      version: 2,
      snapshotId: request.snapshotId,
      runRevision: request.runRevision,
      runtimeEpoch: request.runtimeEpoch,
      action: { kind: "end", abandonLockedEvidence: request.abandonLockedEvidence },
    }, commandId, requestId);
  }

export async function getLearningRun(t: GatewayTransport, runId: string, requestId?: string): Promise<z.infer<typeof learningRunPublicSnapshotV2Schema>> {
    const safeRunId = safeUuid(runId);
    return getLearningRunV2(t, safeRunId, `/v2/learning-runs/${safeRunId}`, learningRunPublicSnapshotV2Schema, requestId);
  }

export async function getLearningRunDraft(t: GatewayTransport, runId: string, taskId: string, requestId?: string): Promise<z.infer<typeof learningTaskDraftV2Schema> | null> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const safeTaskId = safeUuid(taskId);
    const result = await t.request(
      `/v2/learning-runs/${safeRunId}/tasks/${safeTaskId}/draft`,
      { method: "GET" },
      true,
      false,
      requestId,
      undefined,
      true,
    );
    if (result.status >= 300) {
      const draftNotFound = z.object({ error: z.literal("draft_not_found") }).safeParse(result.body);
      if (result.status === 404 && draftNotFound.success) return null;
      throw t.mapResponseError(result.status, result.headers);
    }
    const parsed = learningTaskDraftV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return ensureLearningTaskBinding(t, parsed.data, safeRunId, safeTaskId);
  }

export async function getLearningRunResult(t: GatewayTransport, runId: string, requestId?: string): Promise<z.infer<typeof getLearningRunResultResponseV2Schema>> {
    const safeRunId = safeUuid(runId);
    return getLearningRunV2(t, safeRunId, `/v2/learning-runs/${safeRunId}/result`, getLearningRunResultResponseV2Schema, requestId);
  }

export async function getLearningRunReturnContract(t: GatewayTransport, runId: string, requestId?: string): Promise<z.infer<typeof learningRunReturnContractV2Schema>> {
    const safeRunId = safeUuid(runId);
    return getLearningRunV2(t, safeRunId, `/v2/learning-runs/${safeRunId}/return-contract`, learningRunReturnContractV2Schema, requestId);
  }

export async function recordLearningRunActivityLease(t: GatewayTransport, runId: string, request: DesktopRecordLearningRunActivityLeaseRequestV2, requestId?: string): Promise<z.infer<typeof recordLearningRunActivityLeaseOutputV2Schema>> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const body = {
      ...request,
      version: 2 as const,
      deviceSessionId: t.deviceSessionId,
    };
    const result = await t.request(`/v2/learning-runs/${safeRunId}/activity-lease`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
    if (result.status !== 204) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return recordLearningRunActivityLeaseOutputV2Schema.parse({ recorded: true });
  }

export async function revealLearningRunTarget(t: GatewayTransport, runId: string, requestId?: string): Promise<z.infer<typeof learningRunTargetRevealV2Schema>> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const result = await t.request(`/v2/learning-runs/${safeRunId}/reveal`, { method: "POST", body: "{}" }, true, true, requestId);
    const parsed = learningRunTargetRevealV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function saveLearningRunDraft(t: GatewayTransport, runId: string, taskId: string, request: DesktopPutLearningTaskDraftV2Request, commandId: string, requestId?: string): Promise<z.infer<typeof learningTaskDraftWriteReceiptV2Schema>> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const safeTaskId = safeUuid(taskId);
    const body = { ...request, version: 2 as const, idempotencyKey: t.idempotencyKey("learningRun-draft", commandId) };
    try {
      const result = await t.request(`/v2/learning-runs/${safeRunId}/tasks/${safeTaskId}/draft`, { method: "PUT", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = learningTaskDraftWriteReceiptV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      const receipt = ensureLearningTaskBinding(t, parsed.data, safeRunId, safeTaskId, request.snapshotId);
      if (receipt.variantId !== request.variantId) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return receipt;
    } catch (error) {
      throw learningRunMutationResult(t, error);
    }
  }

export async function startLearningRun(t: GatewayTransport, request: DesktopCreateLearningRunV2Request, commandId: string, requestId?: string): Promise<z.infer<typeof learningRunPublicSnapshotV2Schema>> {
    await t.ensureConnected(requestId);
    const body = { ...request, version: 2 as const, idempotencyKey: t.idempotencyKey("learningRun-start", commandId) };
    const result = await t.request("/learning-runs", { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
    const parsed = learningRunPublicSnapshotV2Schema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    if (!isDeepStrictEqual(parsed.data.originV2, request.originV2)) {
      throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    }
    return parsed.data;
  }

export async function submitLearningRunArtifact(t: GatewayTransport, runId: string, taskId: string, request: DesktopSubmitTaskArtifactV2, commandId: string, requestId?: string): Promise<z.infer<typeof submitTaskArtifactReceiptV2Schema>> {
    await t.ensureConnected(requestId);
    const safeRunId = safeUuid(runId);
    const safeTaskId = safeUuid(taskId);
    const body = { ...request, version: 2 as const, idempotencyKey: t.idempotencyKey("learningRun-submit", commandId) };
    try {
      const result = await t.request(`/v2/learning-runs/${safeRunId}/tasks/${safeTaskId}/submissions`, { method: "POST", body: JSON.stringify(body) }, true, true, requestId);
      const parsed = submitTaskArtifactReceiptV2Schema.safeParse(result.body);
      if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
      return ensureLearningTaskBinding(t, parsed.data, safeRunId, safeTaskId, request.snapshotId);
    } catch (error) {
      throw learningRunMutationResult(t, error);
    }
  }
