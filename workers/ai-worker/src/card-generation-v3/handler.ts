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
 *
 * 段 4/5 也是审核台上那两发（逐候选重检／按反馈重生成）走的那条腿，所以段 5 那个
 * 写入点带着**收口语境**（`SimplifiedSettleScope`）：整批那一发在在制档上收，逐候选
 * 那一发在审核台档（`review_ready`／`needs_attention`）上收。少了这一格，逐候选那一发
 * 收不动 run：`simplified_completed` 一条不写，库里读到的完成回执是上一批那条旧事件。
 */
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import {
  currentWorkerWorkspaceTransaction,
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
} from "../db.ts";
import { logger } from "../lib/logger.ts";
// 读侧与落库原语（39d W7-7 刀二·内核搬家第三块）：简化链与旧链共用同一份，
// 所以引的是模块本体，不再绕旧 handler。
import {
  candidateRowToObject,
  emitSourceContentCapEvent,
  insertAuthoredCandidatesBatched,
  insertBindingPlanRow,
  insertEvent,
  insertRepairedCandidateV2,
  loadV2RunInputs,
  V2_SOURCE_CONTENT_MAX_CHARS,
} from "../card-generation-v2/run-io.ts";
// W7-5 刀三：复用的读侧（按 (工作区, 笔记) 收窄的既有目标 ＋ 它们的块锚与形态）。
import { loadReusableObjectivesForNoteV2 } from "../card-generation-v2/objective-reuse-lookup.ts";
import {
  fenceV2OutboxLease,
  renewV2OutboxLease,
  type PendingOutboxJob,
} from "../card-generation-v2/outbox-queue.ts";
import { CardGenerationProviderError } from "../card-generation-v2/governed-provider.ts";
import {
  assembleCandidateEvidenceBindingPlanV2,
} from "@astella/shared/card-generation-v2-pipeline";
import type {
  CardHintPairV2,
  CardPlanV2,
  LearningCardCandidateRevisionV2,
} from "@astella/shared/card-generation-v2-contracts";
import type { CardContentCheckV3Output } from "@astella/shared/card-generation-v3-contracts";
import {
  AI_TASK_RETRYABLE_FAILURE_CLASSES,
  runAiTask,
  type AiAttemptToken,
  type AiStepFailure,
  type AiTaskContext,
  type AiTaskDefinition,
  type AiTaskReceipt,
} from "@astella/shared/ai-task-kernel";
import { extractAtomsDeterministic } from "@astella/shared/card-generation-v2-pipeline";
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
import {
  agentCardExecutionPorts,
  resolveAgentCardExecution,
  withAgentCardJobTransaction,
  type AgentCardExecution,
} from "./agent-fence.ts";
import { loadAgentExecutionContext } from "../agent/execution-context.ts";
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
/**
 * 整批那一发的两种来意（39d W7-7）：`generate` 是第一次生成（run 从 `queued` 起步），
 * `replan` 是审核台上的「换一批」与质量门失败后的「再生成一次」——同一个 run 上再开
 * 一版计划，旧版没激活的候选要让路。
 */
const REPLAN_RUN_STATUSES = new Set(["review_ready", "needs_attention", "checking"]);
/** 逐候选那一发（重检／按反馈重生成）只在"这一批已经摆到审核台上"时接手。 */
const REFINE_RUNNABLE_STATUSES_V3 = new Set(["review_ready", "needs_attention"]);

/** 这一发把结果写进 run 时处在哪条腿上：决定 CAS 的来源状态与终态判据。 */
type SimplifiedSettleScope = "batch_generation" | "candidate_refine";

/**
 * 终态写入点（`writeSimplifiedCheckResults`）这一发**从哪些状态收走 run**。
 *
 * 为什么不是一个并集：两条腿从不同的档位接手——整批那一发永远在在制档
 * （`queued`…`checking`），逐候选那一发接手时 run 已经停在审核台档
 * （`review_ready`／`needs_attention`，它就是从那一档被派出来的）。
 * 收口语境写死成在制档时，逐候选那一发收不动 run，`simplified_completed` 一条不写，
 * 库里读到的完成回执是**上一批那条旧事件**（§16.28 的读数来源于是对不上这一发
 * 真实付了几发）。
 *
 * 逐候选那一档**直接由它的接单门闩推出来**（`REFINE_RUNNABLE_STATUSES_V3`），
 * 两份名单各写一遍就是这类漂移再来的入口：接得进、收不走。
 */
