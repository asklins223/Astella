/**
 * Card Generation V2 — GenerationRun 查询与动作端点（方案 20 §17.1–17.2）。
 *
 * 2026-10-04：创建事务本体已下沉到制卡领域包 `@ailearn/card-generation`
 * （`createGenerationRunInTransaction`）。本文件保留**原来的公开签名**
 * `createGenerationRunV2(ctx, noteVersionId, body, idempotencyKey)`：它仍然
 * 用 `withWorkspaceTransaction` 开事务，然后把执行器交给那一份唯一实现去跑。
 * 路由、测试与错误边界的调用点一行都没改。
 */

import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationPlansV2,
  cardGenerationCandidatesV2,
  cardCandidateQualityReportsV2,
  cardGenerationEventsV2,
  cardGenerationRunOutboxV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import type { CreateCardGenerationRunRequestV2 } from "@ailearn/shared/card-generation-v2-contracts";
import {
  cardGenerationCandidateQualityIssueV1Schema,
  isCardGenerationReviewOpen,
} from "@ailearn/shared/card-generation-desktop-contracts";
// 「在制」状态集合的唯一常量；`listActiveGenerationRunsV2` 与创建事务里那条
// (笔记, 人) 在制守卫读的是同一个数组。
import {
  ACTIVE_GENERATION_RUN_STATUSES,
  createGenerationRunInTransaction,
} from "@ailearn/card-generation";
import {
  sanitizeEventPayloadV2,
  CardGenerationV2ServiceError,
  checkSourceOutdated,
  computeSourceOutdatedForRunsV2,
  computeSourceCappedForRunsV2,
  insertEvent,
  readGenerationProgressV2,
  serializeRunPublic,
  serializeCandidatePublic,
  summarizePlanPracticeQuotaV2,
  type RunContext,
} from "./helpers.ts";

/** R34/§22.6：解析正整数 env（非法/非正 → 默认值）。 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export async function createGenerationRunV2(
  ctx: RunContext,
  noteVersionId: string,
  body: CreateCardGenerationRunRequestV2,
  idempotencyKey: string,
): Promise<{ runId: string; status: string }> {
  // 限额是**宿主**的决定（每个部署的 abuse 预算不同），所以 env 解析留在这一侧，
  // 作为明确 options 传进领域实现——领域包不读 env。默认值与解析规则与下沉前一致。
  return withWorkspaceTransaction(ctx, async (tx) =>
    createGenerationRunInTransaction(tx, ctx, noteVersionId, body, idempotencyKey, {
      maxInFlightRuns: parsePositiveIntEnv("CARD_GENERATION_V2_MAX_INFLIGHT_RUNS", 3),
      dailyRunLimit: parsePositiveIntEnv("CARD_GENERATION_V2_DAILY_RUN_LIMIT", 50),
    }),
  );
}

export async function getGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (rows.length === 0) return null;
    // 进度只在单 run 读取时聚合：这是生成工作台与笔记页订阅后重读的那一条，
    // 列表接口（active runs）不带，避免每次房间刷新都多打一遍候选表。
    const progress = await readGenerationProgressV2(
      tx, ctx.workspaceId, runId, rows[0].currentPlanVersion,
    );
    return serializeRunPublic(rows[0], tx, progress);
  });
}

/** Owner-only recovery query for Room/Desk; terminal runs are not resumable. */
export async function listActiveGenerationRunsV2(ctx: RunContext) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    // 「在制」集合与创建事务里那条 (笔记, 人) 守卫读的是**同一个**常量（领域包导出，
    // 上面 import 进来的）。两处各写一份时，一处算 `review_ready` 在制、另一处不算，
    // 屏上就会出现「这一批在列表里、却又说没有在制批次」的自相矛盾。
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        inArray(cardGenerationRunsV2.status, [...ACTIVE_GENERATION_RUN_STATUSES]),
      ))
      .orderBy(desc(cardGenerationRunsV2.updatedAt))
      .limit(20);
    // 一批评判据一次算完（2 次往返），不再逐行把各自的源笔记全文搬回来。
    const outdatedByRunId = await computeSourceOutdatedForRunsV2(tx, rows);
    const cappedByRunId = await computeSourceCappedForRunsV2(tx, rows);
    // `serializeRunPublic` 是 async：这里必须把这一批 await 完再交出去，否则交出去的是
    // 一排 Promise，投影层的 zod 会把每个元素判成 `invalid_type: promise`，
    // 于是**只要用户手上真的有一个在制的生成**这个恢复端点就 500（0 个的空间反而 200）。
    return await Promise.all(
      rows.map((row) => serializeRunPublic(
        row, tx, null, outdatedByRunId.get(row.id) ?? false, cappedByRunId.get(row.id) ?? null,
      )),
    );
  });
}

