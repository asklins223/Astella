/**
 * 真桌宠记忆路由（22-real-desktop-pet-memory-context-prd-tdd.md §3.3/§13.2）。
 *
 * GET    /companion/memory                    — 列表 + 搜索 + 筛选
 * GET    /companion/memory/export             — 导出全部记忆 JSON
 * POST   /companion/memory                    — 手动新增
 * POST   /companion/memory/:id/confirm        — 确认候选
 * POST   /companion/memory/:id/reject         — 拒绝候选（soft delete）
 * POST   /companion/memory/:id/pin            — 固定
 * POST   /companion/memory/:id/unpin          — 取消固定（pin 为置 true，非 toggle）
 * POST   /companion/memory/:id/archive        — 归档
 * POST   /companion/memory/:id/restore        — 恢复
 * POST   /companion/memory/:id/dismiss        — 忽略（写 dismissed_at，并把那条候选交付结账成 dismissed）
 * POST   /companion/memory/:id/correct        — 带 expectedRevision 原子修订当前版本
 * GET    /companion/memory/:id/revisions      — 查看此前版本及其作者/来源
 * DELETE /companion/memory/:id                — 删除记忆
 * DELETE /companion/memory                    — 一键清空（二次确认由前端保证）
 *
 * capability 门控：COMPANION_MEMORY_VECTOR_V1 或 COMPANION_JOURNEY_V2 开启时可用；
 * 否则 404 fail closed。与 canonical 学习事实解耦。
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "../../identity/middleware.ts";
// 整理提交复用身份域的账号 AI 边界，避免先排任务、后台才发现用户未同意。
import { getAIPrivacySettings } from "../../identity/ai-consent-service.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../../db/client.ts";
import { createJob } from "../../job/service.ts";
import { companionMemoryCandidateTotal } from "../../../lib/metrics.ts";
import {
  archiveMemory,
  clearMemories,
  confirmMemory,
  correctMemory,
  deleteMemory,
  dismissMemory,
  exportMemories,
  getMemoryBudgetStatus,
  listMemories,
  listMemoryConflicts,
  listMemoryRevisions,
  listRecycledMemories,
  MemorySourceSuppressedError,
  MemoryRevisionConflictError,
  MemoryGlobalScopeRejectedError,
  moveMemoryBudgetTier,
  pinMemory,
  resolveMemoryConflict,
  restoreMemory,
  restoreDeletedMemory,
  eraseMemory,
  unpinMemory,
  upsertMemory,
  type MemoryKindV2,
  type MemoryItemV2,
  type MemoryScopeV2,
  type MemorySourceTypeV2,
} from "./memory-service.ts";
import { getMemoryStarMap } from "./memory-star-map.ts";
import { isMemoryContextEnabled, isMemoryVectorRebuildEnabled } from "../../../config/learning-companion-flags.ts";
import {
  accountPreferenceRejectionMessage,
  type AccountPreferenceWriteRejection,
} from "@ailearn/shared/companion-memory-scope";

/**
 * 账号级（跨空间）写入被拒时的对外回执（42 阶段 1 E）。
 *
 * 状态码取 **422**：请求本身合法（体校验过了、kind 也在枚举里），不合法的是
 * **这份内容配上这个范围**——所以它是"能理解但做不到"，不是 400（体写错了），
 * 也不是 409（版本冲突）。三句拒绝文案住在共享模块，API、伴星工具与提案确认链
 * 共用同一份，避免"这里改了、那里没改"。
 */
export const MEMORY_GLOBAL_SCOPE_REJECTED_STATUS = 422;

/** 领域错误 → 4xx 回执。导出给测试：状态码与文案都是对外契约，不该只活在 handler 里。 */
export function memoryGlobalScopeRejection(error: MemoryGlobalScopeRejectedError): {
  statusCode: number;
  body: { error: string; reason: AccountPreferenceWriteRejection; message: string };
} {
  return {
    statusCode: MEMORY_GLOBAL_SCOPE_REJECTED_STATUS,
    body: {
      error: "memory_global_scope_rejected",
      reason: error.reason,
      message: accountPreferenceRejectionMessage(error.reason),
    },
  };
}

