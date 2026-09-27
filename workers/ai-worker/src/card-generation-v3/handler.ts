/**
 * 制卡简化链（V3）的 job 接线（39d W7-1 刀b；39c §6.1–6.2、39 §8.6）。
 *
 * 五段，与设计件 §3 一一对应——**每一次模型调用都在事务外面**（四发都跑在公共任务
 * 内核上，那道出口闸门由内核的 `currentActiveTransaction` 端口在发调用之前核一次，
 * 见 `runV3TaskOnKernel`），每一段事务都短到只装读写：
 *
 *   1. 短事务：`loadV2RunInputs`（FOR UPDATE 锁 run、读回快照正文/sealed 依据/已有
 *      目标）＋状态门＋把 run 推到 `planning`；
 *   2. 事务外：一次生成（选目标＋出候选草稿）；
 *   3. 短事务：plan 行 → 候选行（先 plan 后候选，候选的 plan 列全 NOT NULL）→
 *      状态 `checking`；
 *   4. 事务外：一次批量内容检查；
 *   5. 短事务：binding plan＋质量报告＋逐候选 `quality_state`＋run 终态。
 *
 * 两件不是风格的事：
 *
 * - **重投不重付**：段 4/5 失败（可重试）时 job 会回到 pending 重跑，那时这一版计划
 *   与首稿候选**已经在库里**，于是整条链从段 4 接上——生成那一发不再发生。§16.28 的
 *   "检查失败不重跑生成"就是这一段判据；
 * - **`rewrite` 这一档**（刀c 已落地）：检查判 rewrite 的候选**逐张**改写一次，再只针对
 *   它们重检一轮；重检还判 rewrite 的那些不再改写，`quality_state` 停在 `authored`
 *   （审核页判"可保留"看的是 `passed`，所以它既不会被当成通过也不会被抹掉），报告与
 *   issues 照实落库，run 只要还有 passed 的候选就 `review_ready`，一张都不剩才 `needs_attention`。
 *
 * 语义调用数由这里**自己数**并写进完成事件（`modelCalls`）——§16.28 那句"普通短文本
 * 成功路径刚好 2 次"要能在库里读到，而不是只在进程里断言一次。
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  currentWorkerWorkspaceTransaction,
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
} from "../db.ts";
import { logger } from "../lib/logger.ts";
import {
  candidateRowToObject,
  fenceV2OutboxLease,
  insertAuthoredCandidatesBatched,
  insertBindingPlanRow,
  insertEvent,
  insertRepairedCandidateV2,
  loadV2RunInputs,
  renewV2OutboxLease,
  type PendingOutboxJob,
} from "../handlers/card-generation-v2-handler.ts";
import { CardGenerationProviderError } from "../card-generation-v2/providers.ts";
import {
  assembleCandidateEvidenceBindingPlanV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  CardHintPairV2,
  CardPlanV2,
  LearningCardCandidateRevisionV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type { CardContentCheckV3Output } from "@ailearn/shared/card-generation-v3-contracts";
import {
  runAiTask,
  type AiAttemptToken,
  type AiStepFailure,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";
import { extractAtomsDeterministic } from "@ailearn/shared/card-generation-v2-pipeline";
import {
  createCardGenerateV3Task,
  createCardContentCheckV3Task,
  createCardCandidateRewriteV3Task,
  type CardCandidateRewriteV3TaskInput,
  type CardContentCheckV3TaskInput,
  type CardGenerateV3TaskInput,
  type CardGenerationV3ProviderPort,
} from "./tasks.ts";
import {
  createCardGenerationV3LlmProviders,
  type CardGenerationV3ChatTransport,
} from "./llm-provider.ts";
import {
  assembleCardGenerationV3,
  buildCandidateRevisionV3,
  runCardGenerateV3CandidateGates,
} from "./plan-assembly.ts";
import {
  createDeterministicCardCandidateRewriteV3Provider,
  createDeterministicCardContentCheckV3Provider,
  createDeterministicCardGenerateV3Provider,
} from "./deterministic.ts";
import type { CardGenerateV3AssemblyResult } from "./plan-assembly.ts";
import type {
  CardContentCheckV3TaskOutput,
  CardGenerateV3TaskOutput,
} from "./output-types.ts";

export interface CardGenerationSimplifiedProviders {
  readonly generate: CardGenerationV3ProviderPort<CardGenerateV3TaskInput>;
  readonly check: CardGenerationV3ProviderPort<CardContentCheckV3TaskInput>;
  /** 增量改写（刀c）：`rewrite` 命中几张就有几次这个调用。 */
  readonly rewrite: CardGenerationV3ProviderPort<CardCandidateRewriteV3TaskInput>;
}