const SETTLE_FROM_STATUSES: Record<SimplifiedSettleScope, SQL | SQL[]> = {
  batch_generation: sql`('queued', 'source_sealing', 'planning', 'authoring', 'checking')`,
  candidate_refine: [...REFINE_RUNNABLE_STATUSES_V3].map((status) => sql`${status}`),
};

/**
 * 整批那一发的来意写在 payload 里而不是另开 jobType：两种来意跑的是同一条五段链、
 * 同一批门禁与同一个终态判据，只有状态门与"上一版要让路"这一格不同。
 * 未写 `mode` ＝第一次生成（老 payload 一字节都不用改）。
 */
function jobModeV3(job: PendingOutboxJob): "generate" | "replan" {
  return (job.payload as { mode?: string }).mode === "replan" ? "replan" : "generate";
}

/**
 * 送进模型的 block 文本总量上限。
 *
 * `loadV2RunInputs` 只对"拼起来的源文本"施了这道上限（旧链的 author prompt 用的就是那份），
 * 而简化链的生成输入直接交 block 列表——不补这一刀，60k 那道护栏在这条链上等于没有：
 * 提示词规模与单 job 内存峰值都是按这份列表算的。额度按 ordinal 顺序给，与
 * `capSourceContentForPrompts` "截前留后"的方向一致；留痕由段 3 的写事务经同一份发射器记。
 */
function capV3PromptBlocks(
  blocks: ReadonlyArray<{ blockId: string; ordinal: number; content: string }>,
): Array<{ blockId: string; ordinal: number; text: string }> {
  let remaining = V2_SOURCE_CONTENT_MAX_CHARS;
  return blocks.map((block) => {
    const allowed = Math.max(0, Math.min(block.content.length, remaining));
    remaining -= allowed;
    return { blockId: block.blockId, ordinal: block.ordinal, text: block.content.slice(0, allowed) };
  });
}

/**
 * 数端口被打了几发（§16.28 的读数来源），并在**每一次真正发出的调用之前**跑一次
 * `beforeComplete`。
 *
 * 为什么收费点落在这里而不是 `runV3TaskOnKernel` 的入口：入口一次任务只被穿一次，
 * 而内核在合同解析失败时会自动补采样一次、逐张改写后还要再过一次重检——这些**都
 * 是真实的 provider 调用**，都要记到父目标上。反过来，只恢复已提交结果的那条路径
 * （计划与候选已在库、从内容检查接上）一次 `complete` 都不会发生，于是也就一次都不记。
 *
 * `beforeComplete` 为空（没有 Agent 归属的普通制卡）时这一层是纯计数，行为与今天逐字相同。
 */
function counting<T>(
  inner: CardGenerationV3ProviderPort<T>,
  beforeComplete?: () => Promise<void>,
): [CardGenerationV3ProviderPort<T>, () => number] {
  let calls = 0;
  return [
    {
      modelId: inner.modelId,
      async complete(request) {
        // 先收费再计数：收费被拒（父预算用完／目标已停）时这一次**没有真正发出去**，
        // 计数若已经加过，落库的 modelCalls 就会报多一发。
        if (beforeComplete) await beforeComplete();
        calls += 1;
        return inner.complete(request);
      },
    },
    () => calls,
  ];
}

/**
 * 这一发 outbox 的 Agent 归属与「每次调用前向父目标收费」的那一份上下文。
 *
 * 没有绑定时 `reserve` 是空实现：用户在页面上自己点的制卡、以及审核台上的后续几发，
 * 一次也不记到任何目标上（它们的 outbox 与任何 `agent_operations` 行无关）。
 */