const memoryParamsSchema = z.object({ id: z.string().uuid() });

/** 在排队前反馈不可执行的原因，避免用户收到“已开始”后任务才因权限失败。 */
async function canQueueMemoryAi(scope: { workspaceId: string; userId: string }, reply: FastifyReply): Promise<boolean> {
  const settings = await getAIPrivacySettings(scope.workspaceId, scope.userId);
  if (!settings?.consentAt || !settings.consentVersion) {
    await reply.code(403).send({ error: "ai_consent_required", message: "还没有同意使用 AI 服务，请先在设置中确认后再整理。" });
    return false;
  }
  if (!settings.dataPolicy.sendToExternal && settings.requiresConsent) {
    await reply.code(403).send({ error: "ai_data_policy_denied", message: "当前不允许外发材料，请在 AI 数据同意中开启文字外发后再整理。" });
    return false;
  }
  return true;
}

/** 筛选与读取用的完整 kind：含判断记录（40 §4.5.4）。 */
const memoryKindSchema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
  "judgment",
]);

/**
 * 写入端**不接受** `judgment`。
 *
 * 判断记录必须有来源事件、作者是她、认识状态显式（§4.5.4–4.5.5），
 * 这三件事手动新增一个文本框填不出来；只有 `remember_judgment` 工具能写。
 * 它出现在 kind 枚举里只是为了让「筛选她的看法」能用。
 */
const creatableMemoryKindSchema = memoryKindSchema.exclude(["judgment"]);

const memoryBudgetTierSchema = z.enum(["resident", "active", "archived"]);

const listQuerySchema = z.object({
  focusMemoryId: z.string().uuid().optional(),
  kind: memoryKindSchema.optional(),
  q: z.string().min(1).max(200).optional(),
  scope: z.enum(["global", "workspace", "task"]).optional(),
  includeCandidates: z.coerce.boolean().optional().default(false),
  includeArchived: z.coerce.boolean().optional().default(false),
});

const createMemoryBodySchema = z.object({
  kind: creatableMemoryKindSchema,
  // §9.4/§25：写入端统一限制 ≤200 字。
  content: z.string().min(1).max(200),
  sourceEventId: z.string().min(1).max(240).optional(),
  sourceSessionId: z.string().uuid().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  scope: z.enum(["global", "workspace", "task"]).optional(),
  sourceType: z.enum(["user_stated", "model_inferred", "confirmed", "summary"]).optional(),
  userStated: z.boolean().optional(),
  candidate: z.boolean().optional(),
  appliesWhen: z.string().max(200).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
}).superRefine((value, context) => {
  if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must follow validFrom" });
  }
});

const correctMemoryBodySchema = z.object({
  // §9.4/§25：写入端统一限制 ≤200 字。
  content: z.string().min(1).max(200),
  expectedRevision: z.number().int().min(1),
  reason: z.string().min(1).max(500).optional(),
  appliesWhen: z.string().max(200).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
}).superRefine((value, context) => {
  if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must follow validFrom" });
  }
});