/**
 * 可以被这一发领走的状态。**`checking` 与 `authoring` 必须在里面**：段 4/5 失败时
 * 计划与候选已经在库里，job 回 pending 重投要能从段 4 接上（重投不重付）；把它们
 * 当成"不可运行"会让那条链永远停在 checking。终态（review_ready／no_cards_recommended／
 * needs_attention／failed／cancelled）才是让路的对象。
 */
const RUNNABLE_STATUSES = new Set(["queued", "planning", "authoring", "checking"]);
const FIRST_RUN_STATUSES = new Set(["queued"]);

/** 数端口被打了几发（§16.28 的读数来源）。 */
function counting<T>(inner: CardGenerationV3ProviderPort<T>): [CardGenerationV3ProviderPort<T>, () => number] {
  let calls = 0;
  return [
    {
      modelId: inner.modelId,
      async complete(request) {
        calls += 1;
        return inner.complete(request);
      },
    },
    () => calls,
  ];
}

async function readNoteTitle(workspaceId: string, noteVersionId: string): Promise<string> {
  const rows = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => (await tx.execute(sql`
      SELECT n.title
      FROM public.notes n
      JOIN public.note_versions nv ON nv.id = ${noteVersionId} AND nv.note_id = n.id
      WHERE n.workspace_id = ${workspaceId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>,
    { isolated: true },
  );
  return rows.length > 0 ? String(rows[0].title ?? "") : "";
}

/** 这一版计划是否已经落库（重投时从段 4 接上的依据）。 */
async function loadCommittedSimplifiedPlan(
  workspaceId: string,
  runId: string,
  planVersion: number,
): Promise<{ candidates: LearningCardCandidateRevisionV2[]; hints: Map<string, CardHintPairV2> } | null> {
  const rows = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => (await tx.execute(sql`
      SELECT * FROM public.card_generation_candidates_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        AND plan_version = ${planVersion} AND revision = 1
      ORDER BY created_at
    `)) as unknown as Array<Record<string, unknown>>,
    { isolated: true },
  );
  if (rows.length === 0) return null;
  const hints = new Map<string, CardHintPairV2>();
  const candidates = rows.map((row) => {
    const candidate = candidateRowToObject(row, runId);
    if (row.hints) hints.set(candidate.candidateRevisionId, row.hints as CardHintPairV2);
    return candidate;
  });
  return { candidates, hints };
}

export async function processCardGenerationSimplifiedJob(
  job: PendingOutboxJob,
  providers: CardGenerationSimplifiedProviders,
  signal?: AbortSignal,
): Promise<void> {
  const workspaceId = job.workspaceId;
  const runId = job.runId;
  const generateCalls = counting(providers.generate);
  const checkCalls = counting(providers.check);
  const rewriteCalls = counting(providers.rewrite);
  const rewriteCount = () => rewriteCalls[1]();
  const modelCalls = () => generateCalls[1]() + checkCalls[1]() + rewriteCalls[1]();

  // ── 段 1：读（短事务，锁 run）──────────────────────────────────────────
  const prepared = await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    const loaded = await loadV2RunInputs(tx, workspaceId, runId);
    const status = String(loaded.run.status);
    if (!RUNNABLE_STATUSES.has(status)) {
      return { kind: "skipped" as const, status };
    }
    await fenceV2OutboxLease(tx, job);
    const planVersion = Number(loaded.run.current_plan_version) + 1;
    if (FIRST_RUN_STATUSES.has(status)) {
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'planning', error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
    }
    return {
      kind: "ready" as const,
      loaded,
      planVersion,
      previousPlanRevisionId: loaded.plan?.planRevisionId ?? null,
    };
  }, { isolated: true });

  if (prepared.kind === "skipped") {
    logger.info({ runId, status: prepared.status }, "[v3-pipeline] run not runnable, job is a no-op");
    return;
  }
  const { loaded, previousPlanRevisionId } = prepared;
  let planVersion = prepared.planVersion;
  const noteTitle = await readNoteTitle(workspaceId, String(loaded.run.note_version_id));
  const semanticRequest = loaded.semanticSpec.semanticRequest;
  const activationHardMax = Math.min(8, Number(semanticRequest.quantity.hardMaxCards ?? 8) || 8);
  const userRequest = semanticRequest.feedbackContext?.optionalNote ?? null;

  /**
   * 这一发领到的四模型调用共用的内核接线上下文：输入快照身份（note 版本＋它的哈希）
   * 与租约都来自同一处，四发不各写一遍（写四遍就会有第四遍和第一遍不一样那一天）。
   */
  const runOnKernel = <TInput, TOutput>(
    definition: AiTaskDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<AiTaskReceipt<TOutput>> => runV3TaskOnKernel(definition, input, job,
    String(loaded.run.note_version_id), loaded.inputSnapshot.inputSnapshotHash, signal);

  // ── 段 2/3：生成＋落库；已经有这一版候选了就从段 4 接上（重投不重付）────
  let candidates: LearningCardCandidateRevisionV2[];
  let hintsByCandidateRevisionId: Map<string, CardHintPairV2>;
  let generateOutput: CardGenerateV3TaskOutput | null = null;
  let gateRejections: ReadonlyArray<{ objectiveLocalId: string; codes: string[] }> = [];
  let assembled: CardGenerateV3AssemblyResult | null = null;
  // 重投时这一版计划可能已经落库：`current_plan_version` 只在段 3 提交成功后才前进，
  // 所以这里同时探一下"还没推进的那一版"，避免把同一批候选写在两个版本号下。
  const already = (await loadCommittedSimplifiedPlan(workspaceId, runId, planVersion))
    ?? (await loadCommittedSimplifiedPlan(workspaceId, runId, Number(loaded.run.current_plan_version)));
  if (already && already.candidates.length > 0
    && already.candidates[0].planVersion !== planVersion) {
    planVersion = already.candidates[0].planVersion;
  }

  if (already && already.candidates.length > 0) {
    candidates = already.candidates;
    hintsByCandidateRevisionId = already.hints;
    logger.info({ runId, planVersion, candidates: candidates.length },
      "[v3-pipeline] plan already committed; resuming at content check (no re-generation)");
  } else {
    const generateInput: CardGenerateV3TaskInput = {
      runId,
      noteTitle,
      noteBlocks: loaded.scopedBlocks.map((block) => ({
        blockId: block.blockId,
        ordinal: block.ordinal,
        text: block.content,
      })),
      existingObjectives: loaded.existingObjectives.map((objective) => ({
        objectiveId: objective.objectiveId,
        statement: objective.objectiveStatement,
      })),
      userRequest,
      evidence: loaded.sealed.evidenceManifest.evidence.map((evidence) => ({
        evidenceSnapshotId: evidence.evidenceSnapshotId,
        blockId: evidence.blockId,
      })),
      inputSnapshotHash: loaded.inputSnapshot.inputSnapshotHash,
      planVersion,
      cardContentEpoch: Number(loaded.run.card_content_epoch),
      activationHardMax,
    };
    const generateTask = createCardGenerateV3Task({
      provider: generateCalls[0],
      prepare: async () => generateInput,
      commit: async () => {},
    });
    const ran = await runOnKernel(generateTask, generateInput);
    if (ran.outcome !== "committed" || !ran.output) {
      // 内核已经按预算把那一次补采样花掉了（`maxAutoRetries: 1`）。还不合合同就是
      // 确定性失败：抛**不可重试**那一类，队列再重投只会把同一笔钱再烧一遍。
      throw kernelFailureError("card_generate_v3", ran.failure);
    }
    generateOutput = ran.output;

    const planRevisionId = randomUUID();
    assembled = assembleCardGenerationV3({
      generated: generateOutput.parsed,
      acceptedCandidates: generateOutput.parsed.candidates,
      runId,
      planRevisionId,
      planVersion,
      previousPlanRevisionId,
      inputSnapshotHash: loaded.inputSnapshot.inputSnapshotHash,
      cardContentEpoch: Number(loaded.run.card_content_epoch),
      activationHardMax,
      evidenceSetHash: loaded.sealed.evidenceSetHash,
      atoms: extractAtomsDeterministic(loaded.scopedBlocks),
      sealedEvidence: loaded.sealed.evidenceManifest.evidence,
      preferredStrategies: semanticRequest.preferredStrategies,
    });
    const gated = runCardGenerateV3CandidateGates({
      assembled,
      sourceContent: loaded.sourceContent,
      evidenceManifest: loaded.sealed.evidenceManifest,
    });
    candidates = gated.kept;
    hintsByCandidateRevisionId = new Map(
      [...assembled.hintsByCandidateRevisionId].filter(([revisionId]) =>
        gated.kept.some((candidate) => candidate.candidateRevisionId === revisionId)),
    );
    gateRejections = gated.rejected;

    await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
      await insertSimplifiedPlanRow(tx, workspaceId, runId, assembled!.plan, planVersion, previousPlanRevisionId);
      await insertAuthoredCandidatesBatched(
        tx, workspaceId, runId, candidates, hintsByCandidateRevisionId, { skipExisting: true },
      );
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'checking', current_plan_version = ${planVersion}, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
      await insertEvent(tx, workspaceId, runId, "card_generation.simplified_plan_committed", {
        planRevisionId: assembled!.plan.planRevisionId,
        planHash: assembled!.plan.planHash,
        resultKind: assembled!.plan.result.kind,
        candidateCount: candidates.length,
        // 本发之内的调用数（重投时段 2 被跳过 ⇒ 这里是 0）。§16.28 那句"2 次"是
        // 一次跑完全程时 `..._completed` 里的数；半途失败过的批次要把这两条事件的
        // 数相加，才是这一批真付过的钱。
        modelCalls: modelCalls(),
        droppedDrafts: generateOutput!.droppedCandidates,
        assemblyDropped: assembled!.dropped,
        gateRejected: gateRejections,
      });
      await fenceV2OutboxLease(tx, job);
    }, { isolated: true });
  }

  if (assembled?.plan.result.kind === "no_cards_recommended" && candidates.length === 0) {
    await finishNoCards(
      job,
      assembled.plan.result.kind === "no_cards_recommended" ? assembled.plan.result.reasonCodes : [],
      modelCalls(),
    );
    return;
  }
  if (candidates.length === 0) {
    // 重投路径下这一版计划本身就是 no_cards（上面已处理），到这里说明库里没有
    // 可检查的东西——照实收口，不发模型调用。
    await finishNoCards(job, [], modelCalls());
    return;
  }

  // ── 段 4：批量内容检查（事务外）──────────────────────────────────────
  const checkInput: CardContentCheckV3TaskInput = {
    runId,
    sourceContent: loaded.sourceContent,
    candidates: candidates.map((candidate) => ({
      objectiveLocalId: candidate.planObjectiveLocalId,
      candidate,
    })),
    evidenceManifest: loaded.sealed.evidenceManifest,
  };
  const checkTask = createCardContentCheckV3Task({
    provider: checkCalls[0],
    prepare: async () => checkInput,
    commit: async () => {},
  });
  const ranCheck = await runOnKernel(checkTask, checkInput);
  if (ranCheck.outcome !== "committed" || !ranCheck.output) {
    throw kernelFailureError("card_content_check_v3", ranCheck.failure);
  }
  const checkOutput: CardContentCheckV3TaskOutput = ranCheck.output;

  // ── 段 4b/4c：增量改写（只重做被判 rewrite 的那几张）＋一次只针对它们的重检 ──
  let finalEntries = checkOutput.parsed.perCandidate.filter((entry) => entry.verdict !== "rewrite");
  let finalCandidates = candidates;
  const rewriteEntries = checkOutput.parsed.perCandidate.filter((entry) => entry.verdict === "rewrite");
  if (rewriteEntries.length > 0) {
    const rebuilt: LearningCardCandidateRevisionV2[] = [];
    const task = createCardCandidateRewriteV3Task({
      provider: rewriteCalls[0],
      prepare: async () => { throw new Error("rewrite task 的输入由调用方逐张给"); },
      commit: async () => {},
    });
    for (const entry of rewriteEntries) {
      const previous = candidates.find(
        (candidate) => candidate.planObjectiveLocalId === entry.objectiveLocalId,
      );
      if (!previous) continue;
      const hints = hintsByCandidateRevisionId.get(previous.candidateRevisionId);
      if (!hints) continue; // 提示是兄弟列；没有它就不改写（不许顺手把它清空）
      const rewriteInput: CardCandidateRewriteV3TaskInput = {
        runId,
        sourceContent: loaded.sourceContent,
        candidate: previous,
        hints,
        issues: entry.issues.map((issue) => ({ code: issue.code, detail: issue.detail })),
        evidenceManifest: loaded.sealed.evidenceManifest,
      };
      const ranRewrite = await runOnKernel(task, rewriteInput);
      if (ranRewrite.outcome !== "committed" || !ranRewrite.output) {
        throw kernelFailureError("card_candidate_rewrite_v3", ranRewrite.failure);
      }
      const draft = ranRewrite.output.draft;
      const built = buildCandidateRevisionV3({
        draft,
        plan: assembled?.plan ?? planFromCommittedCandidates(previous),
        runId,
        // 改写只改内容，不换题型：整批分配过的 strategy 沿用上一版那一份。
        strategy: previous.presentation.strategy,
        reasonCodes: [...previous.recommendation.reasonCodes, "content_check_rewrite"],
        evidenceSetHash: loaded.sealed.evidenceSetHash,
        previous,
      });
      rebuilt.push(built.candidate);
      hintsByCandidateRevisionId.set(built.candidate.candidateRevisionId, built.hints);
    }
    if (rebuilt.length > 0) {
      await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
        for (const next of rebuilt) {
          const previous = candidates.find(
            (candidate) => candidate.candidateRevisionId === next.derivedFromCandidateRevisions.at(-1)?.candidateRevisionId,
          )!;
          // 旧修订不可变：只标 superseded，不覆盖、不删。
          await tx.execute(sql`
            UPDATE public.card_generation_candidates_v2
            SET publish_state = 'superseded', updated_at = now()
            WHERE candidate_revision_id = ${previous.candidateRevisionId} AND workspace_id = ${workspaceId}
              AND publish_state = 'unpublished'
          `);
          await insertRepairedCandidateV2(tx, {
            runId, workspaceId, candidate: next, hints: hintsByCandidateRevisionId.get(next.candidateRevisionId)!,
          });
          await insertEvent(tx, workspaceId, runId, "card_candidate.rewritten", {
            candidateId: next.candidateId,
            previousRevisionId: previous.candidateRevisionId,
            newRevisionId: next.candidateRevisionId,
            revision: next.revision,
            rewriteCalls: rewriteCount(),
          });
        }
        await fenceV2OutboxLease(tx, job);
      }, { isolated: true });

      const recheckInput: CardContentCheckV3TaskInput = {
        runId,
        sourceContent: loaded.sourceContent,
        candidates: rebuilt.map((candidate) => ({
          objectiveLocalId: candidate.planObjectiveLocalId,
          candidate,
        })),
        evidenceManifest: loaded.sealed.evidenceManifest,
      };
      const recheckTask = createCardContentCheckV3Task({
        provider: checkCalls[0],
        prepare: async () => recheckInput,
        commit: async () => {},
      });
      const ranRecheck = await runOnKernel(recheckTask, recheckInput);
      if (ranRecheck.outcome !== "committed" || !ranRecheck.output) {
        throw kernelFailureError("card_content_check_v3（重检）", ranRecheck.failure);
      }
      // **一轮为限**：重检之后还判 rewrite 的那些不再改写，停在 authored 等人工。
      finalEntries = [...finalEntries, ...ranRecheck.output.parsed.perCandidate];
      finalCandidates = [...candidates.filter((candidate) =>
        !rebuilt.some((next) => next.planObjectiveLocalId === candidate.planObjectiveLocalId)), ...rebuilt];
    }
  }

  // ── 段 5：落库与终态（短事务）───────────────────────────────────────
  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    await writeSimplifiedCheckResults(tx, {
      workspaceId,
      runId,
      candidates: finalCandidates,
      sealed: loaded.sealed,
      entries: finalEntries,
      unchecked: checkOutput.unchecked,
      modelCalls: modelCalls(),
      rewriteCalls: rewriteCount(),
    });
    await fenceV2OutboxLease(tx, job);
  }, { isolated: true });
}

/**
 * 这条链的四发模型调用都跑在**公共任务内核**上（2026-09-27 接上；在那之前这里是
 * `task.execute` 直调，任务声明的 `budget` 一格都不落地：`maxAutoRetries: 1` 一次
 * 不重试，`stepTimeoutMs`／`taskDeadlineMs` 也没人拿它们去组成超时信号）。接上之后
 * 由内核执行的四件事：
 *
 *   - 首次＋至多一次自动重试，且只对 `AI_TASK_RETRYABLE_FAILURE_CLASSES` 那三档
 *     （transport／timeout／output_shape）——权限、内容版本、实质质量不重花钱；
 *   - 单步与整任务的 wall-clock 上界（超时信号由内核合成，不在这里手工搭）；
 *   - "模型调用不许落在活动事务里"那道出口闸（`currentActiveTransaction` 是必填
 *     端口：做成可选就等于让"忘记核对"成为一种可以通过的形状）；
 *   - 提交前核对这一次尝试还作数——租约判据复用 `renewV2OutboxLease` 那一份实现，
 *     不在这条链上再起第二个来源（D5 §4.1：租约换了 ⇒ 旧输出不许提交）。
 *
 * `prepare` 被换成"把调用方已经备好的输入原样交回去"：这一条链的输入在段 1／段 4
 * 就读好了（rewrite 那一份还是逐张给的），内核那次"短事务准备"在这里是空操作。
 */
async function runV3TaskOnKernel<TInput, TOutput>(
  definition: AiTaskDefinition<TInput, TOutput>,
  input: TInput,
  job: PendingOutboxJob,
  noteVersionId: string,
  inputSnapshotHash: string,
  signal: AbortSignal | undefined,
): Promise<AiTaskReceipt<TOutput>> {
  const ctx: AiTaskContext = {
    workspaceId: job.workspaceId,
    userId: null,
    // 与另外三个服务端发起的任务同一取值（`run-critic`／`teaching-explain`／语音转写）：
    // 这一发不是用户授权档位里的某一次动作，是后台管道替用户跑完的一步。
    permissionLevel: "server",
    inputSnapshotRef: { kind: "note_version", id: noteVersionId, hash: inputSnapshotHash },
    signal: signal ?? new AbortController().signal,
  };
  const attempt: AiAttemptToken = {
    taskId: definition.id,
    taskVersion: definition.version,
    attemptId: `${job.id}:${job.leaseToken}`,
    leaseToken: job.leaseToken,
    idempotencyKey: `${definition.id}:${job.runId}:${job.id}`,
    workspaceId: job.workspaceId,
    userId: null,
  };
  return runAiTask({ ...definition, prepare: async () => input }, {
    ctx,
    attempt,
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    reportDevelopmentError: (message) => logger.error({ jobId: job.id, runId: job.runId }, message),
    verifyAttempt: () => renewV2OutboxLease(job.id, job.leaseToken),
  });
}

/**
 * 内核回执 → 这一发该抛的那一类错。**分类决定 outbox 会不会再烧一次钱**（两个读数
 * 各钉一格在 `card-generation-v3-simplified-postgres.integration.ts`）：
 * `output_shape` 是确定性失败，而内核已经按预算把那一次补采样花掉了，队列再重投只是
 * 把同一笔钱再烧一遍 ⇒ 判**不可重试**（这正是接内核之前那句"内核已按预算重试过一次"
 * 该有却没有的落点）。其余类别留在可重试那一侧——被 abort 与整条管道预算那两档，
 * 分发点自己会改成不可重试（`processV2OutboxJob` 的 catch）。
 */
function kernelFailureError(taskId: string, failure: AiStepFailure | null): Error {
  const judged: AiStepFailure = failure
    ?? { ok: false, class: "submission_failed", message: `${taskId} 的回执既不是 committed，也没带失败类别` };
  return new CardGenerationProviderError(
    judged.class === "output_shape" ? "non-retryable" : "retryable",
    `${taskId} output rejected: ${judged.class} — ${judged.message}`.slice(0, 600),
  );
}

/** 重投路径上没有内存里的计划对象：从候选行自己的 plan 身份复原一份就够组装用了。 */
function planFromCommittedCandidates(candidate: LearningCardCandidateRevisionV2): CardPlanV2 {
  return {
    version: 2,
    planRevisionId: candidate.planRevisionId,
    runId: candidate.runId,
    inputSnapshotHash: candidate.planHash,
    cardContentEpoch: candidate.cardContentEpoch,
    planVersion: candidate.planVersion,
    previousPlanRevisionId: null,
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] },
    atomDecisions: [],
    planHash: candidate.planHash,
  };
}

/** plan 行的写入形状与 V2 主管线一致（同一张表、同一批列）。 */
async function insertSimplifiedPlanRow(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  plan: CardGenerateV3AssemblyResult["plan"],
  planVersion: number,
  previousPlanRevisionId: string | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.card_generation_plans_v2
      (id, workspace_id, run_id, plan_revision_id, plan_version, previous_plan_revision_id,
       input_snapshot_hash, card_content_epoch, result, atom_decisions, plan_hash)
    VALUES (
      ${randomUUID()}, ${workspaceId}, ${runId}, ${plan.planRevisionId},
      ${planVersion}, ${previousPlanRevisionId},
      ${plan.inputSnapshotHash}, ${plan.cardContentEpoch},
      ${JSON.stringify(plan.result)}::jsonb,
      ${JSON.stringify(plan.atomDecisions)}::jsonb,
      ${plan.planHash}
    )
    ON CONFLICT (workspace_id, run_id, plan_version) DO NOTHING
  `);
}

async function finishNoCards(
  job: PendingOutboxJob,
  reasonCodes: readonly string[],
  modelCalls: number,
): Promise<void> {
  const { workspaceId, runId } = job;
  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'no_cards_recommended', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);
    await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
      reasonCodes,
      chain: "simplified_v3",
      modelCalls,
    });
    await fenceV2OutboxLease(tx, job);
  }, { isolated: true });
}

