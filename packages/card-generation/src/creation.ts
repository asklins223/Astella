/**
 * 制卡创建事务（唯一实现）——§17.1 CARD-GEN-START-01。
 *
 * 2026-10-04：从 `apps/api/src/modules/card-generation-v2/generation-run-service.ts`
 * 的 `withWorkspaceTransaction` 回调**原样**搬过来。API 的 `createGenerationRunV2`
 * 仍然是原来的公开签名，它现在只是用 `withWorkspaceTransaction` 调这一份。
 *
 * ─── 搬过来时**唯一**的形状变化 ───
 * 并发上限与日限额不再由本模块读 env，而是由调用方显式传进来（`limits`）。
 * env 是**宿主**的决定（每个部署的 abuse 预算不同），领域服务读 env 就等于把
 * 宿主配置渗进领域层，于是同一个限额在测试里、在 worker 里、在别的宿主里会
 * 各自取到不同的值，而限额的算式只有一份——那种"一半可配一半硬编"的分叉最难查。
 * 解析规则（非法/非正 → 默认值）留在 API 那侧，与搬走前逐字相同。
 *
 * 下面的一切——查询顺序、advisory lock、幂等重放、笔记可见性、按 (笔记, 人) 的
 * 在制守卫、supersedes、四个哈希、seal 调用、事件顺序、semantic spec / input
 * snapshot 闭包、`card_generation_simplified_v1` 这一发 outbox——**一个字没改**。
 */