export async function memoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (!isMemoryContextEnabled()) {
            return reply.code(404).send({
        error: "companion_memory_context_disabled",
        message: "桌宠记忆与上下文当前未开放",
      });
    }
  });

  app.get("/companion/memory/recycle", { preHandler: [requireSession] }, async (req, reply) => {
    const scope = scopeOfSession(req.session);
    const items = await withWorkspaceTransaction(scope, tx => listRecycledMemories(tx, scope));
    return reply.header("Cache-Control", "no-store").send({ version: 1, items });
  });

  app.get(
    "/companion/memory/star-map",
    { preHandler: [requireSession] },
    async (req, reply) => {
      // §9.8：记忆星图独立 feature flag（2026-08-19 补齐——此前路由无门控，
      // 与"每个能力独立开关、fail-closed"的约定不符）。
      if (process.env.COMPANION_MEMORY_STAR_MAP_V1 !== "true") {
        return reply.code(404).send({
          error: "companion_memory_star_map_disabled",
          message: "记忆星图当前未开放",
        });
      }
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, (tx) => getMemoryStarMap(tx, scope));
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/conversations/:id/summarize",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("conversationId 非法");
      if (process.env.COMPANION_SUMMARIZER_V1 !== "true") {
        return reply.code(404).send({ error: "companion_summarizer_disabled", message: "会话摘要当前未开放" });
      }
      const scope = scopeOfSession(req.session);
      const exists = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_conversations
          WHERE id = ${params.data.id} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          LIMIT 1
        `);
        return rows.length > 0;
      });
      if (!exists) {
        return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
      }
      if (!await canQueueMemoryAi(scope, reply)) return;
      const hasMessages = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM companion_messages WHERE conversation_id = ${params.data.id} LIMIT 1`);
        return rows.length > 0;
      });
      if (!hasMessages) return reply.code(409).send({ error: "conversation_empty", message: "还没有可整理的对话，先与伴星聊几句后再试。" });
      await createJob({
        type: "companion_summarizer",
        workspaceId: scope.workspaceId,
        requestedBy: scope.userId,
        payload: {
          conversationId: params.data.id,
          userId: scope.userId,
          sourceRunId: null,
          includeRecent: true,
        },
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, queued: true });
    },
  );

  app.get(
    "/companion/memory/conflicts",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const items = await withWorkspaceTransaction(scope, (tx) => listMemoryConflicts(tx, scope));
      return reply.header("Cache-Control", "no-store").send({ version: 1, items });
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/companion/memory/:id/resolve-conflict",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      const body = z.object({ removeId: z.string().uuid() }).safeParse(req.body ?? {});
      if (!params.success || !body.success) throw app.httpErrors.badRequest("resolve body 非法");
      const scope = scopeOfSession(req.session);
      const ok = await withWorkspaceTransaction(scope, (tx) =>
        resolveMemoryConflict(tx, scope, params.data.id, body.data.removeId),
      );
      if (!ok) {
        return reply.code(409).send({ error: "memory_conflict_resolution_failed", message: "冲突裁决失败" });
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, ok: true });
    },
  );

  app.get(
    "/companion/memory/export",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, (tx) => exportMemories(tx, scope));
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/companion/memory/:id/revisions",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const items = await withWorkspaceTransaction(scope, (tx) =>
        listMemoryRevisions(tx, scope, params.data.id),
      );
      if (!items) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        memoryItemId: params.data.id,
        items,
      });
    },
  );

  app.get(
    "/companion/memory/budget",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const status = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
      return reply.header("Cache-Control", "no-store").send(status);
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query ?? {});
      if (!query.success) throw app.httpErrors.badRequest("memory query 非法");
      const scope = scopeOfSession(req.session);
      const items = await withWorkspaceTransaction(scope, (tx) =>
        listMemories(tx, scope, {
          focusMemoryId: query.data.focusMemoryId,
          kind: query.data.kind as MemoryKindV2 | undefined,
          q: query.data.q,
          scope: query.data.scope as MemoryScopeV2 | undefined,
          includeCandidates: query.data.includeCandidates,
          includeArchived: query.data.includeArchived,
        }),
      );
      return reply.header("Cache-Control", "no-store").send({ version: 2, items });
    },
  );

  app.post<{ Body: unknown }>(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = createMemoryBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("memory body 非法");
      const scope = scopeOfSession(req.session);
      let item: MemoryItemV2;
      try {
        item = await withWorkspaceTransaction(scope, (tx) =>
          upsertMemory(tx, scope, {
            kind: body.data.kind,
            content: body.data.content,
            sourceEventId: body.data.sourceEventId,
            sourceSessionId: body.data.sourceSessionId,
            importance: body.data.importance,
            confidence: body.data.confidence,
            scope: body.data.scope,
            sourceType: body.data.sourceType as MemorySourceTypeV2 | undefined,
            userStated: body.data.userStated ?? true,
            candidate: body.data.candidate ?? false,
            appliesWhen: body.data.appliesWhen,
            validFrom: body.data.validFrom == null ? body.data.validFrom : new Date(body.data.validFrom),
            validUntil: body.data.validUntil == null ? body.data.validUntil : new Date(body.data.validUntil),
          }),
        );
      } catch (error) {
        if (error instanceof MemorySourceSuppressedError) {
          return reply.code(409).send({
            error: "memory_source_forgotten",
            message: "这条来源已被忘记；如需重新保存，请作为新的手动记忆添加。",
          });
        }
        if (error instanceof MemoryGlobalScopeRejectedError) {
          const rejection = memoryGlobalScopeRejection(error);
          return reply.code(rejection.statusCode).send(rejection.body);
        }
        throw error;
      }
      // §9.9：记录候选创建指标
      try {
        companionMemoryCandidateTotal.labels("created").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      // §13.8：确认后的记忆自动触发 embedding 重建（仅非候选记忆）
      if (!body.data.candidate && isMemoryVectorRebuildEnabled()) {
        try {
          await createJob({
            type: "companion_memory_embedding_rebuild",
            workspaceId: scope.workspaceId,
            requestedBy: scope.userId,
            payload: { userId: scope.userId },
          });
        } catch {
          // embedding 重建入队失败不阻断主请求
        }
      }
      return reply.header("Cache-Control", "no-store").code(201).send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/confirm",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        confirmMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      // §9.9：记录候选确认指标
      try {
        companionMemoryCandidateTotal.labels("confirmed").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      // §13.8：确认后的记忆自动触发 embedding 重建
      if (isMemoryVectorRebuildEnabled()) {
        try {
          await createJob({
            type: "companion_memory_embedding_rebuild",
            workspaceId: scope.workspaceId,
            requestedBy: scope.userId,
            payload: { userId: scope.userId },
          });
        } catch {
          // embedding 重建入队失败不阻断主请求
        }
      }
      // §10.5 关系状态：每次确认记忆 familiarity +0.03（上限 1）。
      // 独立事务 + 失败静默：关系状态是弱事实，不影响确认主链路。
      try {
        await withWorkspaceTransaction(scope, async (tx) => {
          await tx.execute(sql`
            INSERT INTO pet_profiles (workspace_id, user_id, familiarity)
            VALUES (${scope.workspaceId}, ${scope.userId}, 0.03)
            ON CONFLICT (workspace_id, user_id) DO UPDATE
            SET familiarity = LEAST(pet_profiles.familiarity + 0.03, 1), updated_at = now()
          `);
        });
      } catch {
        // 无人格档案行 / 权限缺失时静默跳过
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/reject",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const deleted = await withWorkspaceTransaction(scope, (tx) =>
        deleteMemory(tx, scope, params.data.id),
      );
      if (!deleted) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      // §9.9：记录候选拒绝指标（reject 路由）
      try {
        companionMemoryCandidateTotal.labels("rejected").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/pin",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        pinMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  // pin 端点只置 pinned=true（非 toggle）；取消固定走独立 unpin 端点。
  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/unpin",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        unpinMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/archive",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        archiveMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/restore",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        restoreMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/companion/memory/:id/budget-tier",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      const body = z.object({ tier: memoryBudgetTierSchema }).strict().safeParse(req.body ?? {});
      if (!params.success || !body.success) throw app.httpErrors.badRequest("memory budget tier 参数非法");
      const scope = scopeOfSession(req.session);
      const result = await withWorkspaceTransaction(scope, (tx) =>
        moveMemoryBudgetTier(tx, scope, {
          memoryItemId: params.data.id,
          tier: body.data.tier,
          actorType: "user",
          actorId: scope.userId,
        }),
      );
      if (result.status === "missing") {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      if (result.status === "capacity") {
        return reply.code(409).header("Cache-Control", "no-store").send({
          error: "memory_resident_budget_full",
          message: "常驻记忆预算已满；先选择一条常驻记忆降层后再试。",
          result,
        });
      }
      if (result.status === "not_eligible") {
        return reply.code(409).send({ error: "memory_budget_tier_not_eligible", message: "未确认的候选记忆不能设为常驻" });
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, result });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/dismiss",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const item = await withWorkspaceTransaction(scope, (tx) =>
        dismissMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/companion/memory/:id/correct",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      const body = correctMemoryBodySchema.safeParse(req.body ?? {});
      if (!params.success || !body.success) throw app.httpErrors.badRequest("correct body 非法");
      const scope = scopeOfSession(req.session);
      let item: MemoryItemV2 | null;
      try {
        item = await withWorkspaceTransaction(scope, (tx) =>
          correctMemory(tx, scope, params.data.id, {
            ...body.data,
            validFrom: body.data.validFrom == null ? body.data.validFrom : new Date(body.data.validFrom),
            validUntil: body.data.validUntil == null ? body.data.validUntil : new Date(body.data.validUntil),
          }),
        );
      } catch (error) {
        if (error instanceof MemoryRevisionConflictError) {
          return reply.code(409).send({
            error: "memory_revision_conflict",
            message: "这条记忆已有新版本；请重新读取后再修订。",
            currentRevision: error.currentRevision,
          });
        }
        if (error instanceof MemoryGlobalScopeRejectedError) {
          const rejection = memoryGlobalScopeRejection(error);
          return reply.code(rejection.statusCode).send(rejection.body);
        }
        throw error;
      }
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/companion/memory/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const deleted = await withWorkspaceTransaction(scope, (tx) =>
        deleteMemory(tx, scope, params.data.id),
      );
      if (!deleted) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      // §9.9：记录候选删除指标（delete 路由）
      try {
        companionMemoryCandidateTotal.labels("deleted").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.code(204).send();
    },
  );

  /**
   * 从回收区恢复（40 §4.6.4 / A47 的「普通回收**可恢复**且留痕」）。
   *
   * 与 `POST /:id/restore` 分开是刻意的：那条恢复的是**归档**（记忆一直活着），
   * 这里恢复的是**删除**。两条语义不同、留痕不同，合成一条会让人以为
   * 「归档」和「删除」是同一个开关的两端。
   */
  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/restore-deleted",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const restored = await withWorkspaceTransaction(scope, (tx) =>
        restoreDeletedMemory(tx, scope, params.data.id),
      );
      if (!restored) {
        return reply.code(404).send({ error: "memory_not_in_recycle_bin", message: "这条记忆不在回收区里" });
      }
      return reply.code(204).send();
    },
  );

  /**
   * **彻底清除**：用户明确要求删干净时用，不等回收区窗口（§11：「不以
   * 『正式历史不可变』拒绝适用的删除规则」）。与 `DELETE /:id` 的分工写在
   * memory-service.eraseMemory 的注释里。
   */
  app.delete<{ Params: { id: string } }>(
    "/companion/memory/:id/erase",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = scopeOfSession(req.session);
      const erased = await withWorkspaceTransaction(scope, (tx) =>
        eraseMemory(tx, scope, params.data.id),
      );
      if (!erased) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = scopeOfSession(req.session);
      const deletedCount = await withWorkspaceTransaction(scope, (tx) =>
        clearMemories(tx, scope),
      );
      return reply.header("Cache-Control", "no-store").send({ deletedCount });
    },
  );

  app.post(
    "/companion/memory/rebuild-embeddings",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (!isMemoryVectorRebuildEnabled()) {
        return reply.code(404).send({ error: "companion_memory_vector_disabled", message: "向量记忆当前未开放" });
      }
      const scope = scopeOfSession(req.session);
      if (!await canQueueMemoryAi(scope, reply)) return;
      await createJob({
        type: "companion_memory_embedding_rebuild",
        workspaceId: scope.workspaceId,
        requestedBy: scope.userId,
        payload: { userId: scope.userId },
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, queued: true });
    },
  );
}