async function writeSimplifiedCheckResults(
  tx: WorkerTransaction,
  args: {
    workspaceId: string;
    runId: string;
    candidates: LearningCardCandidateRevisionV2[];
    sealed: Awaited<ReturnType<typeof loadV2RunInputs>>["sealed"];
    entries: CardContentCheckV3Output["perCandidate"];
    unchecked: ReadonlyArray<string>;
    modelCalls: number;
    rewriteCalls: number;
  },
): Promise<void> {
  const { workspaceId, runId, candidates, sealed } = args;
  const byLocalId = new Map(candidates.map((candidate) => [candidate.planObjectiveLocalId, candidate]));
  const passedRevisionIds = new Set<string>();

  for (const entry of args.entries) {
    const candidate = byLocalId.get(entry.objectiveLocalId);
    if (!candidate) continue;
    const keepable = entry.verdict === "keep";
    if (keepable) {
      const binding = assembleCandidateEvidenceBindingPlanV2({
        runId,
        workspaceId,
        candidate,
        groundingReport: entry.grounding,
        evidenceManifest: sealed.evidenceManifest,
        eligibilityVector: sealed.eligibility,
      });
      await insertBindingPlanRow(tx, { runId, workspaceId, candidate, result: binding });
      await tx.execute(sql`
        UPDATE public.card_generation_candidates_v2
        SET quality_state = 'passed', evidence_binding_plan_hash = ${binding.bindingPlanHash}, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND candidate_revision_id = ${candidate.candidateRevisionId}
      `);
      passedRevisionIds.add(candidate.candidateRevisionId);
    } else {
      // rewrite 与 insufficient 都留痕但不进牌堆：前者等刀c 的增量改写，
      // 后者是确定性结论（依据不足）。两者的报告与 issues 都照常落库。
      await tx.execute(sql`
        UPDATE public.card_generation_candidates_v2
        SET quality_state = ${entry.verdict === "insufficient" ? "failed" : "authored"}, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND candidate_revision_id = ${candidate.candidateRevisionId}
      `);
    }
    await tx.execute(sql`
      INSERT INTO public.card_candidate_quality_reports_v2
        (id, workspace_id, run_id, candidate_revision_id, report_type, input_hash,
         report, verdict, gate_version, report_hash)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${runId}, ${candidate.candidateRevisionId},
        'grounding', ${candidate.evidenceSetHash},
        ${JSON.stringify({
          version: 2,
          reportType: "grounding",
          candidateRevisionId: candidate.candidateRevisionId,
          candidateRevisionHash: candidate.candidateRevisionHash,
          inputHash: candidate.evidenceSetHash,
          reportHash: entry.grounding.reportHash,
          issues: entry.issues,
          verdict: keepable ? "passed" : "failed",
          gateVersion: "card-content-check-v3",
          grounding: entry.grounding,
        })}::jsonb,
        ${keepable ? "passed" : "failed"}, 'card-content-check-v3', ${entry.grounding.reportHash}
      )
    `);
  }

  const status = passedRevisionIds.size > 0 ? "review_ready" : "needs_attention";
  await tx.execute(sql`
    UPDATE public.card_generation_runs_v2
    SET status = ${status},
        error_code = ${status === "needs_attention" ? "quality_gate_failed" : null},
        error_message = ${status === "needs_attention" ? "批量内容检查没有放行任何一张" : null},
        updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
  `);
  await insertEvent(tx, workspaceId, runId, "card_generation.simplified_completed", {
    modelCalls: args.modelCalls,
    passed: [...passedRevisionIds],
    verdicts: args.entries.map((entry) => ({
      objectiveLocalId: entry.objectiveLocalId,
      verdict: entry.verdict,
    })),
    unchecked: args.unchecked,
    status,
    rewriteCalls: args.rewriteCalls,
  });
}