async function loadCardAgentExecutionContext(
  job: PendingOutboxJob,
  execution: AgentCardExecution,
  signal: AbortSignal | undefined,
) {
  if (!execution.binding) {
    return {
      binding: null,
      instructions: "",
      async reserveModelCall() {},
    };
  }
  return loadAgentExecutionContext(
    { workspaceId: job.workspaceId, userId: execution.binding.userId },
    agentCardExecutionPorts(job, execution.binding),
    signal,
  );
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
  // 归属读一次即定论：初始那一发有主，审核台之后的新 outbox 没有主。
  const agentExecution = await resolveAgentCardExecution(job);
  const agentContext = await loadCardAgentExecutionContext(job, agentExecution, signal);
  const reserveAgentCall = () => agentContext.reserveModelCall();
  const generateCalls = counting(providers.generate, reserveAgentCall);
  const checkCalls = counting(providers.check, reserveAgentCall);
  const rewriteCalls = counting(providers.rewrite, reserveAgentCall);
  const modelCalls = () => generateCalls[1]() + checkCalls[1]() + rewriteCalls[1]();
  /** 每一段短事务的统一入口：先判父围栏（先锁 Agent run），再跑这一段原有读写。 */
  const withJobTransaction = <T>(action: (tx: WorkerTransaction) => Promise<T>) =>
    withAgentCardJobTransaction(job, agentExecution, action);

  // ── 段 1：读（短事务，锁 run）──────────────────────────────────────────
  const replanning = jobModeV3(job) === "replan";
  const prepared = await withJobTransaction(async (tx) => {
    const loaded = await loadV2RunInputs(tx, workspaceId, runId);
    const status = String(loaded.run.status);
    if (!(replanning ? REPLAN_RUN_STATUSES : RUNNABLE_STATUSES).has(status)) {
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
    } else if (replanning) {
      // 重排在即：run 立刻回到工作态并清掉上一次的失败码，用户点完就看见"又动起来了"
      // （与旧的 run 级就地重试同一口径——停在新结果出来之前的一直是「需要处理」）。
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'checking', error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
    }
    return {
      kind: "ready" as const,
      loaded,
      planVersion,
      previousPlanRevisionId: loaded.plan?.planRevisionId ?? null,
    };
  });

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

  /**
   * 确定性抽出来的原子数：先算一份，装配与留痕共用同一个数。
   *
   * 为什么要把它写进事件：从"抽出的原子"到"落库的候选"中间有四道**静默**去位——句子太短、
   * 被判成操作记录、对不上封存证据、超出 `activationHardMax`。现有三个计数器只记后两类之外
   * 的丢法，所以"这篇笔记到底在哪一步变短的"从库里读不出来（C16 那发 `candidateCount:1`
   * 而三个计数器全空，就是这么读不出来的）。
   */
  const atomsForRun = extractAtomsDeterministic(loaded.scopedBlocks);

  // ── 段 2/3：生成＋落库；已经有这一版候选了就从段 4 接上（重投不重付）────
  let candidates: LearningCardCandidateRevisionV2[];
  let hintsByCandidateRevisionId: Map<string, CardHintPairV2>;
  let generateOutput: CardGenerateV3TaskOutput | null = null;
  let gateRejections: ReadonlyArray<{ objectiveLocalId: string; codes: string[] }> = [];
  let assembled: CardGenerateV3AssemblyResult | null = null;
  /**
   * 重投时这一版计划可能已经落库：`current_plan_version` 只在段 3 提交成功后才前进，
   * 所以这里同时探一下"还没推进的那一版"，避免把同一批候选写在两个版本号下。
   *
   * 重排那一发**不探上一版**：上一版是用户刚刚看过、正要被换掉的那一批，接上它就等于
   * 「换一批」按钮把旧候选又检查了一遍（旧链在段 3 就把上一版没激活的候选 supersede 掉）。
   */
  const already = (await loadCommittedSimplifiedPlan(workspaceId, runId, planVersion))
    ?? (replanning ? null : await loadCommittedSimplifiedPlan(workspaceId, runId, Number(loaded.run.current_plan_version)));
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
      noteBlocks: capV3PromptBlocks(loaded.scopedBlocks),
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
      atoms: atomsForRun,
      sealedEvidence: loaded.sealed.evidenceManifest.evidence,
      preferredStrategies: semanticRequest.preferredStrategies,
      // W7-5 刀三：这一篇里已有哪些目标可供复用。读侧**按 (工作区, 笔记) 收窄**
      // （§4.2「默认去重范围是同工作区、同笔记」，跨笔记不自动抵扣），块锚按块去重，
      // 形态取当前修订，归档／被替代的不进候选。判据在 `decideObjectiveReuseV2`
      // （纯函数）里，装配那一层只负责递给它。
      reusableObjectives: await withWorkerWorkspaceTransaction(
        { workspaceId, userId: null },
        (readTx) => loadReusableObjectivesForNoteV2(readTx, {
          workspaceId,
          noteId: String((loaded.run as { note_id?: string | null }).note_id ?? ""),
        }),
      ),
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

    await withJobTransaction(async (tx) => {
      await insertSimplifiedPlanRow(tx, workspaceId, runId, assembled!.plan, planVersion, previousPlanRevisionId);
      await insertAuthoredCandidatesBatched(
        tx, workspaceId, runId, candidates, hintsByCandidateRevisionId, { skipExisting: true },
      );
      if (replanning) {
        // 换一批＝上一版没激活的候选让路（`activated`/`expired` 不在里面，已经进牌堆的
        // 那张不会因为用户重排而消失）。不挡掉的话审核台会同时摆出两批候选。
        await tx.execute(sql`
          UPDATE public.card_generation_candidates_v2
          SET publish_state = 'superseded', updated_at = now()
          WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
            AND plan_version < ${planVersion} AND publish_state = 'unpublished'
        `);
      }
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
        // 原子数与候选数放在同一条事件里：两者之差就是那四道静默去位吃掉的，
        // 不用再靠"哪一步变短的"去猜（见 `atomsForRun` 那段注释）。
        atomCount: atomsForRun.length,
      });
      // 源文本被规模上限截断过就要留痕（39d W4-4 那条判据，简化链此前没人记）：
      // `loadV2RunInputs` 交回来的已经是截断过的文本，只读加载器不发事件，
      // 所以由这一段的写事务记——与旧链四处进入点同一份发射器。
      await emitSourceContentCapEvent(tx, {
        workspaceId, runId, cap: loaded.sourceContentCap,
      });
      await fenceV2OutboxLease(tx, job);
    });
  }

  if (assembled?.plan.result.kind === "no_cards_recommended" && candidates.length === 0) {
    await finishNoCards(
      job,
      agentExecution,
      assembled.plan.result.kind === "no_cards_recommended" ? assembled.plan.result.reasonCodes : [],
      modelCalls(),
    );
    return;
  }
  if (candidates.length === 0) {
    // 重投路径下这一版计划本身就是 no_cards（上面已处理），到这里说明库里没有
    // 可检查的东西——照实收口，不发模型调用。
    // 但**原因要跟着走**：走到这一支的那一发是"抽得出原子、也交了草稿，却被内容门禁
    // 全数挡下"，`gateRejections` 里写着是哪几道门挡的。以前这里递一个空数组，
    // 终态就只剩"这篇没出卡"三个字——2026-09-27 量 C16 那篇（两句都被题面门挡下）时，
    // 就是这么把已知的原因丢掉的。
    await finishNoCards(job, agentExecution, [...new Set(gateRejections.flatMap((entry) => entry.codes))],
      modelCalls());
    return;
  }

  await runContentCheckLegV3({
    job,
    agentExecution,
    workspaceId,
    runId,
    loaded,
    plan: assembled?.plan ?? null,
    candidates,
    hintsByCandidateRevisionId,
    runOnKernel,
    checkProvider: checkCalls[0],
    rewriteProvider: rewriteCalls[0],
    rewriteCount: rewriteCalls[1],
    modelCalls,
  });
}

