/**
 * identity 的「AI 授权与审计」服务（P1-7 第四步：从门面变成实现）。
 *
 * 搬的是五个函数加一个私有 helper：`getAIPrivacySettings` / `updateAIConsent` /
 * `updateAIDataPolicy` / `listAIAuditLog` / `logAICall`，以及它们唯一依赖的
 * `systemUsesExternalAI()`。这一族与 service.ts 里其它部分**没有共享内部状态**，
 * 是五族里耦合最小的一族，所以先搬它。
 *
 * `service.ts` 仍然从这里 re-export，所以**既有调用方一行都不用改**——
 * 这正是先立门面那一步换来的。
 */

import { count, desc, eq, sql } from "drizzle-orm";
import { aiAuditLog, userAiSettings } from "@astella/shared/db-schema";
import { withActorTransaction, withWorkspaceTransaction } from "../../db/client.ts";
import { users } from "@astella/shared/db-schema";
// "系统账号能不能用某个能力"那套判据是纯函数，且与 identity 其余部分共用，
// 所以从 shared 取而不是从 ./service.ts 取——**那会造出一个新的环**
// （service.ts 从本文件 re-export，本文件再从 service.ts 取）。
import { resolveSystemProviderForCapability } from "@astella/shared/task-router";

function systemUsesExternalAI(): boolean {
  return (
    resolveSystemProviderForCapability("agent_turn") !== "mock" ||
    resolveSystemProviderForCapability("vision") !== "mock" ||
    resolveSystemProviderForCapability("text_generation") !== "mock" ||
    resolveSystemProviderForCapability("embedding") !== "mock"
  );
}

export async function getAIPrivacySettings(workspaceId: string, userId: string) {
  const settings = await withWorkspaceTransaction({ workspaceId, userId }, async (transaction) => {
    const user = await transaction.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true } });
    if (!user) return null;
    // 新账号尚未签署时也要有可读取的政策；使用数据库默认值，绝不自动授权。
    await transaction.insert(userAiSettings).values({ userId }).onConflictDoNothing();
    const rows = await transaction.select().from(userAiSettings).where(eq(userAiSettings.userId, userId)).limit(1);
    return rows[0] ?? null;
  });
  if (!settings) return null;
  return {
    requiresConsent: systemUsesExternalAI(),
    consentVersion: settings.consentVersion,
    consentAt: settings.consentAt,
    dataPolicy: {
      sendToExternal: settings.dataPolicy.sendToExternal,
      sendImageContent: settings.dataPolicy.sendImageContent ?? false,
      piiDetection: settings.dataPolicy.piiDetection,
      auditLogging: settings.dataPolicy.auditLogging,
    },
  };
}

/**
 * 本人明确同意使用外部 AI：签署与开启外发在同一次写入中生效。
 * 只开启总开关，保留已有的图片、个人信息检测与审计选择。
 */
