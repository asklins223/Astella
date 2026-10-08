import { reserveCompanionProviderCall } from "./companion-agent-events.ts";
import { readCompanionMemoryWriteSource } from "./companion-memory-write-source.ts";
/**
 * 伴星 agent 的**记忆工具族**（2026-10-01 从 `companion-tool-execution.ts` 搬出）。
 *
 * ## 为什么按「记忆」切，而不是按「读／写」切
 *
 * 这六个工具（read_memory / recall_memory / save_memory / revise_memory /
 * move_memory / forget_memory）原本**横跨** `executeReadTool` 与
 * `executeDirectTool` 两个 switch。40 §4.5–§4.6 把它们当成**一个域**讲：
 * 准入、版本、容量层、抑制与修订是一套规矩，分在两个函数里读要来回跳。
 * 而把它们并到一处之后，`companion-tool-execution.ts` 1508 → 1084 行，
 * 回到 `god-file-ratchet` 的 1500 行阈值之下（那道判据只许清单变短）。
 *
 * ## 派活规则没有变
 *
 * `definition.riskClass === "read"` 仍然决定去 `executeReadTool` 还是
 * `executeDirectTool`；两个执行器里**各自的 `case` 标签原样保留**，只是函数体
 * 变成一行转交。`companion-tool-executor-ledger.test.ts` 那张台账判据扫的是
 * 「每个 `case "companion_x"` 住在哪个执行器里」，搬走函数体而不动标签，
 * 它读到的仍是同一份合同——所以那张表不用改。
 *
 * 这一段是**照搬**的：SQL、错误句、账本分支一个字没改。
 */

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  type CompanionAgentToolDefinitionV1,
} from "@astella/shared";
import {
  companionMemoryMutationLockKey,
  MEMORY_CONTENT_SIMILARITY_THRESHOLD,
} from "@astella/shared/db-schema/assistant-memory";
// 跨空间范围判据的唯一来源：抽取侧、API 写入端与这里的直执行共用（42 阶段 1 E）。
import {
  accountPreferenceRejectionMessage,
  accountPreferenceWriteDecision,
} from "@astella/shared/companion-memory-scope";
import { toTextArrayLiteral } from "@astella/shared/pg-text-array";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { createEmbeddingProvider } from "../lib/ai-provider.ts";
import {
  createGovernedEmbeddingProvider,
  resolveAIGovernanceContext,
} from "../lib/governance.ts";
import { JobLeaseLostError, throwIfJobAborted } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import {
  extractQueryKeywords,
  readActiveCompanionMemoryById,
  retrieveCompanionMemories,
  retrieveResidentCompanionMemories,
} from "./companion-memory-vector.ts";
import { taskEntityFromPersistedPageContext } from "./companion-task-memory.ts";
import { readPlaybookById } from "./companion-playbooks.ts";
import type { AgentEventContext } from "./companion-read-tools.ts";
import { runWorkerEmbeddingTask } from "./worker-ai-task.ts";
import type { EmbeddingProviderLike } from "../lib/ai-provider.ts";
import {
  CompanionToolError,
  type AgentToolExecutionResult,
} from "./companion-tool-result.ts";