/**
 * 内容检查这一段（设计件的段 4／4b／5）抽成一条可复用的腿：整批生成走它，审核台上的
 * 「编辑后重检」「按反馈重生成」也走它（39d W7-7；39c §9 表的处置列那句
 * "用户改写走统一候选生成模式和增量检查"）。
 *
 * 抽出来的时候一行判据都没改——重检一张与重检一批在门禁、binding plan、报告落库、
 * run 终态上必须是同一套规则，起第二条腿迟早两条不一样。
 */
async function runContentCheckLegV3(args: {
  job: PendingOutboxJob;
  /** 父围栏归属；逐候选那一发恒无绑定（审核台的新 outbox 不认领）。 */
  agentExecution: AgentCardExecution;
  workspaceId: string;
  runId: string;
  loaded: Awaited<ReturnType<typeof loadV2RunInputs>>;
  plan: CardGenerateV3AssemblyResult["plan"] | null;
  candidates: LearningCardCandidateRevisionV2[];
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>;
  runOnKernel: <TInput, TOutput>(
    definition: AiTaskDefinition<TInput, TOutput>,
    input: TInput,
  ) => Promise<AiTaskReceipt<TOutput>>;
  checkProvider: CardGenerationV3ProviderPort<CardContentCheckV3TaskInput>;
  rewriteProvider: CardGenerationV3ProviderPort<CardCandidateRewriteV3TaskInput>;
  rewriteCount: () => number;
  modelCalls: () => number;
}): Promise<void> {
  const {
    job, agentExecution, workspaceId, runId, loaded, plan, runOnKernel,
    checkProvider, rewriteProvider, rewriteCount, modelCalls,
  } = args;
  const withJobTransaction = <T>(action: (tx: WorkerTransaction) => Promise<T>) =>
    withAgentCardJobTransaction(job, agentExecution, action);
  let candidates = args.candidates;
  const hintsByCandidateRevisionId = args.hintsByCandidateRevisionId;

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
    provider: checkProvider,
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
    // A later rewrite can fail its output contract. Keep the authoritative
    // first check, including passed cards and the issues on remaining drafts.
    // The run stays in checking; only the final settle opens user review.
    await withJobTransaction(async (tx) => {
      await writeSimplifiedCandidateCheckResults(tx, {
        workspaceId, runId, candidates, sealed: loaded.sealed, entries: checkOutput.parsed.perCandidate,
      });
      await insertEvent(tx, workspaceId, runId, "card_generation.content_checked", {
        candidateCount: candidates.length,
      });
      await fenceV2OutboxLease(tx, job);
    });
    const rebuilt: LearningCardCandidateRevisionV2[] = [];
    const task = createCardCandidateRewriteV3Task({
      provider: rewriteProvider,
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
        plan: plan ?? planFromCommittedCandidates(previous),
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
      await commitRewrittenRevisionsV3({
        job,
        agentExecution,
        workspaceId,
        runId,
        previousCandidates: candidates,
        rebuilt,
        hintsByCandidateRevisionId,
        rewriteCalls: rewriteCount(),
        rewriteReason: "content_check",
      });

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
        provider: checkProvider,
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
  // 这一发是从哪条腿进来的：整批那一发在在制档上收，逐候选那一发在审核台档上收。
  // 两件事因此不同——收走 run 的来源状态集合，以及"这一批还有没有可保留的候选"
  // 该问本批还是该问整个 run（见 `writeSimplifiedCheckResults`）。
  const settleScope: SimplifiedSettleScope =
    job.jobType === "card_candidate_refine_v3" ? "candidate_refine" : "batch_generation";
  await withJobTransaction(async (tx) => {
    await writeSimplifiedCheckResults(tx, {
      workspaceId,
      runId,
      candidates: finalCandidates,
      sealed: loaded.sealed,
      entries: finalEntries,
      unchecked: checkOutput.unchecked,
      modelCalls: modelCalls(),
      rewriteCalls: rewriteCount(),
      settleScope,
    });
    // 规模留痕按"这一发真的读过截断文本"记一次：整批那一发在段 3 已经记过，
    // 这里再记就会把同一批数成两条；逐候选那一发（重检／按反馈改写）不经过段 3，
    // 而它同样经 `loadV2RunInputs` 拿到截断过的源文本——所以由这一处记。
    if (settleScope === "candidate_refine") {
      await emitSourceContentCapEvent(tx, { workspaceId, runId, cap: loaded.sourceContentCap });
    }
    await fenceV2OutboxLease(tx, job);
  });
}

/**
 * 改写落库的那一发：旧修订只标 `superseded`（不可变），新修订插成兄弟行。
 * 整批链的段 4b 与审核台上「按反馈重生成」共用这一处——同一张表上写出来的形状
 * 必须一样，起第二份就会有一天只改一边。
 */
async function commitRewrittenRevisionsV3(args: {
  job: PendingOutboxJob;
  agentExecution: AgentCardExecution;
  workspaceId: string;
  runId: string;
  previousCandidates: ReadonlyArray<LearningCardCandidateRevisionV2>;
  rebuilt: ReadonlyArray<LearningCardCandidateRevisionV2>;
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>;
  rewriteCalls: number;
  rewriteReason: "content_check" | "user_feedback";
}): Promise<void> {
  const { job, agentExecution, workspaceId, runId, previousCandidates, rebuilt, hintsByCandidateRevisionId } = args;
  await withAgentCardJobTransaction(job, agentExecution, async (tx) => {
    for (const next of rebuilt) {
      const previous = previousCandidates.find(
        (candidate) => candidate.candidateRevisionId
          === next.derivedFromCandidateRevisions.at(-1)?.candidateRevisionId,
      )!;
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
        rewriteCalls: args.rewriteCalls,
        reason: args.rewriteReason,
      });
    }
    await fenceV2OutboxLease(tx, job);
  });
}