export async function updateAIConsent(
  workspaceId: string,
  userId: string,
  consentVersion: string,
): Promise<void> {
  await withWorkspaceTransaction(
    { workspaceId, userId },
    async (transaction) => {
      // 新账号先取列默认值；与签署写入同一事务，不暴露半完成状态。
      await transaction.insert(userAiSettings).values({ userId }).onConflictDoNothing();
      await transaction.update(userAiSettings)
        .set({
          consentVersion,
          consentAt: new Date(),
          dataPolicy: sql`jsonb_set(${userAiSettings.dataPolicy}, '{sendToExternal}', 'true'::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(userAiSettings.userId, userId));
    },
  );
}

/** 更新本人的 AI 数据外发政策。 */
export async function updateAIDataPolicy(
  workspaceId: string,
  userId: string,
  policy: {
    sendToExternal: boolean;
    sendImageContent: boolean;
    piiDetection: boolean;
    auditLogging: boolean;
  },
): Promise<void> {
  await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => transaction
      .insert(userAiSettings)
      .values({ userId, dataPolicy: policy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userAiSettings.userId,
        set: { dataPolicy: policy, updatedAt: new Date() },
      }),
  );
}

/**
 * N-011: 查询 AI 审计日志（分页）。
 *
 * `ai_audit_log` 在 0257 里是 `ENABLE + FORCE ROW LEVEL SECURITY`，所以这两句读
 * **必须带工作区上下文**：裸 `db` 在 `astella_api`（NOBYPASSRLS，生产形状）下恒 0 行，
 * rows 与 count 双双为空——而设置页写的是"每次外发都留下可追溯的记录，供你回看"
 * （doc 34 L3，与 L2 同一颗雷：dev 的 API 角色绕过 RLS，所以本地永远是绿的）。
 */
export async function listAIAuditLog(
  workspaceId: string,
  userId: string,
  opts: { limit: number; offset: number },
): Promise<{ items: AIAuditLogItem[]; total: number }> {
  const [rows, totalRows] = await withWorkspaceTransaction(
    { workspaceId, userId },
    (transaction) => Promise.all([
      transaction
        .select({
          id: aiAuditLog.id,
          workspaceId: aiAuditLog.workspaceId,
          userId: aiAuditLog.userId,
          jobId: aiAuditLog.jobId,
          provider: aiAuditLog.provider,
          modelId: aiAuditLog.modelId,
          operation: aiAuditLog.operation,
          dataCategories: aiAuditLog.dataCategories,
          dataSizeBytes: aiAuditLog.dataSizeBytes,
          costTokens: aiAuditLog.costTokens,
          durationMs: aiAuditLog.durationMs,
          status: aiAuditLog.status,
          errorMessage: aiAuditLog.errorMessage,
          createdAt: aiAuditLog.createdAt,
          operatorId: users.id,
          operatorEmail: users.email,
        })
        .from(aiAuditLog)
        .leftJoin(users, eq(aiAuditLog.userId, users.id))
        .where(eq(aiAuditLog.workspaceId, workspaceId))
        .orderBy(desc(aiAuditLog.createdAt))
        .limit(opts.limit)
        .offset(opts.offset),
      transaction
        .select({ total: count() })
        .from(aiAuditLog)
        .where(eq(aiAuditLog.workspaceId, workspaceId)),
    ]),
  );

  return {
    items: rows.map(({ operatorId, operatorEmail, ...audit }) => ({
      ...audit,
      // Keep userId for existing clients and expose a stable operator object
      // for attribution-aware clients. A missing user is retained as null so
      // historical rows remain inspectable instead of being silently dropped.
      operator: operatorId && operatorEmail
        ? { userId: operatorId, email: operatorEmail }
        : null,
    })),
    total: Number(totalRows[0]?.total ?? 0),
  };
}

export interface AIAuditActor {
  userId: string;
  email: string;
}

export interface AIAuditLogItem {
  id: string;
  workspaceId: string;
  userId: string;
  jobId: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories: string[];
  dataSizeBytes: number | null;
  costTokens: number | null;
  durationMs: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  operator: AIAuditActor | null;
}

/**
 * N-011: 写入 AI 审计日志（供 worker / API 调用）。
 */
type AuditActorIdentity =
  | {
      /** Canonical field for the user who initiated the job/request. */
      actorUserId: string;
          }
  | {
      actorUserId?: undefined;
          };

export type LogAICallParams = AuditActorIdentity & {
  workspaceId: string;
  jobId?: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories?: string[];
  dataSizeBytes?: number | null;
  costTokens?: number | null;
  durationMs?: number | null;
  status?: string;
  errorMessage?: string | null;
};

export async function logAICall(params: LogAICallParams): Promise<void> {
  const actorUserId = params.actorUserId;
  if (!actorUserId) {
    throw new Error("AI audit log requires actorUserId (the initiating user UUID)");
  }
  // `ai_audit_log` 有租户守卫 + 插入 actor 守卫，两者都要上下文。
  await withActorTransaction({ userId: actorUserId, workspaceId: params.workspaceId }, (tx) =>
    tx.insert(aiAuditLog).values({
      workspaceId: params.workspaceId,
      userId: actorUserId,
      jobId: params.jobId ?? null,
      provider: params.provider,
      modelId: params.modelId,
      operation: params.operation,
      dataCategories: params.dataCategories ?? [],
      dataSizeBytes: params.dataSizeBytes ?? null,
      costTokens: params.costTokens ?? null,
      durationMs: params.durationMs ?? null,
      status: params.status ?? "success",
      errorMessage: params.errorMessage ?? null,
    }),
  );
}