/**
 * The note's most recent run, whatever its status. A feedback-carrying
 * regeneration has to name the run it is answering, and nothing else in the
 * desktop projection says which run that was once it has finished.
 */
export async function getLatestGenerationRunForNoteV2(ctx: RunContext, noteId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.noteId, noteId),
        eq(cardGenerationRunsV2.userId, ctx.userId),
      ))
      .orderBy(desc(cardGenerationRunsV2.updatedAt))
      .limit(1);
    if (rows.length === 0) return null;
    return serializeRunPublic(rows[0], tx);
  });
}

export async function getGenerationRunPlanV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const planRows = await tx.select().from(cardGenerationPlansV2)
      .where(and(
        eq(cardGenerationPlansV2.runId, runId),
        eq(cardGenerationPlansV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationPlansV2.planVersion, runRows[0].currentPlanVersion),
      ))
      .limit(1);
    if (planRows.length === 0) return null;

    const p = planRows[0];
    return {
      version: 2 as const,
      runId: p.runId,
      inputSnapshotHash: p.inputSnapshotHash,
      cardContentEpoch: p.cardContentEpoch,
      planRevisionId: p.planRevisionId,
      planVersion: p.planVersion,
      previousPlanRevisionId: p.previousPlanRevisionId,
      result: p.result,
      atomDecisions: p.atomDecisions,
      planHash: p.planHash,
    };
  });
}

export async function getGenerationRunCandidatesV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select({ id: cardGenerationRunsV2.id, currentPlanVersion: cardGenerationRunsV2.currentPlanVersion })
      .from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    // 只要每个候选的**最新修订**。以前是把这一个 run 的全部修订行整体 `select()` 回来
    // （每行 5 个 jsonb，含题面与答案侧字段），再在 TS 里用 Set 去重——传输量随重写次数
    // 线性放大，而屏幕上永远只用得到最新那一版。改成在 SQL 侧筛"不存在比自己更新的同
    // 候选修订"：等价性在 dev 库上逐行对过（两种写法行数一致、差集为空），相关子查询
    // 的探测键正好是 `cg_v2_cand_run_idx (workspace_id, run_id, candidate_id, revision)`
    // 的全部列——0272 之后这张表上只有这一棵候选索引（原先那棵只把 revision 写成 DESC 的
    // `cg_v2_cand_latest_idx` 与它逐字节同形，普通 btree 反扫即可，已删）。
    const latest = await tx.select().from(cardGenerationCandidatesV2)
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
        sql`NOT EXISTS (
          SELECT 1 FROM public.card_generation_candidates_v2 newer
          WHERE newer.workspace_id = ${cardGenerationCandidatesV2.workspaceId}
            AND newer.run_id = ${cardGenerationCandidatesV2.runId}
            AND newer.candidate_id = ${cardGenerationCandidatesV2.candidateId}
            AND newer.revision > ${cardGenerationCandidatesV2.revision}
        )`,
      ));
    const qualityIssuesByRevisionId = new Map<string, ReturnType<typeof serializeCandidatePublic>["qualityIssues"]>();
    if (latest.length > 0) {
      const qualityReports = await tx.select({
        candidateRevisionId: cardCandidateQualityReportsV2.candidateRevisionId,
        report: cardCandidateQualityReportsV2.report,
      }).from(cardCandidateQualityReportsV2)
        .where(and(
          eq(cardCandidateQualityReportsV2.workspaceId, ctx.workspaceId),
          eq(cardCandidateQualityReportsV2.reportType, "grounding"),
          inArray(cardCandidateQualityReportsV2.candidateRevisionId, latest.map((row) => row.candidateRevisionId)),
        ))
        .orderBy(desc(cardCandidateQualityReportsV2.createdAt));

      for (const qualityReport of qualityReports) {
        // Reports are immutable and tied to the exact revision. If a rerun wrote
        // more than one report, the ordered first row is the current result.
        if (qualityIssuesByRevisionId.has(qualityReport.candidateRevisionId)) continue;
        const rawIssues = qualityReport.report && typeof qualityReport.report === "object"
          ? (qualityReport.report as { issues?: unknown }).issues
          : undefined;
        const issues = Array.isArray(rawIssues)
          ? rawIssues.flatMap((issue) => {
            const parsed = cardGenerationCandidateQualityIssueV1Schema.safeParse(issue);
            return parsed.success ? [parsed.data] : [];
          }).slice(0, 40)
          : [];
        qualityIssuesByRevisionId.set(qualityReport.candidateRevisionId, issues);
      }
    }
    const candidates = latest.map((row) => serializeCandidatePublic(
      row,
      qualityIssuesByRevisionId.get(row.candidateRevisionId) ?? [],
    ));

    const planRows = await tx.select({ result: cardGenerationPlansV2.result }).from(cardGenerationPlansV2)
      .where(and(
        eq(cardGenerationPlansV2.runId, runId),
        eq(cardGenerationPlansV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationPlansV2.planVersion, runRows[0].currentPlanVersion),
      ))
      .limit(1);

    return {
      candidates,
      practiceQuota: summarizePlanPracticeQuotaV2(
        planRows[0]?.result,
        candidates.map((candidate) => ({
          planObjectiveLocalId: candidate.planObjectiveLocalId,
          qualityState: candidate.qualityState,
          practiceItem: candidate.practiceItem,
        })),
      ),
    };
  });
}