/**
 * 审核台上的两发（39d W7-7；39c §9 处置列："用户改写走统一候选生成模式和增量检查"）：
 *
 *   - `recheck`：编辑／合并之后的新修订只重过检查这一条腿，不改用户写好的内容；
 *   - `rewrite`：用户点了「按反馈重生成」，先按他给的因由改写这一张，再走同一条检查腿。
 *
 * 与整批链共用 `runContentCheckLegV3`，所以门禁、binding plan、质量报告、run 终态
 * 是同一套规则——一张与一批在判据上没有区别，区别只在候选数。
 */
export async function processCardCandidateRefineV3Job(
  job: PendingOutboxJob,
  providers: CardGenerationSimplifiedProviders,
  signal?: AbortSignal,
): Promise<void> {
  const workspaceId = job.workspaceId;
  const runId = job.runId;
  const payload = job.payload as {
    candidateRevisionId?: string;
    mode?: "recheck" | "rewrite";
    feedbackReasonCodes?: string[];
  };
  const candidateRevisionId = String(payload.candidateRevisionId ?? "");
  if (candidateRevisionId === "") {
    // 缺主体不是"没活干"：把它当 no-op 完成，那条候选会永远停在 `checking`。
    throw new CardGenerationProviderError(
      "non-retryable",
      "card_candidate_refine_v3 的 payload 缺 candidateRevisionId",
    );
  }
  // 逐候选那一发是用户自己在审核台上的明确动作，它的新 outbox **没有**与任何
  // `agent_operations` 行绑定：所以这里既没有父围栏也不向任何目标收费，即使这一批
  // 最初是由伴星发起的。已经 `completed` 的目标不该拦住用户后来的重检与重写。
  const agentExecution: AgentCardExecution = { binding: null };
  const checkCalls = counting(providers.check);
  const rewriteCalls = counting(providers.rewrite);
  const modelCalls = () => checkCalls[1]() + rewriteCalls[1]();

  const prepared = await withAgentCardJobTransaction(job, agentExecution, async (tx) => {
    const loaded = await loadV2RunInputs(tx, workspaceId, runId);
    const status = String(loaded.run.status);
    // 只接受"这一批已经摆到审核台上"的两个状态：`queued/planning/authoring/checking`
    // 是整批那一发的地盘，从这里插进去会让两条 job 同时写同一个 run 的候选行。
    if (!REFINE_RUNNABLE_STATUSES_V3.has(status)) return { kind: "skipped" as const, status };
    const rows = (await tx.execute(sql`
      SELECT * FROM public.card_generation_candidates_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        AND candidate_revision_id = ${candidateRevisionId}
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      // 这一发要领的修订已经不在了（用户又改了一次／整批重规划换了版本）。后到的那一发
      // 会把它自己的结论写进 run，所以这里按 no-op 收口，不把 run 打成 needs_attention。
      return { kind: "vanished" as const };
    }
    const subject = candidateRowToObject(rows[0], runId);
    const hints = (rows[0].hints ?? null) as CardHintPairV2 | null;
    if (!hints) {
      throw new CardGenerationProviderError(
        "non-retryable",
        `候选修订 ${candidateRevisionId} 没有提示对（兄弟列缺失），改写与检查都不做`,
      );
    }
    await fenceV2OutboxLease(tx, job);
    return { kind: "ready" as const, loaded, subject, hints };
  });

  if (prepared.kind !== "ready") {
    // `skipped`＝这一批还没摆到审核台上（或终态了）；`vanished`＝要领的那条修订已经被
    // 更新的一版换掉。两种都按 no-op 收口：把 run 打成 needs_attention 会替用户否决
    // 一批他没否决过的候选。
    logger.info({ runId, candidateRevisionId, kind: prepared.kind, status: prepared.kind === "skipped" ? prepared.status : null },
      "[v3-refine] nothing to refine on this run, job is a no-op");
    return;
  }
  const { loaded, hints } = prepared;
  let subject = prepared.subject;
  const hintsByCandidateRevisionId = new Map<string, CardHintPairV2>([[subject.candidateRevisionId, hints]]);

  const runOnKernel = <TInput, TOutput>(
    definition: AiTaskDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<AiTaskReceipt<TOutput>> => runV3TaskOnKernel(definition, input, job,
    String(loaded.run.note_version_id), loaded.inputSnapshot.inputSnapshotHash, signal);

  if (payload.mode === "rewrite") {
    const task = createCardCandidateRewriteV3Task({
      provider: rewriteCalls[0],
      prepare: async () => { throw new Error("rewrite task 的输入由调用方逐张给"); },
      commit: async () => {},
    });
    const codes = (payload.feedbackReasonCodes ?? []).filter((code) => code !== "");
    const rewriteInput: CardCandidateRewriteV3TaskInput = {
      runId,
      sourceContent: loaded.sourceContent,
      candidate: subject,
      hints,
      issues: codes.length > 0
        ? codes.map((code) => ({ code, detail: `用户在审核台上选了这一档反馈：${code}` }))
        : [{ code: "user_regenerate_requested", detail: "用户要求重做这一张，没有给出具体因由" }],
      evidenceManifest: loaded.sealed.evidenceManifest,
    };
    const ran = await runOnKernel(task, rewriteInput);
    if (ran.outcome !== "committed" || !ran.output) {
      throw kernelFailureError("card_candidate_rewrite_v3（用户要求重做）", ran.failure);
    }
    const built = buildCandidateRevisionV3({
      draft: ran.output.draft,
      plan: planFromCommittedCandidates(subject),
      runId,
      strategy: subject.presentation.strategy,
      reasonCodes: [...subject.recommendation.reasonCodes, "user_regenerate"],
      evidenceSetHash: loaded.sealed.evidenceSetHash,
      previous: subject,
    });
    // 提示对是候选行的兄弟列（NOT NULL），落库那一发从这张表里取它。
    hintsByCandidateRevisionId.set(built.candidate.candidateRevisionId, built.hints);
    await commitRewrittenRevisionsV3({
      job,
      agentExecution,
      workspaceId,
      runId,
      previousCandidates: [subject],
      rebuilt: [built.candidate],
      hintsByCandidateRevisionId,
      rewriteCalls: rewriteCalls[1](),
      rewriteReason: "user_feedback",
    });
    subject = built.candidate;
  }

  await runContentCheckLegV3({
    job,
    agentExecution,
    workspaceId,
    runId,
    loaded,
    plan: null,
    candidates: [subject],
    hintsByCandidateRevisionId,
    runOnKernel,
    checkProvider: checkCalls[0],
    rewriteProvider: rewriteCalls[0],
    rewriteCount: rewriteCalls[1],
    modelCalls,
  });
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
 * 该有却没有的落点）。其余类别遵循公共内核的重试集合；HTTP 400 等确定性拒绝
 * 不被领域包装改成传输故障。取消与整条管道预算由分发点另行收口。
 */
function kernelFailureError(taskId: string, failure: AiStepFailure | null): Error {
  const judged: AiStepFailure = failure
    ?? { ok: false, class: "submission_failed", message: `${taskId} 的回执既不是 committed，也没带失败类别` };
  return new CardGenerationProviderError(
    judged.class === "output_shape" || !AI_TASK_RETRYABLE_FAILURE_CLASSES.has(judged.class) ? "non-retryable" : "retryable",
    `${taskId} output rejected: ${judged.class} — ${judged.message}`.slice(0, 600),
    judged.class,
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
  agentExecution: AgentCardExecution,
  reasonCodes: readonly string[],
  modelCalls: number,
): Promise<void> {
  const { workspaceId, runId } = job;
  await withAgentCardJobTransaction(job, agentExecution, async (tx) => {
    // 用户在模型调用在途时按了「取消生成」：屏上已经说了已取消，模型 ~30 秒后回来
    // 却把这一轮改写成 no_cards_recommended，outbox job 随后被当成正常完成 ack 掉——
    // 那次取消**不可恢复**，而且屏上正在显示的那个结果与服务端已经对不上了。
    // 所以终局写一律带 CAS：只在它仍停在我们预期的工作态上才落（这一发只在整批那条
    // 腿上，走的来源状态集合与段 5 的整批档同一份，见 `SETTLE_FROM_STATUSES`）。
    const written = await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'no_cards_recommended', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
        AND status IN ${SETTLE_FROM_STATUSES.batch_generation}
      RETURNING id
    `);
    if (!written.count) return;
    await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
      reasonCodes,
      chain: "simplified_v3",
      modelCalls,
    });
    await fenceV2OutboxLease(tx, job);
  });
}