export async function executeCompanionMemoryTool(
  event: AgentEventContext,
  definition: CompanionAgentToolDefinitionV1,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  switch (definition.name) {
    case "companion_read_memory": {
      const memoryId = String(args.memoryId);
      const expectedRevision = Number(args.expectedRevision);
      const memory = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => readActiveCompanionMemoryById(
          tx,
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          taskEntityFromPersistedPageContext(event.read.pageContext),
          memoryId,
          expectedRevision,
        ),
      );
      if (!memory) {
        throw new CompanionToolError("没找到这条仍有效且版本匹配的 active 记忆；这次没有展开正文");
      }

      // 读取正文已完成；使用时间与曝光日志是辅助统计，失败不能撤销成功读取。
      try {
        await withWorkerWorkspaceTransaction(
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          async (tx) => {
            await tx.execute(sql`
              UPDATE assistant_memory_items
                 SET last_used_at = now()
               WHERE id = ${memory.memoryId}::uuid
                 AND workspace_id = ${event.ctx.workspaceId}
                 AND user_id = ${event.read.userId}
                 AND revision = ${memory.revision}
                 AND budget_tier = 'active'
                 AND deleted_at IS NULL
            `);
            await tx.execute(sql`
              INSERT INTO memory_usage_log
                (workspace_id, user_id, run_id, memory_ids, retrieval_mode, latency_ms)
              VALUES
                (${event.ctx.workspaceId}, ${event.read.userId}, ${event.read.runId},
                 ${`{${memory.memoryId}}`}::uuid[], 'on_demand_id', 0)
            `);
          },
        );
      } catch (error) {
        logger.warn({ err: error, runId: event.read.runId }, "on-demand memory usage logging failed");
      }

      if (!event.read.memoryRefs.some((ref) => ref.memoryId === memory.memoryId)) {
        if (event.read.memoryRefs.length >= 3) event.read.memoryRefs.shift();
        event.read.memoryRefs.push({
          memoryId: memory.memoryId,
          kind: memory.kind,
          content: memory.content.slice(0, 80),
        });
      }
      return {
        value: {
          memoryId: memory.memoryId,
          kind: memory.kind,
          content: memory.content,
          appliesWhen: memory.appliesWhen,
          validFrom: memory.validFrom,
          validUntil: memory.validUntil,
          revision: memory.revision,
        },
        safeSummary: "已展开一条仍有效的记忆正文",
      };
    }
    case "companion_recall_memory": {
      // 默认避免重复本轮已注入项；管理已显示的记忆时显式 includeShown，取得其真实 ID、版本与容量层。
      const query = String(args.query).trim();
      const limit = typeof args.limit === "number" ? Math.min(8, Math.max(1, args.limit)) : 5;
      const includeShown = args.includeShown === true;
      const includeArchived = args.includeArchived === true;
      // 查询向量必须在开事务**之前**算：retrieveCompanionMemories 的约定是
      // precomputedEmbedding=null 表示"已试过且失败 → 直接降级 keyword"，
      // 绝不在事务里重试外部调用（事务被网络调用占住是另一类稳定性事故）。
      //
      // 这一发和 `companion-memory-embedding.ts` 是**同一条治理边界**：送出去的是用户
      // 原话（`args.query`），不是服务端算出来的向量。上游曾经直接
      // `createEmbeddingProvider()`——不查 `user_ai_settings` 的同意、不查数据外发政策、
      // 不过 PII 净化，于是"没同意外发"的人照样把原话送去了向量模型，而同一批调用在
      // 重建那条路上是受管的（治理口径按调用族分裂，审计表里也查不到这笔）。
      // 这里接上与重建同款的出口；查不到治理上下文或政策拒发时按"没有向量"降级到
      // 关键词检索（`retrieveCompanionMemories` 的 `!opts.provider` 分支就是它）。
      let provider: EmbeddingProviderLike | null = null;
      try {
        const govCtx = await resolveAIGovernanceContext(event.ctx.workspaceId, event.read.userId);
        if (govCtx.consentOk) {
          const rawProvider = await createEmbeddingProvider(govCtx);
          provider = rawProvider
            ? createGovernedEmbeddingProvider(rawProvider, govCtx, event.ctx.workspaceId, {
              // 送出去的是用户自己打的那句话：`user_answer`。
              // `event.ctx.id` 是 jobs 行（伴星对话 job），不是 run id。
              userId: event.read.userId,
              operation: "companion_memory_recall_embedding",
              reserveCall: () => reserveCompanionProviderCall(event),
              jobId: event.ctx.id,
              dataCategories: ["user_answer"],
            })
            : null;
        }
      } catch {
        provider = null;
      }
      let queryEmbedding: number[] | null = null;
      if (provider) {
        const embeddingProvider = provider;
        try {
          queryEmbedding = await runWorkerEmbeddingTask({
            job: event.ctx,
            userId: event.read.userId,
            taskId: "companion_memory_recall_embedding",
            taskVersion: 1,
            idempotencyKey: `memory-recall:${event.read.runId}:${event.read.generation}`,
            inputSnapshotId: `${event.read.runId}:memory-recall:${event.read.generation}`,
            text: query,
            modelId: embeddingProvider.embeddingModelId,
            promptVersion: `${embeddingProvider.id}:companion-memory-recall-v1`,
            resourceClass: "interactive_ai",
            timeoutMs: resolveProviderCallTimeout("companion_agent"),
            embed: (text, signal) => embeddingProvider.embed(text, signal),
          });
        } catch (error) {
          if (error instanceof JobLeaseLostError) throw error;
          throwIfJobAborted(event.ctx);
          queryEmbedding = null;
        }
      }
      const searchResult = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
          const taskEntity = taskEntityFromPersistedPageContext(event.read.pageContext);
          const retrieval = await retrieveCompanionMemories(tx, scope, query, {
            topK: limit * 2,
            provider,
            precomputedEmbedding: queryEmbedding,
            budgetTier: includeArchived ? "archived" : "active",
            // 任务记忆按身份可见（39b C8）：普通页推不出身份，task 行一概不可见。
            taskEntity,
          });
          const resident = includeShown
            ? await retrieveResidentCompanionMemories(tx, scope, taskEntity)
            : [];
          return { retrieval, resident };
        },
      );
      const alreadyShownIds = new Set(event.read.memoryRefs.map((memory) => memory.memoryId));
      // Resident data carries its complete body; UI references carry only a
      // preview, so their text cannot establish whether a record was shown.
      const residentContents = new Set(event.read.residentMemories.map((memory) => memory.content));
      const keywords = extractQueryKeywords(query).map((keyword) => keyword.toLocaleLowerCase());
      const residentMatches = searchResult.resident.filter((item) =>
        keywords.some((keyword) => item.content.toLocaleLowerCase().includes(keyword)),
      );
      const candidates = [
        ...(includeShown ? residentMatches : []),
        ...searchResult.retrieval.items,
      ];
      const memories = candidates
        .filter((item) => includeShown || (!alreadyShownIds.has(item.memoryId) && !residentContents.has(item.content)))
        .filter((item, index, all) => all.findIndex((candidate) => candidate.memoryId === item.memoryId) === index)
        .slice(0, limit)
        .map((item) => ({
          // memoryId 必须回传：companion_forget_memory 的参数就是它。漏了这条，
          // 她只能凭空编一个 uuid（实机 2026-09-21 编出 5e0a2b1c-3d4f-…），
          // 于是"忘掉"永远失败——而失败原因是"找不到"，看起来像她记错了。
          memoryId: item.memoryId,
          kind: item.kind,
          content: item.content,
          userConfirmed: item.userConfirmed,
          budgetTier: item.budgetTier,
          revision: item.revision,
        }));
      return {
        value: { memories, retrievalMode: searchResult.retrieval.mode },
        safeSummary: memories.length > 0
          ? includeArchived ? `在归档记忆中找到 ${memories.length} 条相关记录` : `找到 ${memories.length} 条相关记忆`
          : includeArchived ? "归档记忆中没有找到匹配记录" : "没有找到匹配的记忆",
      };
    }
    // ── 判断记录（40 §4.5.5 / §4.5.4，验收 A29 / A67）──
    //
    // 与上面那几个事实记忆工具的区别是**本质**的：那条路写的是「用户是什么样的人」，
    // 这条路写的是「**她**怎么理解刚才那件事」。两者混在一起，用户就会把她的
    // 推测当成事实——A67 明说「不能由成功回执证明真」。
    //
    // 所以下面每一步都在把「主观」这三个字钉进数据里：
    //   user_stated = false（判断永远不是"用户说的"）
    //   scope = 'workspace'（§4.5.5：不通过判断接口绕过跨空间限制）
    //   epistemic_status 由模型如实给，不是我们替它乐观
    case "companion_remember_judgment": {
      const text = String(args.text);
      const epistemicStatus = String(args.epistemicStatus);
      const claimedIds = Array.isArray(args.sourceEventIds)
        ? args.sourceEventIds.map((value) => String(value))
        : [];

      // §4.5.5：「无来源的用户判断不能写成长期记录。」
      // 而"模型编一个 sourceEventId"和"真的没有来源"在调用方眼里一模一样，
      // 所以这里**回查数据库**：只接受这一轮真实出现过的消息。
      // 查不到的那几条直接剔除；一条都不剩就拒写，并把理由说给模型听。
      const verified = claimedIds.length > 0
        ? await withWorkerWorkspaceTransaction(
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          async (tx) => {
            const rows = await tx.execute<{ id: string }>(sql`
              SELECT id::text AS id
                FROM companion_messages
               WHERE conversation_id = ${event.read.conversationId}::uuid
                 AND workspace_id = ${event.ctx.workspaceId}
                 AND user_id = ${event.read.userId}
                 AND id = ANY(${claimedIds}::uuid[])
            `);
            return new Set((Array.isArray(rows) ? rows : []).map((row) => row.id));
          },
        )
        : new Set<string>();

      const sourceEventIds = claimedIds.filter((id) => verified.has(id));
      if (sourceEventIds.length === 0) {
        throw new CompanionToolError(
          "这条判断指不出依据的消息 ID，这次没有记录（不能凭空写一条无来源的判断）",
        );
      }
      if (sourceEventIds.length !== claimedIds.length) {
        logger.warn(
          {
            runId: event.read.runId,
            claimed: claimedIds.length,
            verified: sourceEventIds.length,
          },
          "judgment cited message ids that do not exist in this conversation; the unverifiable ones were dropped",
        );
      }

      const inserted = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
            INSERT INTO assistant_memory_items
              (workspace_id, user_id, kind, content, source_event_ids,
               source_speaker, source_basis, applies_when,
               user_stated, user_confirmed,
               candidate, importance, confidence, scope, source_type,
               epistemic_status, author_type, embedding_status, created_at, updated_at)
            VALUES
              (${event.ctx.workspaceId}, ${event.read.userId}, 'judgment', ${text},
               ${toTextArrayLiteral(sourceEventIds)}::text[], 'companion', 'companion_interpretation', NULL,
               false, false,
               false, 0.3, 0.6, 'workspace', 'model_inferred',
               ${epistemicStatus}, 'companion', 'none', now(), now())
            RETURNING id
          `);
          return rows[0];
        },
      );

      return {
        value: {
          memoryId: inserted?.id ?? null,
          // 刻意把「这只是她的理解」放进回执：模型下一句就不该把它当事实说出去。
          epistemicStatus,
          subjective: true,
        },
        safeSummary: "记下了她对这一件事的理解（这是她的看法，不是事实）",
      };
    }
    case "companion_save_memory": {
      // 写入口径对齐 API memory-service.upsertMemory 的"用户明确陈述"路径：
      // user_stated/user_confirmed=true、candidate=false、embedding_status='pending'
      // （embedding 流水线随后补向量）。参数 schema 显式拒绝 >200 字，不再裁短后写入。
      // 与 API 的差异：不做 markMemoryConflictIfSimilar 相似冲突标记（v1 接受，冲突
      // 由记忆中心的冲突检查兜底）。
      const kind = String(args.kind);
      const content = String(args.content);
      const sourceQuote = typeof args.sourceQuote === "string" ? args.sourceQuote : null;
      const appliesWhen = typeof args.appliesWhen === "string" ? args.appliesWhen : null;
      const validUntil = typeof args.validUntil === "string" ? args.validUntil : null;
      const inserted = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const temporal = await readCompanionMemoryWriteSource(tx, event, {
            kind, content, sourceQuote, appliesWhen, validUntil,
          });
          const rows = await tx.execute<{ id: string }>(sql`
            INSERT INTO assistant_memory_items
              (workspace_id, user_id, kind, content, source_event_id, source_session_id,
               source_speaker, source_basis, applies_when, valid_from, valid_until,
               user_stated, user_confirmed,
               candidate, importance, confidence, scope, source_type, pinned, embedding_status)
            VALUES
              (${event.ctx.workspaceId}, ${event.read.userId}, ${kind}, ${content},
               ${event.read.userMessageId}, ${event.read.conversationId}, 'user', 'direct_statement',
               ${temporal.appliesWhen}, ${temporal.createdAt}, ${temporal.validUntil ? new Date(temporal.validUntil) : null},
               true, true, false, 0.8, 0.9, 'workspace', 'user_stated', false, 'pending')
            RETURNING id
          `);
          return rows[0];
        },
      );
      return {
        value: { memoryId: inserted?.id ?? null, kind },
        safeSummary: `已记住（${content.slice(0, 60)}${content.length > 60 ? "…" : ""}）`,
      };
    }
    case "companion_revise_memory": {
      // `guided` 在 proposal decision 链路调用 API correctMemory；`full` 预授权走这里。
      // 保持同一 ID 和来源，由 DB revision trigger 追加旧版本，并用 expectedRevision 做 CAS。
      const memoryId = String(args.memoryId);
      const expectedRevision = Number(args.expectedRevision);
      const content = String(args.content);
      const hasAppliesWhen = Object.hasOwn(args, "appliesWhen");
      const appliesWhen = typeof args.appliesWhen === "string" ? args.appliesWhen : null;
      const hasValidFrom = Object.hasOwn(args, "validFrom");
      const validFrom = typeof args.validFrom === "string" ? new Date(args.validFrom) : null;
      const hasValidUntil = Object.hasOwn(args, "validUntil");
      const validUntil = typeof args.validUntil === "string" ? new Date(args.validUntil) : null;
      const outcome = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${companionMemoryMutationLockKey(event.read.userId)}, 0)
            )
          `);
          const currentRows = await tx.execute<{
            id: string;
            revision: number;
            kind: string;
            scope: string;
            content: string;
            applies_when: string | null;
            valid_from: Date | string | null;
            valid_until: Date | string | null;
            source_event_id: string | null;
          }>(sql`
            SELECT id, revision, kind, scope, content, applies_when, valid_from, valid_until,
                   source_event_id
              FROM assistant_memory_items
             WHERE id = ${memoryId}::uuid
               AND workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND deleted_at IS NULL
             FOR UPDATE
          `);
          const current = (Array.isArray(currentRows) ? currentRows : [])[0];
          if (!current) return { kind: "missing" as const };
          if (current.revision !== expectedRevision) return { kind: "stale" as const };
          const currentValidFrom = current.valid_from === null
            ? null
            : new Date(current.valid_from).toISOString();
          const currentValidUntil = current.valid_until === null
            ? null
            : new Date(current.valid_until).toISOString();
          const nextValidFrom = hasValidFrom
            ? validFrom?.toISOString() ?? null
            : currentValidFrom;
          const nextValidUntil = hasValidUntil
            ? validUntil?.toISOString() ?? null
            : currentValidUntil;
          if (nextValidFrom && nextValidUntil && nextValidUntil <= nextValidFrom) {
            throw new CompanionToolError("记忆的有效期结束时间必须晚于开始时间，这次没有改动");
          }
          const nextAppliesWhen = hasAppliesWhen ? appliesWhen : current.applies_when;
          const changed = content !== current.content
            || (hasAppliesWhen && nextAppliesWhen !== current.applies_when)
            || (hasValidFrom && nextValidFrom !== currentValidFrom)
            || (hasValidUntil && nextValidUntil !== currentValidUntil);
          if (!changed) return { kind: "unchanged" as const, revision: current.revision };

          // 账号级（跨空间）范围守卫（42 阶段 1 E）：`full` 档这条裸 SQL 绕开了 API 的
          // `correctMemory`，所以它**自己**也要过一次判据——判据与那条共用同一份
          // （`@astella/shared/companion-memory-scope`），不留第二套正则。
          // 判的是**最终形状**：修订不改 scope，所以 global 行改完仍是账号级的；
          // 条件省略即沿用库里那一条，照样要判。拦在 UPDATE 之前，源行、副本、
          // CAS 修订号与只追加历史都不动。
          const accountScope = accountPreferenceWriteDecision({
            scope: current.scope,
            kind: current.kind,
            content,
            appliesWhen: nextAppliesWhen,
          });
          if (!accountScope.ok) {
            throw new CompanionToolError(
              `这条账号级规则没有改动：${accountPreferenceRejectionMessage(accountScope.reason)}`,
            );
          }

          const updatedRows = await tx.execute<{ revision: number }>(sql`
            UPDATE assistant_memory_items
               SET content = ${content},
                   applies_when = CASE WHEN ${hasAppliesWhen} THEN ${appliesWhen} ELSE applies_when END,
                   valid_from = CASE WHEN ${hasValidFrom} THEN ${validFrom} ELSE valid_from END,
                   valid_until = CASE WHEN ${hasValidUntil} THEN ${validUntil} ELSE valid_until END,
                   user_stated = true,
                   user_confirmed = true,
                   candidate = false,
                   source_type = 'user_stated',
                   author_type = 'user',
                   author_id = ${event.read.userId}::uuid,
                   epistemic_status = 'supported',
                   embedding_status = 'pending',
                   updated_at = now()
             WHERE id = ${memoryId}::uuid
               AND workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND revision = ${expectedRevision}
               AND deleted_at IS NULL
            RETURNING revision
          `);
          const updated = (Array.isArray(updatedRows) ? updatedRows : [])[0];
          if (!updated) return { kind: "stale" as const };

          // 和 API correctMemory 一样，修订后不让旧候选继续挂在收件箱里。
          await tx.execute(sql`
            SELECT public.astella_close_companion_memory_delivery(
              ${event.ctx.workspaceId}::uuid,
              ${event.read.userId}::uuid,
              ${memoryId}::uuid,
              'acted'
            )
          `);

          // 保持 API correction 的相似内容冲突提示：相似的其它活记忆归入同组，
          // 不替用户静默覆盖或删除它们。
          const similarRows = await tx.execute<{ id: string }>(sql`
            SELECT id FROM assistant_memory_items
             WHERE workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND deleted_at IS NULL
               AND (valid_from IS NULL OR valid_from <= now())
               AND (valid_until IS NULL OR valid_until > now())
               AND id <> ${memoryId}::uuid
               AND similarity(content, ${content}) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
             LIMIT 1
          `);
          const similarId = (Array.isArray(similarRows) ? similarRows : [])[0]?.id;
          if (similarId) {
            const conflictGroup = randomUUID();
            await tx.execute(sql`
              UPDATE assistant_memory_items
                 SET conflict_group = ${conflictGroup}::uuid, updated_at = now()
               WHERE id IN (${memoryId}::uuid, ${similarId}::uuid)
            `);
          }
          return { kind: "revised" as const, revision: updated.revision };
        },
      );
      if (outcome.kind === "missing") throw new CompanionToolError("没找到这条仍然有效的记忆，这次没有改动");
      if (outcome.kind === "stale") throw new CompanionToolError("这条记忆刚刚更新过，我没有覆盖；请重新读取后再修订");
      return {
        value: { memoryId, revision: outcome.revision, changed: outcome.kind === "revised" },
        safeSummary: outcome.kind === "revised"
          ? `已修订记忆到第 ${outcome.revision} 版，原始来源保留`
          : "记忆内容没有变化",
      };
    }
    case "companion_move_memory": {
      // A budget-tier move changes future prompt eligibility, so it belongs with the
      // reversible direct-write tools rather than the read executor.
      const memoryId = String(args.memoryId);
      const tier = String(args.tier);
      const rows = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => tx.execute<{ result: { status: string; [key: string]: unknown } }>(sql`
          SELECT public.astella_move_companion_memory_budget_tier_v1(
            ${event.ctx.workspaceId}::uuid,
            ${event.read.userId}::uuid,
            ${memoryId}::uuid,
            ${tier},
            'companion',
            NULL::uuid
          ) AS result
        `),
      );
      const outcome = rows[0]?.result;
      if (!outcome) throw new CompanionToolError("记忆容量调整没有得到确定回执，这次没有报告完成");
      const safeSummary = outcome.status === "moved"
        ? "已调整这条记忆的容量层"
        : outcome.status === "unchanged"
          ? "这条记忆已经在该容量层"
          : outcome.status === "capacity"
            ? "常驻预算已满；我没有自动挪动其他记忆"
            : outcome.status === "not_eligible"
              ? "候选记忆尚未确认，不能设为常驻"
              : "没有找到这条仍然有效的记忆";
      return { value: outcome, safeSummary };
    }
    // Procedural 手册展开（40 §4.6.10 / A69）。
    //
    // 形状与 read_memory 完全一致：**稳定 ID + 确切版本**，版本不符即拒。
    // 手册会随用户纠正升版，所以拿着上一版的 id 来读不能悄悄拿到新内容——
    // 否则「她读的是哪一版」这个问题永远没人答得上来。
    case "companion_read_playbook": {
      const playbookId = String(args.playbookId);
      const expectedVersion = Number(args.expectedVersion);
      if (!event.read.playbookCatalog.some(entry => entry.playbookId === playbookId && entry.version === expectedVersion)) {
        throw new CompanionToolError("这个方法不在本轮有效目录中，请重新核对。");
      }
      const playbook = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        (tx) => readPlaybookById(
          tx,
          { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
          playbookId,
          expectedVersion,
          { kind: "conversation", id: event.read.runId, revision: 1,
            sourceKey: `${event.read.runId}:${playbookId}:${expectedVersion}` },
        ),
      );
      if (!playbook) {
        throw new CompanionToolError("手册目录里没有这一条，或它的版本已经变了；这次没有展开正文");
      }
      return {
        value: {
          playbookId: playbook.playbookId,
          title: playbook.title,
          triggerCondition: playbook.triggerCondition,
          steps: playbook.steps,
          exceptions: playbook.exceptions,
          version: playbook.version,
          epistemicStatus: playbook.epistemicStatus,
        },
        // 说明里带上依据状态：争议的手册不能被当成已定的做法照做。
        safeSummary: playbook.epistemicStatus === "disputed"
          ? `展开了一条依据待核对的手册：${playbook.title}`
          : `展开了一条手册：${playbook.title}`,
      };
    }
    // 日记读回（40 §6 / A08）。
    //
    // 「聊聊这篇」点下去只是打开对话并附上引用；用户继续输入之后她才调这个工具。
    // 三条边界：
    //  1. **只读当前空间**。workspace 取会话上下文，不来自参数——否则这就是一条
    //     由模型指定读哪一篇的跨空间通道。
    //  2. **版本必须对上**。§5.5 保证已发布成稿不被后台重跑静默替换，所以用户
    //     看到的那一版是稳定的；版本不符就说"你看到的那一版已经不在了"，
    //     而不是悄悄拿新版顶上——那会让她对着另一篇东西解释。
    //  3. **撤回/删除后不再读**。`deleted_at IS NULL` 交给 RLS 与 WHERE 双重保证。
    case "companion_read_diary": {
      const date = String(args.date);
      const expectedVersion = Number(args.expectedVersion);
      const diary = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          const rows = await tx.execute<{
            summary: string; blocks: unknown; selection_reason: string | null;
            selected_id: string | null; revision: number; status: string;
          }>(sql`
            SELECT summary, blocks, selection_reason, selected_id, revision, status
              FROM companion_daily_summaries
             WHERE workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND date = ${date}
               -- §10「删除日记」：删掉的作品不该再被读出来。
               -- hidden_at 不在这里挡——隐藏只是不进列表，用户明确打开
               -- 之后仍然可以接着聊那一句（合同就是这么分这两种语义的）。
               AND deleted_at IS NULL
             LIMIT 1
          `);
          return rows[0] ?? null;
        },
      );
      if (!diary) {
        throw new CompanionToolError("这一天没有日记可以读");
      }
      if (Number(diary.revision) !== expectedVersion) {
        throw new CompanionToolError(
          "你看到的那一版已经不在了；请先确认现在是第几版，我不拿别的版本顶上",
        );
      }
      if (diary.status !== "generated") {
        throw new CompanionToolError("这一天她没能写下来，没有成稿可以聊");
      }
      return {
        value: {
          date,
          version: Number(diary.revision),
          summary: diary.summary,
          blocks: Array.isArray(diary.blocks) ? diary.blocks : [],
          // 选材理由与选中 id 一并给出：她需要能说清"我为什么写这篇"，
          // 而 A09 要求区分作品与真实事件——有这两个字段才分得开。
          selectionReason: diary.selection_reason,
          selectedId: diary.selected_id,
          // 显式告诉模型这是**她的作品**，不是发生过的现实事件。
          kindOfContent: "companion_work",
        },
        safeSummary: `读到了 ${date} 的那篇日记`,
      };
    }
    case "companion_forget_memory": {
      // 软删（deleted_at）：星图/记忆中心的既有语义就是按 deleted_at 过滤，
      // 硬删会把历史一起抹掉。免二次确认的理由与 cancel_reminder 同：
      // 用户此刻正明确说"别记着这个"。
      const memoryId = String(args.memoryId);
      const forgotten = await withWorkerWorkspaceTransaction(
        { workspaceId: event.ctx.workspaceId, userId: event.read.userId },
        async (tx) => {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${companionMemoryMutationLockKey(event.read.userId)}, 0)
            )
          `);
          const rows = await tx.execute<{ kind: string; sourceEventId: string | null; content: string }>(sql`
            UPDATE assistant_memory_items
               SET deleted_at = now(), updated_at = now()
             WHERE id = ${memoryId}::uuid
               AND workspace_id = ${event.ctx.workspaceId}
               AND user_id = ${event.read.userId}
               AND deleted_at IS NULL
            RETURNING kind, source_event_id AS "sourceEventId", left(content, 60) AS content
          `);
          const forgotten = (Array.isArray(rows) ? rows : [])[0] ?? null;
          if (!forgotten) return null;
          if (forgotten.sourceEventId !== null) {
            await tx.execute(sql`
              INSERT INTO assistant_memory_source_suppressions (user_id, kind, source_event_id)
              VALUES (${event.read.userId}, ${forgotten.kind}, ${forgotten.sourceEventId})
              ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
            `);
          }
          await tx.execute(sql`
            SELECT public.astella_close_companion_memory_delivery(
              ${event.ctx.workspaceId}::uuid,
              ${event.read.userId}::uuid,
              ${memoryId}::uuid,
              'dismissed'
            )
          `);
          return forgotten;
        },
      );
      if (!forgotten) {
        // 这句会**同时**上屏（safeSummary）并回进模型上下文，所以两个读者都要顾到：
        // 屏上这句只说"没找到"；"该先 recall 再删、不许凭印象猜 id"那条指引写在工具自己的
        // 描述里（`companion-agent-registry.ts:144`），每一次请求都带着，比写在错误里更稳。
        throw new CompanionToolError(
          "那一条记忆我没找到，可能它已经不在了。想删哪条的话，先提醒我是哪回的事。",
        );
      }
      return {
        value: { memoryId },
        safeSummary: `已忘掉（${forgotten.content}）`,
      };
    }
    default:
      throw new CompanionToolError("这一步不是记忆工具，不该走记忆这一族");
  }
}