export async function getGenerationRunEventsV2(ctx: RunContext, runId: string, afterSeq = 0) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const events = await tx.select().from(cardGenerationEventsV2)
      .where(and(
        eq(cardGenerationEventsV2.runId, runId),
        eq(cardGenerationEventsV2.workspaceId, ctx.workspaceId),
        sql`${cardGenerationEventsV2.eventSeq} > ${afterSeq}`,
      ))
      .orderBy(cardGenerationEventsV2.eventSeq)
      .limit(100);

    return events.map((e) => ({
      eventSeq: e.eventSeq,
      eventType: e.eventType,
      // §17.1/§22.3：SSE/事件流 payload 白名单裁剪，私有内容字段不透传。
      payload: sanitizeEventPayloadV2(e.payload as Record<string, unknown>),
      createdAt: e.createdAt.toISOString(),
    }));
  });
}

export async function closeGenerationRunV2(ctx: RunContext, runId: string, expectedReviewDraftRevision: number) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const run = runRows[0];
    // 审核开放态即可结束审核。needs_attention 的 run 也归审核页所有，用户决定
    // 一张都不要之后必须能把这次审核收尾，否则它只能永远挂在恢复态里。
    if (!isCardGenerationReviewOpen(run.status)) {
      throw new CardGenerationV2ServiceError("invalid_state", 409, "只有 review_ready 状态的运行可以关闭");
    }
    if (run.reviewDraftRevision !== expectedReviewDraftRevision) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
    }

    // Mark all undecided candidates as rejected
    await tx.update(cardGenerationCandidatesV2)
      .set({ reviewDecision: "reject", reviewReasonCode: "user_closed_without_activation", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationCandidatesV2.reviewDecision, "undecided"),
      ));

    const closedRows = await tx.update(cardGenerationRunsV2)
      .set({
        status: "closed_without_activation",
        reviewDraftRevision: run.reviewDraftRevision + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        // CAS：确保并发 close 不覆盖彼此（方案 20 §17.1）
        eq(cardGenerationRunsV2.reviewDraftRevision, expectedReviewDraftRevision),
      ))
      .returning({ id: cardGenerationRunsV2.id, reviewDraftRevision: cardGenerationRunsV2.reviewDraftRevision });

    if (closedRows.length === 0) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
    }

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.closed_without_activation", {});

    return {
      runId,
      status: "closed_without_activation",
      reviewDraftRevision: closedRows[0].reviewDraftRevision,
    };
  });
}

export async function cancelGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const run = runRows[0];
    // `checking` 必须可取消：那是内容检查那次模型调用在途的 15–30 秒，屏上的
    // 「取消生成」在整个过程中都是亮的。服务端此前不收这一档，于是用户按下它必然
    // 撞 409「当前状态不可取消」——一颗按下去只会失败��按钮。
    const cancellable = ["queued", "source_sealing", "planning", "authoring", "checking", "review_ready"];
    if (!cancellable.includes(run.status)) {
      throw new CardGenerationV2ServiceError("invalid_state", 409, "当前状态不可取消");
    }

    // P12 FIX: CAS update — ensure status hasn't changed concurrently
    const cancelled = await tx.update(cardGenerationRunsV2)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.status, run.status),
      ))
      .returning({ id: cardGenerationRunsV2.id });
    if (cancelled.length === 0) {
      throw new CardGenerationV2ServiceError("stale_run_status", 409, "运行状态已被并发修改，请刷新");
    }

    return { runId, status: "cancelled" };
  });
}