/**
 * 段 5 收口：补齐候选核对结果，再落 run 终态与完成回执。
 * 初次检查与最终检查共用候选写入函数，终态只在整条核对链结束后更新。
 */
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
    settleScope: SimplifiedSettleScope;
  },
): Promise<void> {
  const { workspaceId, runId, candidates, sealed, settleScope } = args;
  const passedRevisionIds = await writeSimplifiedCandidateCheckResults(tx, { workspaceId, runId, candidates, sealed, entries: args.entries });

  // run 终态只在整条核对链结束后收口；候选结论可以先落盘。
  const needsAttention = settleScope === "candidate_refine"
    ? !(await hasReviewablePassedCandidateV3(tx, workspaceId, runId))
    : passedRevisionIds.size === 0;
  const status = needsAttention ? "needs_attention" : "review_ready";
  const settledErrorMessage = needsAttention
    ? (settleScope === "candidate_refine"
      ? "重检后审核台上没有可保留的候选了"
      : "批量内容检查没有放行任何一张")
    : null;
  // 只从接手时允许的状态收口，用户取消后的迟到结果不能写回终态或完成回执。
  const settled = await tx.execute(sql`
    UPDATE public.card_generation_runs_v2
    SET status = ${status},
        error_code = ${needsAttention ? "quality_gate_failed" : null},
        error_message = ${settledErrorMessage},
        updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
      AND status IN ${SETTLE_FROM_STATUSES[settleScope]}
    RETURNING id
  `);
  if (!settled.count) return;
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
    settleScope,
  });
}

