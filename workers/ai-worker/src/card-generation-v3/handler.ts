/**
 * 制卡简化链（V3）的 job 接线（39d W7-1 刀b；39c §6.1–6.2、39 §8.6）。
 *
 * 五段，与设计件 §3 一一对应——**每一次模型调用都在事务外面**（W3-2 那道出口闸门
 * 同样管这条链），每一段事务都短到只装读写：
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
 * - **`rewrite` 这一档今天不假装能改写**：增量改写是刀c 的活（还没有改写合同）。
 *   检查判 rewrite 的候选不进牌堆（`quality_state` 停在 `authored`，审核页判"可保留"
 *   看的是 `passed`，所以它既不会被当成通过也不会被抹掉），报告与 issues 照实落库，
 *   run 只要还有 passed 的候选就 `review_ready`，一张都不剩才 `needs_attention`。
 *
 * 语义调用数由这里**自己数**并写进完成事件（`modelCalls`）——§16.28 那句"普通短文本
 * 成功路径刚好 2 次"要能在库里读到，而不是只在进程里断言一次。
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
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
  loadV2RunInputs,
  type PendingOutboxJob,
} from "../handlers/card-generation-v2-handler.ts";
import {
  assembleCandidateEvidenceBindingPlanV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type { CardHintPairV2, LearningCardCandidateRevisionV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { extractAtomsDeterministic } from "@ailearn/shared/card-generation-v2-pipeline";
import {
  createCardGenerateV3Task,
  createCardContentCheckV3Task,
  type CardContentCheckV3TaskInput,
  type CardGenerateV3TaskInput,
  type CardGenerationV3ProviderPort,
} from "./tasks.ts";
import { assembleCardGenerationV3, runCardGenerateV3CandidateGates } from "./plan-assembly.ts";
import {
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
  const modelCalls = () => generateCalls[1]() + checkCalls[1]();

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
    const receipt = await generateTask.execute(generateInput, {
      mode: "structured",
      usageContext: { modelId: providers.generate.modelId, promptVersion: "card-generate-v3", resourceClass: "card_foreground" },
      remainingMs: 240_000,
      stepTimeoutMs: 120_000,
      retryIndex: 0,
      signal: signal ?? new AbortController().signal,
    });
    if (!receipt.ok) {
      // 输出形状不合合同 = 确定性失败（内核已按预算重试过一次），不重投。
      throw new Error(`card_generate_v3 output rejected: ${receipt.message}`);
    }
    generateOutput = receipt.output;

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
  const checked = await checkTask.execute(checkInput, {
    mode: "structured",
    usageContext: { modelId: providers.check.modelId, promptVersion: "card-check-v3", resourceClass: "card_foreground" },
    remainingMs: 240_000,
    stepTimeoutMs: 120_000,
    retryIndex: 0,
    signal: signal ?? new AbortController().signal,
  });
  if (!checked.ok) throw new Error(`card_content_check_v3 output rejected: ${checked.message}`);
  const checkOutput: CardContentCheckV3TaskOutput = checked.output;

  // ── 段 5：落库与终态（短事务）───────────────────────────────────────
  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    await writeSimplifiedCheckResults(tx, {
      workspaceId,
      runId,
      candidates,
      sealed: loaded.sealed,
      checked: checkOutput,
      modelCalls: modelCalls(),
    });
    await fenceV2OutboxLease(tx, job);
  }, { isolated: true });
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
    checked: CardContentCheckV3TaskOutput;
    modelCalls: number;
  },
): Promise<void> {
  const { workspaceId, runId, candidates, sealed, checked } = args;
  const byLocalId = new Map(candidates.map((candidate) => [candidate.planObjectiveLocalId, candidate]));
  const passedRevisionIds = new Set<string>();

  for (const entry of checked.parsed.perCandidate) {
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
    verdicts: checked.parsed.perCandidate.map((entry) => ({
      objectiveLocalId: entry.objectiveLocalId,
      verdict: entry.verdict,
    })),
    unchecked: checked.unchecked,
    status,
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
export function resolveCardGenerationV3Providers(): CardGenerationSimplifiedProviders {
  const kind = process.env.CARD_GENERATION_V3_PROVIDER ?? "deterministic";
  if (kind !== "deterministic") {
    throw new Error(
      `card-generation v3 provider "${kind}" 还没有接线（真模型那一版归每波末尾那一次真跑）`,
    );
  }
  return {
    generate: createDeterministicCardGenerateV3Provider(),
    check: createDeterministicCardContentCheckV3Provider(),
  };
}