import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import {
  cardGenerationRunsV2,
  cardGenerationSemanticSpecsV2,
  cardGenerationRunOutboxV2,
  cardGenerationInputSnapshotsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { notes, noteVersions, noteBlocks } from "@ailearn/shared/db-schema/note";
// 笔记可见性的唯一判据，与 API 侧三十余处读点共用同一句（见
// `apps/api/src/modules/note/visibility.ts` 的转出说明）。
import { visibleNotesCondition } from "@ailearn/shared/note-visibility-condition";
import {
  createCardGenerationRunRequestV2Schema,
  type CreateCardGenerationRunRequestV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeGenerationSemanticSpecHashV2,
  computeGenerationFingerprintV2,
  computeInputSnapshotHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { CardGenerationV2ServiceError } from "./errors.ts";
import { insertEvent } from "./events.ts";
import { sealEvidenceSnapshotsV2 } from "./evidence-seal.ts";
import { ACTIVE_GENERATION_RUN_STATUSES, type RunContext } from "./types.ts";
import type { CardGenerationRunCreationTx } from "./transaction.ts";

const GENERATION_START_IDEMPOTENCY_DOMAIN = "card-generation-v2/idempotency-request";

/**
 * workspace 维度的 abuse 预算，由**调用方**从 env 解析后传入（本模块不读 env）。
 *
 * 两个数都必须是正整数：解析在 API 侧完成（非法/非正 → 各自的默认值）。
 */
export interface CardGenerationRunLimits {
  /** 同空间在途 run 上限（abuse/resource 防护）。 */
  maxInFlightRuns: number;
  /** 同空间 24 小时 run 次数上限。 */
  dailyRunLimit: number;
}

/**
 * §17.1 / CARD-GEN-START-01：同一幂等键只有在 request payload 完全一致时才可 replay。
 * 老数据缺少 rawRequest 时按冲突处理，避免把未知 payload 当成安全 replay。
 */
function assertGenerationStartReplay(
  existing: typeof cardGenerationRunsV2.$inferSelect,
  requestHash: string,
): { runId: string; status: string } {
  const snapshot = existing.inputSnapshot;
  const rawRequest =
    typeof snapshot === "object" && snapshot !== null && "rawRequest" in snapshot
      ? snapshot.rawRequest
      : undefined;
  const parsed = createCardGenerationRunRequestV2Schema.safeParse(rawRequest);
  if (
    !parsed.success ||
    hashCanonicalV2(GENERATION_START_IDEMPOTENCY_DOMAIN, parsed.data) !== requestHash
  ) {
    throw new CardGenerationV2ServiceError(
      "idempotency_conflict",
      409,
      "幂等键已用于不同的生成请求",
    );
  }
  return { runId: existing.id, status: existing.status };
}

/**
 * 在**调用方给的那一段事务里**完成一次「请求生成」：幂等收口 → 额度检查 →
 * 按人判笔记可见 → 同篇在制守卫 → 封来源 → 排简化链那一发。
 *
 * 返回 `{ runId, status: "planning" }` —— 注意这只是**排队**：候选要等 worker
 * 消费 outbox 之后才会被写出来，"排到了"不等于"这批学习卡已经有了"。
 */
export async function createGenerationRunInTransaction(
  tx: CardGenerationRunCreationTx,
  ctx: RunContext,
  noteVersionId: string,
  body: CreateCardGenerationRunRequestV2,
  idempotencyKey: string,
  limits: CardGenerationRunLimits,
): Promise<{ runId: string; status: string }> {
  const requestHash = hashCanonicalV2(GENERATION_START_IDEMPOTENCY_DOMAIN, body);
  const existing = await tx
    .select()
    .from(cardGenerationRunsV2)
    .where(and(
      eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
      eq(cardGenerationRunsV2.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (existing.length > 0) {
    return assertGenerationStartReplay(existing[0], requestHash);
  }

  // R34/§22.6：workspace 维度生成并发与速率限制（abuse/resource 防护）。
  // advisory lock 串行化同 workspace 的限额检查与 run 创建，防并发绕过。
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`v2-generation-quota:${ctx.workspaceId}`}, 0)
    )
  `);

  // The first lookup is only an optimistic fast path. A concurrent request
  // may have committed while this transaction waited for the workspace lock;
  // re-check before quota work/insert so the unique idempotency key converges
  // to a strict replay instead of surfacing a unique-violation 500.
  const lockedExisting = await tx
    .select()
    .from(cardGenerationRunsV2)
    .where(and(
      eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
      eq(cardGenerationRunsV2.idempotencyKey, idempotencyKey),
    ))
    .limit(1);
  if (lockedExisting.length > 0) {
    return assertGenerationStartReplay(lockedExisting[0], requestHash);
  }

  const inFlightLimit = limits.maxInFlightRuns;
  const dailyLimit = limits.dailyRunLimit;
  const inFlightRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM card_generation_runs_v2
    WHERE workspace_id = ${ctx.workspaceId}
      AND status IN ('queued','source_sealing','planning','authoring','checking')
  `);
  const inFlight = Number((inFlightRows[0] as { n: number }).n ?? 0);
  if (inFlight >= inFlightLimit) {
    throw new CardGenerationV2ServiceError(
      "generation_concurrency_limit",
      429,
      `生成并发已达上限（${inFlightLimit} 个在途 Run），请稍后重试`,
    );
  }
  const dailyRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM card_generation_runs_v2
    WHERE workspace_id = ${ctx.workspaceId}
      AND created_at >= now() - interval '24 hours'
  `);
  const daily = Number((dailyRows[0] as { n: number }).n ?? 0);
  if (daily >= dailyLimit) {
    throw new CardGenerationV2ServiceError(
      "generation_daily_limit",
      429,
      `生成已达 24 小时上限（${dailyLimit} 次），请明日再试`,
    );
  }

  // 从 noteVersionId 查找版本，再推导 noteId
  const version = await tx.query.noteVersions.findFirst({
    where: eq(noteVersions.id, noteVersionId),
  });
  if (!version) throw new CardGenerationV2ServiceError("note_version_not_found", 404, "笔记版本不存在");
  const noteId = version.noteId;

  const note = await tx.query.notes.findFirst({
    // 看不见就当不存在（下面就是 note_not_found 404）：不能从别人仅自己可见的笔记起一批卡。
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, ctx.workspaceId), visibleNotesCondition(ctx.userId)),
  });
  if (!note) throw new CardGenerationV2ServiceError("note_not_found", 404, "笔记不存在");

  // 2026-09-20（实走复盘 #5）：一篇笔记同时只允许一批在制的学习卡。
  // 此前配额只落在 workspace 维度（在途数 + 日次数），同一篇笔记可以被反复
  // 点「生成学习卡」，每点一次就多一批候选卡。
  // 但"失败到没法就地重试"的那一批不能把笔记永久锁死：needs_attention 且失败原因
  // 不是质量门禁时，retry 端点自己会拒绝（`not_retryable`），cancel 也判
  // `invalid_state`，于是只剩"重新生成"这一条路——而这条守卫正是拦它的。
  // 判据与 retry 端点保持同一句话：只有 quality_gate_failed 的失败批次仍然算在制。
  //
  // 2026-09-21 真实生成实测修正：这里必须遍历**全部**在制行，不能只看一行。原先
  // `.limit(1)` 取到的是 Postgres 任意给的一行，同篇笔记既有已死批次又有一批还没
  // 审完时，只要先摸到已死那行就放行，结果新旧两批 review_ready 并存——正是用户
  // 抱怨的"旧卡不废弃"。只要还有一行活着就挡住。
  // 批次 4.5：这一位在制守卫按 **(笔记, 人)** 判，不是按笔记。原来的写法是"这篇
  // 有别人的一批在制，我就再也点不动生成"——而"这批是谁的"从来没人回答。今天
  // `card_generation.*` 只对 owner 开放所以看不出来，等成员能生成时那个洞就是
  // 别人占坑我进不去。
  const noteInFlight = await tx
    .select({ id: cardGenerationRunsV2.id, status: cardGenerationRunsV2.status, errorCode: cardGenerationRunsV2.errorCode })
    .from(cardGenerationRunsV2)
    .where(and(
      eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
      eq(cardGenerationRunsV2.noteId, noteId),
      eq(cardGenerationRunsV2.userId, ctx.userId),
      inArray(cardGenerationRunsV2.status, [...ACTIVE_GENERATION_RUN_STATUSES]),
    ));
  const liveBatch = noteInFlight.find((run) => !(
    run.status === "needs_attention" && run.errorCode !== "quality_gate_failed"
  ));
  if (liveBatch) {
    throw new CardGenerationV2ServiceError(
      "note_generation_in_flight",
      409,
      "这篇笔记已经有一批学习卡在生成或等待审核，请先处理完那一批",
    );
  }

  /**
   * 本次生成替代的上一个批次。`supersedes_run_id` 列早已存在但生产代码从未
   * 写入，跨 run 的旧候选批次因此永远不会被废弃，列表里新旧两批混在一起。
   */
  const previousActivatedRun = await tx
    .select({ id: cardGenerationRunsV2.id })
    .from(cardGenerationRunsV2)
    .where(and(
      eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
      eq(cardGenerationRunsV2.noteId, noteId),
      // 只替代**自己**上一批。按笔记找的话，甲重新生成会把乙已经激活的那批卡废掉。
      eq(cardGenerationRunsV2.userId, ctx.userId),
      eq(cardGenerationRunsV2.status, "activated"),
    ))
    .orderBy(desc(cardGenerationRunsV2.updatedAt))
    .limit(1);

  const blocks = await tx.query.noteBlocks.findMany({
    where: eq(noteBlocks.versionId, body.noteVersionId),
    orderBy: (b, { asc }) => [asc(b.ordinal)],
  });

  const blockContents = blocks.map((b) => b.content).join("\n");
  // §9.2: sourceContentHash 只覆盖 block 内容，不含 noteVersionId（transport/source identity 字段排除）
  const sourceContentHash = hashCanonicalV2("card-generation-v2/source-content", {
    blockContents,
  });
  const blockManifestHash = hashCanonicalV2("card-generation-v2/block-manifest", {
    blocks: blocks.map((b) => ({
      blockId: b.id, type: b.type,
      contentHash: hashCanonicalV2("block", { content: b.content }),
    })),
  });
  const assetManifestHash = hashCanonicalV2("card-generation-v2/asset-manifest", { assets: [] });
  const scopeManifestHash = hashCanonicalV2("card-generation-v2/scope-manifest", { scope: body.sourceScope });
  const sourceSnapshotHash = hashCanonicalV2("card-generation-v2/source-snapshot", {
    noteVersionId: body.noteVersionId,
    sourceContentHash, blockManifestHash, assetManifestHash, scopeManifestHash,
  });

  const semanticSpec = {
    version: 2 as const,
    semanticRequest: {
      sourceScope: body.sourceScope,
      learningGoal: body.learningGoal,
      detailThreshold: body.detailThreshold,
      quantity: body.quantity,
      preferredStrategies: body.preferredStrategies,
      feedbackContext: body.feedbackContext,
    },
    policies: {
      plannerPolicyVersion: "planner-v1",
      deterministicGateVersion: "gate-v1",
      evidencePolicyVersion: "evidence-v1",
      targetPolicyVersion: "target-v1",
      cardContractVersion: "learning-card-v2" as const,
      targetSnapshotVersion: "learning-target-snapshot-v2" as const,
      // 这份 stageRuntimes 种子今天**没有任何运行时读者**：它唯一的消费者是四阶段链的
      // `CardGenerationProviderRuntime`（按裸阶段名匹配采样参数），那条链已随 39d W7-7 刀二
      // 删除；简化链的采样参数写在 `card-generation-v3/tasks.ts` 的任务定义里。
      // 留着它是因为 `policies` 整块进 `semanticSpecHash`（审计闭包），删字段＝改哈希，
      // 会打掉在途 run 与逐候选改写的重放前提，所以这一刀不在此处（另立，见 39d-w71 §7.4 末）。
      // `promptVersion` 那一串（v19→v27）是旧链提示词的版本史，原样冻结；
      // bump 历史与逐版原因在 git 里，不在这里。
      stageRuntimes: [
        {
          stage: "planner" as const,
          providerId: "system",
          modelSnapshot: "v1",
          deploymentId: "local",
          capabilityFingerprint: "basic",
          promptVersion: "v27",
          sampling: { temperature: 0 },
          outputSchemaVersion: "v2",
        },
        {
          stage: "author" as const,
          providerId: "system",
          modelSnapshot: "v1",
          deploymentId: "local",
          capabilityFingerprint: "basic",
          promptVersion: "v27",
          sampling: { temperature: 0 },
          outputSchemaVersion: "v2",
        },
        {
          stage: "grounding_critic" as const,
          providerId: "system",
          modelSnapshot: "v1",
          deploymentId: "local",
          capabilityFingerprint: "basic",
          promptVersion: "v27",
          sampling: { temperature: 0 },
          outputSchemaVersion: "v2",
        },
        {
          stage: "pedagogy_critic" as const,
          providerId: "system",
          modelSnapshot: "v1",
          deploymentId: "local",
          capabilityFingerprint: "basic",
          promptVersion: "v27",
          sampling: { temperature: 0 },
          outputSchemaVersion: "v2",
        },
      ],
    },
    governancePolicyVersion: "gov-v1",
  };
  const semanticSpecHash = computeGenerationSemanticSpecHashV2(semanticSpec);

  const generationFingerprint = computeGenerationFingerprintV2({
    workspaceId: ctx.workspaceId,
    noteVersionId: body.noteVersionId,
    sourceContentHash, blockManifestHash, assetManifestHash, scopeManifestHash,
    generationSemanticSpecHash: semanticSpecHash,
  });

  const runId = randomUUID();
  const inputSnapshot = {
    version: 2 as const,
    generationRunId: runId,
    workspaceId: ctx.workspaceId,
    idempotencyKey,
    rawRequest: body,
    sourceSnapshot: {
      sourceSnapshotId: randomUUID(),
      noteId, noteVersionId: body.noteVersionId,
      sourceSnapshotHash, sourceContentHash,
      blockManifestHash, assetManifestHash, scopeManifestHash,
    },
    semanticSpecHash, generationFingerprint,
    cardContentEpoch: 1,
  };
  const inputSnapshotHash = computeInputSnapshotHashV2(inputSnapshot);

  await tx.insert(cardGenerationRunsV2).values({
    id: runId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    noteId, noteVersionId: body.noteVersionId,
    idempotencyKey,
    status: "queued",
    cardContentEpoch: 1,
    semanticSpecHash, inputSnapshotHash, generationFingerprint,
    sourceSnapshotHash, sourceContentHash,
    blockManifestHash, assetManifestHash, scopeManifestHash,
    currentPlanVersion: 0, reviewDraftRevision: 1,
    supersedesRunId: previousActivatedRun[0]?.id ?? null,
    semanticSpec, inputSnapshot,
  });

  await insertEvent(tx, ctx.workspaceId, runId, "card_generation.created", { runId });
  await tx.update(cardGenerationRunsV2)
    .set({ status: "source_sealing", updatedAt: new Date() })
    .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)));

  // ── §10.1 step 1-2：Evidence Seal + Semantic Spec / Input Snapshot 闭包 ──
  // source-only evidence seal（§14.1/§14.3，单向闭包：Author 之前 immutable seal）。
  await sealEvidenceSnapshotsV2(tx, {
    workspaceId: ctx.workspaceId,
    runId,
    noteId,
    noteVersionId: body.noteVersionId,
    sourceSnapshotId: inputSnapshot.sourceSnapshot.sourceSnapshotId,
    sourceScope: body.sourceScope,
    blocks: blocks.map((b) => ({
      blockId: b.id,
      type: b.type,
      content: b.content,
      ordinal: b.ordinal,
    })),
  });
  await insertEvent(tx, ctx.workspaceId, runId, "card_generation.evidence_sealed", {
    sourceContentHash,
  });

  // 幂等写入 immutable semantic spec / input snapshot 闭包表（§18.1）。
  await tx.insert(cardGenerationSemanticSpecsV2).values({
    id: randomUUID(),
    workspaceId: ctx.workspaceId,
    semanticSpecHash,
    semanticSpec,
    version: 2,
  }).onConflictDoNothing();
  await tx.insert(cardGenerationInputSnapshotsV2).values({
    id: randomUUID(),
    workspaceId: ctx.workspaceId,
    generationRunId: runId,
    inputSnapshotHash,
    inputSnapshot,
    version: 2,
  }).onConflictDoNothing();

  await insertEvent(tx, ctx.workspaceId, runId, "card_generation.source_sealed", { sourceSnapshotHash });

  // V1 placeholder: 实际 Planner/Author 由 worker 异步执行。
  // 此处将 Run 状态推进到 planning，等待 worker 消费。
  // 方案 20 §10.5 禁止将技术失败伪装成 0 张卡——
  // no_cards_recommended 只能由 Pedagogy Critic 或 Planner 确认后由 worker 写入。
  await tx.update(cardGenerationRunsV2)
    .set({ status: "planning", updatedAt: new Date() })
    .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)));

  // 修复：写 planning_started 而非 plan_completed
  // plan_completed 只能由 worker 在 Planner 执行完毕后写入
  await insertEvent(tx, ctx.workspaceId, runId, "card_generation.planning_started", {
    note: "awaiting worker",
  });

  // §17.2 + 39d W7-7：第一次生成排的就是简化链的整批那一发（`card_generation_simplified_v1`）。
  // W#2（round-5）+ 0163（round-6）：这里的 ON CONFLICT DO NOTHING 防重复入队
  // （API 重试/双击）抛 unique_violation 500。这一发今天撞不到约束——同
  // idempotencyKey 的重复请求在上面就收敛成严格重放了，走不到这里；保留是因为它
  // 免费，且 `(run_id, job_type)` 的部分唯一索引还在（post_activation 用得上）。
  await tx.insert(cardGenerationRunOutboxV2).values({
    workspaceId: ctx.workspaceId,
    runId,
    jobType: "card_generation_simplified_v1",
    payload: { runId, workspaceId: ctx.workspaceId, semanticSpecHash },
    status: "pending",
  }).onConflictDoNothing();

  return { runId, status: "planning" };
}