async function writeSimplifiedCandidateCheckResults(tx: WorkerTransaction, args: {
  workspaceId: string; runId: string; candidates: LearningCardCandidateRevisionV2[];
  sealed: Awaited<ReturnType<typeof loadV2RunInputs>>["sealed"];
  entries: CardContentCheckV3Output["perCandidate"];
}): Promise<Set<string>> {
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

  return passedRevisionIds;
}

/**
 * 这个 run 的审核台上（未激活也未让路）还剩几张可保留的候选。
 *
 * 只给逐候选那一发判终态用——整批那一发手里就有全批的判据，不必回库。
 * 过滤 `publish_state='unpublished'` 是为了只数**当前这一版**的台面：换一批之后
 * 上一版那些 passed 的候选只是 `superseded`，把它们算进来会让"这一版一张都没过"
 * 的 run 永远停在 review_ready。
 */
async function hasReviewablePassedCandidateV3(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1 FROM public.card_generation_candidates_v2
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      AND publish_state = 'unpublished' AND quality_state = 'passed'
    LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * 这条链今天的 provider 选择（一处常量＋一个环境变量，坏值不回落）。
 *
 * `CARD_GENERATION_V3_PROVIDER` 未设＝确定性那一版：今天它是这条链在生产里的唯一档位开关
 * （旧链与它的 `CARD_GENERATION_CHAIN` 已随 39d W7-7 刀二删除），所以"库里出现的简化链
 * 产物都是确定性拼的"这件事在生产里是一次显式配置，不是巧合。**要真模型时必须显式说**，
 * 并且今天直接失败——静默回落到确定性会让 §16.28 那句"2 次语义调用"读起来像跑过模型。
 */
const CARD_GENERATION_V3_PROVIDER_ENV = "CARD_GENERATION_V3_PROVIDER";
/** 与旧链那道 `V2_ALLOW_DETERMINISTIC_PROVIDERS` 同方向的显式豁免（离线跑生产形状的库时才用）。 */
const V3_ALLOW_DETERMINISTIC_ENV = "V3_ALLOW_DETERMINISTIC_PROVIDERS";

/**
 * 档位取值只有一处读法：`cardGenerationV3LlmRequested()` 与
 * `resolveCardGenerationV3Providers()` 各读一次 env，就会有一天不一致。
 *
 * 空串按"未设"处理，不算真模型：`${VAR:-}` 这类 compose 写法很常见，若按"非 deterministic"
 * 判，一次留白的配置就会把这一发悄悄翻成**按次付费**那一档。
 */
function cardGenerationV3ProviderKind(): string {
  const raw = (process.env[CARD_GENERATION_V3_PROVIDER_ENV] ?? "").trim();
  return raw === "" ? "deterministic" : raw;
}

/**
 * 这一发要不要走真模型（分发点用它决定要不要先去解析治理上下文）。
 * 判据与 `resolveCardGenerationV3Providers` 是同一份：两处各读一次 env 就会有一天不一致。
 */
export function cardGenerationV3LlmRequested(): boolean {
  return cardGenerationV3ProviderKind() !== "deterministic";
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
  const kind = cardGenerationV3ProviderKind();
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
 * （`CARD_GENERATION_V3_PROVIDER`）换到一批**看起来过了模型**的占位候选。
 * 与旧链那道护栏方向对称：生产要么显式配真模型，要么显式豁免（下面那个 env）。
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