/**
 * 就地重试一次质量门禁失败的 run（2026-09-18，补齐产品缺口）。
 *
 * ## 为什么需要它
 * 当**唯一候选**没被放行（例如批量内容检查判它依据不足）时，整条 run 会终态化为
 * `needs_attention`，且没有候选可审核。此前恢复契约只签发
 * `return_note` / `start_new_generation`——用户唯一的出路是**回笔记重开一次全新生成**：
 * 重新封存来源、重跑整条链、重付全部 token（实测一次 25–55s），而失败往往只是
 * 检查的一次判断波动（同一 prompt 的相邻两次运行结论可以不同）。
 *
 * 这个入口让"再试一次"变成一次显式、低成本、用户可见的选择：复用已经封存的来源与
 * 输入快照，只派发一次**重排**（简化链的 `mode: "replan"` 那一档：新 plan revision +
 * 上一版没激活的候选 supersede + 重新生成并检查）。
 *
 * ## 为什么不是自动重试
 * 契约与既有纪律一致：恢复动作只由服务端签发、由**用户点击**触发。自动重试会把
 * "模型判断波动"变成不可见的 token 消耗，也会掩盖真正的确定性缺陷。
 *
 * ## 守卫（服务端独立校验，不信任投影）
 * - run 必须存在；
 * - status 必须是 `needs_attention`（failed/stale/其它一律拒绝）；
 * - `error_code` 必须是 `quality_gate_failed`（provider/配置类失败重跑没有意义；
 *   实测 `generation_failed` + "missing API key" 会在重试后原样再失败一次）；
 * - 来源不得过期（对着过期来源重跑只会再失败一次）；
 * - 不得已有在飞行的 outbox 任务（双击/并发重试 → 409，避免重复烧 token）。
 */
export async function retryGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;
    const run = runRows[0];

    if (run.status !== "needs_attention") {
      throw new CardGenerationV2ServiceError(
        "invalid_state",
        409,
        "只有需要处理（needs_attention）的运行可以就地重试",
      );
    }
    if (run.errorCode !== "quality_gate_failed") {
      throw new CardGenerationV2ServiceError(
        "not_retryable",
        409,
        "这次失败不是质量门禁造成的，就地重试无法改变结果；请修复配置或重新生成",
      );
    }
    // 来源过期守卫：run 绑定的 note 版本已不是最新 → 重跑只会对着过期内容再产出一批
    // 注定要被 source_outdated 标记的候选，用户应当先回笔记重开一次生成。
    if (await checkSourceOutdated(tx, ctx.workspaceId, ctx.userId, run.noteId, run.noteVersionId, run.sourceContentHash)) {
      throw new CardGenerationV2ServiceError(
        "source_outdated",
        409,
        "笔记已有新版本，请回到笔记重新生成",
      );
    }

    // 在飞行的任务守卫：重试期间已有 worker 在跑 → 拒绝，避免同一 run 并发重跑。
    const inFlight = await tx
      .select({ id: cardGenerationRunOutboxV2.id })
      .from(cardGenerationRunOutboxV2)
      .where(and(
        eq(cardGenerationRunOutboxV2.runId, runId),
        eq(cardGenerationRunOutboxV2.workspaceId, ctx.workspaceId),
        inArray(cardGenerationRunOutboxV2.status, ["pending", "processing"]),
      ))
      .limit(1);
    if (inFlight.length > 0) {
      throw new CardGenerationV2ServiceError("retry_in_flight", 409, "这次运行仍在处理中，请稍后再试");
    }

    // CAS：只有仍是 needs_attention 才允许推进，避免与并发动作竞争。
    // 状态回到 checking（工作态）并清掉失败码——用户界面应立即体现"又动起来了"，
    // 而不是继续显示"需要处理"直到 worker 更新。
    const advanced = await tx.update(cardGenerationRunsV2)
      .set({ status: "checking", errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.status, "needs_attention"),
      ))
      .returning({ id: cardGenerationRunsV2.id });
    if (advanced.length === 0) {
      throw new CardGenerationV2ServiceError("stale_run_status", 409, "运行状态已被并发修改，请刷新");
    }

    // 39d W7-7：就地重试走简化链的**重排**那一档（同一发 jobType，`mode: "replan"` 区分来意）
    // ——同一 run 上再开一版计划，上一版没激活的候选由 worker 标 superseded 让路。
    // 不传 feedbackReasonCodes —— 用户没有给反馈，他只是要求再试一次。
    await tx.insert(cardGenerationRunOutboxV2).values({
      workspaceId: ctx.workspaceId,
      runId,
      jobType: "card_generation_simplified_v1",
      payload: { runId, workspaceId: ctx.workspaceId, mode: "replan" },
      status: "pending",
    });

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.retry_requested", {
      reason: "user_requested_after_quality_gate",
    });

    return { runId, status: "checking" as const };
  });
}