/**
 * 这条链今天的 provider 选择（一处常量＋一个环境变量，坏值不回落）。
 *
 * `CARD_GENERATION_V3_PROVIDER` 未设＝确定性那一版：这条链只在生产侧显式打开时才被
 * 领到（见 api 的 `CARD_GENERATION_CHAIN`），所以"库里出现的简化链产物都是确定性
 * 拼的"这件事在生产里是一次显式配置，不是巧合。**要真模型时必须显式说**，并且今天
 * 直接失败——静默回落到确定性会让 §16.28 那句"2 次语义调用"读起来像跑过模型。
 */
const CARD_GENERATION_V3_PROVIDER_ENV = "CARD_GENERATION_V3_PROVIDER";
/** 与 V2 那道 `V2_ALLOW_DETERMINISTIC_PROVIDERS` 同方向的显式豁免（离线跑生产形状的库时才用）。 */
const V3_ALLOW_DETERMINISTIC_ENV = "V3_ALLOW_DETERMINISTIC_PROVIDERS";

/**
 * 这一发要不要走真模型（分发点用它决定要不要先去解析治理上下文）。
 * 判据与 `resolveCardGenerationV3Providers` 是同一份：两处各读一次 env 就会有一天不一致。
 */
export function cardGenerationV3LlmRequested(): boolean {
  return (process.env[CARD_GENERATION_V3_PROVIDER_ENV] ?? "deterministic") !== "deterministic";
}

/**
 * `transport` 由分发点带着**治理上下文解析出来的那一份**进来（同意/外发政策与 provider
 * 选择都按 (workspace, user) 判，见 `resolveGovernedCardGenerationProvider`）。
 * 配了真模型却没拿到 transport ⇒ 抛不可重试，**不静默回落确定性**：回落会让 §16.28
 * 那句"2 次语义调用"读起来像跑过模型，而库里躺的是占位内容。
 */
export function resolveCardGenerationV3Providers(input?: {
  transport: CardGenerationV3ChatTransport;
}): CardGenerationSimplifiedProviders {
  const kind = process.env[CARD_GENERATION_V3_PROVIDER_ENV] ?? "deterministic";
  if (kind !== "deterministic") {
    if (!input?.transport) {
      // 必须是**不可重试**那一类：这是配置缺失，不是网络抖动。抛裸 `Error` 会让分发点
      // 按可重试分类，outbox 按 15/30/60/120/240s 退避连试六轮，期间一次模型调用都没
      // 发生（V2 在 2026-09-17 就为同样的形状记过一次事故）。
      throw new CardGenerationProviderError(
        "non-retryable",
        `card-generation v3 provider "${kind}" 需要一份按治理上下文解析出来的 transport`
        + `（run 的主人、同意与 provider 选择都在那一发里判）；单独调用拿不到 ⇒ 拒绝，`
        + `不回落到确定性。unset ${CARD_GENERATION_V3_PROVIDER_ENV} 走确定性那一版`,
      );
    }
    return createCardGenerationV3LlmProviders({ transport: input.transport });
  }
  assertV3DeterministicProvidersAllowed();
  return {
    generate: createDeterministicCardGenerateV3Provider(),
    check: createDeterministicCardContentCheckV3Provider(),
    rewrite: createDeterministicCardCandidateRewriteV3Provider(),
  };
}

/**
 * L1 护栏的 V3 版：确定性 provider 只允许用在离线/测试路径。
 *
 * 为什么新链更需要它：确定性那一版的"检查"不发网络，它对内容的判断是拼装的副产物，
 * 而完成事件里记的是 `modelCalls=2`——在生产里让它悄悄跑完，等于用一次显式开关
 * （`CARD_GENERATION_CHAIN=simplified_v3`）换到一批**看起来过了模型**的占位候选。
 * 与 V2 那道护栏方向对称：生产要么显式配真模型，要么显式豁免（下面那个 env）。
 */
function assertV3DeterministicProvidersAllowed(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (process.env[V3_ALLOW_DETERMINISTIC_ENV] === "1") return;
  throw new CardGenerationProviderError(
    "non-retryable",
    "card-generation v3 deterministic providers are not allowed in production: "
    + `真模型那一版还没接线，所以生产里不要打开简化链；离线复核请显式设 ${V3_ALLOW_DETERMINISTIC_ENV}=1`,
  );
}
