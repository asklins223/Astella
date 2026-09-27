/**
 * 制卡 V2 的**读侧与落库原语**：封存证据的读取、run 输入的装载（两条链共用一只读器）、
 * 候选行↔对象互转、事件与候选/binding plan/修复修订的批量落库，以及三个 prompt 规模上限。
 *
 * 39d W7-7 刀二·内核搬家第三块砖。前两块是 `outbox-queue.ts`（队列与租约）与
 * `retry-classification.ts`（错误可重试分类）。搬完这三块，`handlers/card-generation-v2-handler.ts`
 * 里剩下的就只是四阶段链体本身，可以整文件删除。
 *
 * 为什么这些算"共用"：简化链（`card-generation-v3/`）此刻就在 import 它们——同一张
 * `card_generation_candidates_v2` 表、同一套租约围栏、同一份证据闭包。留一份实现不是
 * 风格问题：落库列闭包抄两遍，早晚有一天只改一边。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type WorkerTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { CardGenerationProviderErrorLike } from "./retry-classification.ts";

/** 以下每一条都有旧 handler 或简化链在读；没在读的不导出（noUnusedLocals 会喊）。 */
import {
  executePlanner,
  type ExistingObjectiveRef,
  filterBlocksBySourceScope,
  assembleCandidateEvidenceBindingPlanV2,
  type SealedEvidenceEntryV2,
  type AssemblerEvidenceManifest,
} from "@ailearn/shared/card-generation-v2-pipeline";
import { computeCandidateEvidenceSetHashV2 } from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  generationSemanticSpecV2Schema,
  generationInputSnapshotV2Schema,
  type GenerationInputSnapshotV2,
  type GenerationSemanticSpecV2,
  type LearningCardCandidateRevisionV2,
  type CardHintPairV2,
} from "@ailearn/shared/card-generation-v2-contracts";

/**
 * 单条证据文本进入 prompt 的字符上限（评审 M7）。
 *
 * Grounding 阶段每个候选都会携带**全部**证据引文，token 成本为
 * O(candidates × evidence)；不分块/不设上限时大笔记会直接顶穿模型上下文。
 * 上限只作用于**prompt 呈现**，sealed 证据本身的哈希/偏移/闭包不受影响
 * （quoteHash 仍来自完整切片）。
 */
export const V2_EVIDENCE_QUOTE_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_EVIDENCE_QUOTE_MAX_CHARS ?? 2_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 2_000;
})();

/**
 * 每 job 全部证据文本的合计上限（评审 M7）：按 blockId 顺序累计，超出的引文
 * 截断到剩余额度（额度耗尽则为空串），避免"证据数 × 单条上限"仍然爆炸。
 */
export const V2_EVIDENCE_TOTAL_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_EVIDENCE_TOTAL_MAX_CHARS ?? 40_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 40_000;
})();

/** 源文本（scoped note join）进入 author prompt 的字符上限（评审 M7）。 */
export const V2_SOURCE_CONTENT_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_SOURCE_CONTENT_MAX_CHARS ?? 60_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * 源文本规模上限（M7）：超限时截断并显式告警（不静默）。
 *
 * 原注释自认"大笔记可达数十万字符"且"激活前须为源文本设规模上限或分块"——
 * 本函数兑现该上限：单 job 的内存峰值与 prompt token 规模被钉住。
 */
export function capSourceContentForPrompts(
  sourceContent: string,
  workspaceId: string,
): { content: string; truncated: boolean; originalLength: number } {
  if (sourceContent.length <= V2_SOURCE_CONTENT_MAX_CHARS) {
    return { content: sourceContent, truncated: false, originalLength: sourceContent.length };
  }
  logger.warn(
    {
      workspaceId,
      sourceLength: sourceContent.length,
      limit: V2_SOURCE_CONTENT_MAX_CHARS,
    },
    "V2 source content truncated for prompts (规模上限，防止 token/内存峰值)",
  );
  return {
    content: sourceContent.slice(0, V2_SOURCE_CONTENT_MAX_CHARS),
    truncated: true,
    originalLength: sourceContent.length,
  };
}

/** 证据文本规模上限（M7）：逐条 + 合计双上限，超限时告警。 */
function capEvidenceTextForPrompts(
  evidence: SealedEvidenceEntryV2[],
  workspaceId: string,
): void {
  let remaining = V2_EVIDENCE_TOTAL_MAX_CHARS;
  let truncated = 0;
  for (const entry of evidence) {
    const text = entry.content ?? "";
    const perEntry = text.slice(0, V2_EVIDENCE_QUOTE_MAX_CHARS);
    const allowed = Math.max(0, Math.min(perEntry.length, remaining));
    if (allowed < text.length) truncated += 1;
    entry.content = perEntry.slice(0, allowed);
    remaining -= allowed;
  }
  if (truncated > 0) {
    logger.warn(
      {
        workspaceId,
        truncatedEntries: truncated,
        totalEntries: evidence.length,
        perEntryLimit: V2_EVIDENCE_QUOTE_MAX_CHARS,
        totalLimit: V2_EVIDENCE_TOTAL_MAX_CHARS,
      },
      "V2 evidence text truncated for prompts (规模上限，防止 O(candidates × evidence) token 膨胀)",
    );
  }
}

export async function loadSealedEvidence(tx: WorkerTransaction, workspaceId: string, sourceSnapshotId: string) {
  const snapshotRows = (await tx.execute(sql`
    SELECT evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id, block_id,
           start_offset, end_offset, quote_hash, block_content_hash
    FROM public.evidence_snapshots_v2
    WHERE workspace_id = ${workspaceId} AND source_snapshot_id = ${sourceSnapshotId}
    ORDER BY block_id, start_offset
  `)) as Array<Record<string, unknown>>;
  const evidence: SealedEvidenceEntryV2[] = snapshotRows.map((r) => ({
    evidenceSnapshotId: String(r.evidence_snapshot_id),
    evidenceSnapshotHash: String(r.evidence_snapshot_hash),
    sourceSnapshotId: String(r.source_snapshot_id),
    blockId: String(r.block_id),
    startOffset: Number(r.start_offset),
    endOffset: Number(r.end_offset),
    quoteHash: r.quote_hash ? String(r.quote_hash) : "",
    blockContentHash: String(r.block_content_hash),
  }));

  let eligibility: Array<{ evidenceSnapshotId: string; eligibilityEpoch: number; status: string; stateHash: string }> = [];
  if (evidence.length > 0) {
    const eligRows = (await tx.execute(sql`
      SELECT ees.evidence_snapshot_id, ees.eligibility_epoch, ees.status, ees.eligibility_vector_hash
      FROM public.evidence_eligibility_states_v2 ees
      JOIN public.evidence_snapshots_v2 es ON es.evidence_snapshot_id = ees.evidence_snapshot_id
      WHERE ees.workspace_id = ${workspaceId} AND es.source_snapshot_id = ${sourceSnapshotId}
    `)) as Array<Record<string, unknown>>;
    eligibility = eligRows.map((r) => ({
      evidenceSnapshotId: String(r.evidence_snapshot_id),
      eligibilityEpoch: Number(r.eligibility_epoch),
      status: String(r.status),
      stateHash: String(r.eligibility_vector_hash),
    }));
  }

  // R29：Grounding 需要真实证据文本——按 blockId 查 note_blocks，按 [startOffset, endOffset) 切片。
  if (evidence.length > 0) {
    const blockIds = [...new Set(evidence.map((e) => e.blockId))];
    // drizzle+postgres-js 对数组参数的序列化不可靠（malformed array literal）——
    // 手工构造 {uuid,...} 字面量并 cast。
    const blockIdsLiteral = `{${blockIds.join(",")}}`;
    const blockRows = (await tx.execute(sql`
      SELECT id, content FROM public.note_blocks WHERE id = ANY(${blockIdsLiteral}::uuid[])
    `)) as Array<{ id: string; content: string }>;
    const byId = new Map(blockRows.map((b) => [String(b.id), String(b.content ?? "")]));
    for (const e of evidence) {
      const blockText = byId.get(e.blockId) ?? "";
      // AI P0-11（2026-09-15 审计）：seal 时写入的 block_content_hash / quote_hash
      // 此前从未被重算。note_blocks.content 在 autosave 中是**原地 UPDATE**
      // （apps/api/src/modules/note/service.ts:452-467）——block id 不变、正文可变，
      // 于是"seal 之后、worker 读取之前"编辑笔记，会让**新正文配上旧 hash** 进入
      // 制卡管道：grounding 的 evidence 闭包与落库的 evidenceSetHash 都声称是旧内容。
      // 伴星路径（companion-grounded-evidence.ts:44-49）与 learning-runs Critic
      // （run-critic.ts:364-369）都会在这里 throw；本路径此前是唯一缺口。
      // 非重试：笔记已改，重放同一 snapshot 不会自愈，必须重新 seal。
      if (hashCanonicalV2("block", { content: blockText }) !== e.blockContentHash) {
        throw new CardGenerationProviderErrorLike(
          false,
          `sealed evidence block changed since seal (evidenceSnapshotId=${e.evidenceSnapshotId}, blockId=${e.blockId}): note edited after seal`,
        );
      }
      const start = Math.max(0, Number(e.startOffset ?? 0));
      const end = Math.min(blockText.length, Number(e.endOffset ?? blockText.length));
      const quote = blockText.slice(start, end);
      if (e.quoteHash && hashCanonicalV2("evidence-quote", { quote }) !== e.quoteHash) {
        throw new CardGenerationProviderErrorLike(
          false,
          `sealed evidence quote changed since seal (evidenceSnapshotId=${e.evidenceSnapshotId}, blockId=${e.blockId})`,
        );
      }
      e.content = quote;
    }
    capEvidenceTextForPrompts(evidence, workspaceId);
  }

  const evidenceManifest: AssemblerEvidenceManifest = {
    workspaceId,
    sourceSnapshotId,
    evidence,
  };
  return {
    evidenceManifest,
    eligibility,
    evidenceSetHash: computeCandidateEvidenceSetHashV2(
      evidence.map((e) => ({ evidenceSnapshotId: e.evidenceSnapshotId, evidenceSnapshotHash: e.evidenceSnapshotHash })),
    ),
  };
}

/**
 * 执行完整的 V2 四阶段生成管道（A1 · B1：计划与作者**分两次提交**）。
 *
 * 为什么拆：整条管道原先在同一个事务里，计划行、候选行、终态要么一起出现要么一起
 * 消失——"崩在作者中途"等于整批作废、已付费的 planner 调用一起赔进去。拆成两段之后
 * 计划先进库，重投只需读回它（§39 事实 2：`planRevisionId` 每次执行现造，
 * 若重放时"复用上次候选 + 用这版新计划继续跑"，审计链当场断裂）。
 *
 * 代价与它的前置（§39 事实 3/4）：`run.status` 一旦提前提交，"看状态"的入口守卫就会把
 * 重投变成**静默空转**（run 永远停在 authoring，这篇笔记此后每次生成都吃 409）。
 * 所以判活改看**自己那条 outbox 租约**：每段事务提交前都核对一次，核对不过就停下不写。
 *
 * `signal`：job 级取消信号（租约丢失 / 墙钟预算耗尽）——透传到四个阶段的
 * LLM 调用与逐候选循环（H5/M1）。
 */

export async function loadV2RunInputs(tx: WorkerTransaction, workspaceId: string, runId: string) {
  // FOR UPDATE 行锁：loadV2RunInputs 仅在 withWorkerWorkspaceTransaction（真实事务）
  // 内被 regenerate/replan/recheck 调用，事务内持锁可串行化同 run 的并发 job，
  // 防止 read-then-modify 的 TOCTOU 竞态（W2）。
  const runRows = (await tx.execute(sql`
    SELECT id, workspace_id, note_id, note_version_id, status, card_content_epoch,
           semantic_spec, input_snapshot, semantic_spec_hash, input_snapshot_hash,
           current_plan_version
    FROM public.card_generation_runs_v2
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
    FOR UPDATE
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  // 确定性数据违约（run 不存在）：非重试（§24 fail-closed，与 plan/schema 同口径）
  if (runRows.length === 0) throw new CardGenerationProviderErrorLike(false, `V2 run not found: ${runId}`);
  const run = runRows[0];
  const inputSnapshot = run.input_snapshot as unknown as GenerationInputSnapshotV2;
  const semanticSpec = run.semantic_spec as unknown as GenerationSemanticSpecV2;
  // 存储时 input_snapshot_hash/semantic_spec_hash 是对"无自引用字段"的对象计算的
  // （§9.2），读回后先补齐，再按 §24 做 zod 严格校验（非法 schema fail-closed，
  // 违反契约直接以非重试错误失败 job，绝不带病生成）。
  inputSnapshot.inputSnapshotHash = run.input_snapshot_hash as string;
  semanticSpec.semanticSpecHash = run.semantic_spec_hash as string;
  const specParse = generationSemanticSpecV2Schema.safeParse(semanticSpec);
  if (!specParse.success) {
    const paths = specParse.error.issues.map((i) => i.path.join(".")).join(",");
    // schema 违反是永久错误：非重试，job 直接 failed（§24 fail-closed）
    throw new CardGenerationProviderErrorLike(false, `V2 semantic spec schema violation: ${paths}`);
  }
  const snapshotParse = generationInputSnapshotV2Schema.safeParse(inputSnapshot);
  if (!snapshotParse.success) {
    const paths = snapshotParse.error.issues.map((i) => i.path.join(".")).join(",");
    throw new CardGenerationProviderErrorLike(false, `V2 input snapshot schema violation: ${paths}`);
  }
  const sourceSnapshotId = inputSnapshot.sourceSnapshot.sourceSnapshotId;

  const sealed = await loadSealedEvidence(tx, workspaceId, sourceSnapshotId);

  const blockRows = (await tx.execute(sql`
    SELECT id, type, content, ordinal
    FROM public.note_blocks
    WHERE version_id = ${run.note_version_id}
    ORDER BY ordinal ASC
  `)) as Array<{ id: string; type: string; content: string; ordinal: number }>;
  const scopedBlocks = filterBlocksBySourceScope(
    blockRows.map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal })),
    inputSnapshot.rawRequest.sourceScope,
  ).map((s) => ({ blockId: s.block.blockId, type: s.block.type, content: s.slice, ordinal: s.block.ordinal }));
  // §14.2（R36）：被 seal 剔除的非文本模态 block——region evidence 未实现时
  // 无法可靠制卡，replan/regenerate 同样必须显式提示。
  const unsupportedSourceBlocks = blockRows
    .filter((b) => ["image", "code", "diagram", "formula", "table"].includes(String(b.type ?? "").toLowerCase()))
    .map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal }));
  // 同 processCardGenerationPlan（M7）：源文本规模硬上限（超限截断 + 告警），
  // regenerate/replan/recheck 管道共用同一护栏，避免大笔记在重跑路径上再次膨胀。
  const cappedSourceContent = capSourceContentForPrompts(
    scopedBlocks.map((b) => b.content).join("\n"),
    workspaceId,
  );
  const sourceContent = cappedSourceContent.content;

  const existingObjRows = (await tx.execute(sql`
    SELECT lor.objective_id, lor.semantic_target_fingerprint,
           lor.objective_statement, lor.public_summary
    FROM public.learning_objective_revisions_v2 lor
    JOIN public.learning_objectives_v2 lo ON lo.objective_id = lor.objective_id
      AND lo.workspace_id = lor.workspace_id
    WHERE lo.workspace_id = ${workspaceId}
      AND lo.lifecycle = 'active'
      AND lor.revision = lo.current_revision
  `)) as Array<{
    objective_id: string; semantic_target_fingerprint: string;
    objective_statement: string; public_summary: string;
  }>;
  const existingObjectives: ExistingObjectiveRef[] = existingObjRows.map((r) => ({
    objectiveId: r.objective_id,
    semanticTargetFingerprint: r.semantic_target_fingerprint,
    objectiveStatement: r.objective_statement,
    publicSummary: r.public_summary,
  }));

  const planRows = (await tx.execute(sql`
    SELECT plan_revision_id, plan_version, previous_plan_revision_id, plan_hash,
           result, atom_decisions
    FROM public.card_generation_plans_v2
    WHERE run_id = ${runId} AND workspace_id = ${workspaceId}
      AND plan_version = ${run.current_plan_version}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  const plan: Awaited<ReturnType<typeof executePlanner>>["plan"] | null = planRows.length === 0
    ? null
    : {
        version: 2,
        planRevisionId: planRows[0].plan_revision_id as string,
        runId,
        inputSnapshotHash: inputSnapshot.inputSnapshotHash,
        cardContentEpoch: Number(run.card_content_epoch),
        planVersion: Number(planRows[0].plan_version),
        previousPlanRevisionId: (planRows[0].previous_plan_revision_id as string | null) ?? null,
        result: planRows[0].result as never,
        atomDecisions: planRows[0].atom_decisions as never,
        planHash: planRows[0].plan_hash as string,
      };

  return {
    run, inputSnapshot, semanticSpec, sealed, scopedBlocks, unsupportedSourceBlocks, sourceContent, existingObjectives, plan,
    /**
     * 这一次的 prompt 源文本有没有被规模上限截断（M7）。**调用方负责在自己的写事务里
     * 把它变成事件**（`emitSourceContentCapEvent`）——这个加载器是只读的、且被
     * regenerate／replan／recheck 三处共用，留痕不该由它自己写。
     */
    sourceContentCap: {
      truncated: cappedSourceContent.truncated,
      originalLength: cappedSourceContent.originalLength,
      limit: V2_SOURCE_CONTENT_MAX_CHARS,
    },
  };
}

/**
 * §17.4 regenerate_candidate：worker 重写该候选 → 新 immutable revision →
 * 重跑双 Critic + deck gate（漏斗的 judge/commit 两半）。
 * 旧 revision 只 supersede、不覆盖；重写失败 → run needs_attention（fail closed）。
 *
 * 2026-09-25（#19 第二刀）：与 `processRecheckCandidateJob` 同一形状——**读 → 出网 → 写**
 * 三相。改前整条链在一个事务里：作者重写（这条链最贵最慢的一次调用）与两道 Critic
 * 都发生在事务内，于是 run 的行锁被按住的时长 = 模型响应的时长。
 *
 * 2026-09-26（W3-2 第三刀）：漏斗判定整体收进相位 2——预计算 pedagogy 失败或序列
 * 守卫不过时的兜底重跑，从此也发生在**没有事务**的地方（改前它落回相位 3 的写
 * 事务里）。相位 3 只落库（supersede → `regenerating` 事件 → 新 revision →
 * 门禁结论 → `regenerated` 事件）；出网期间的边界由公共 HTTP 出口的闸门执行。
 */

export function candidateRowToObject(
  row: Record<string, unknown>,
  runId: string,
): LearningCardCandidateRevisionV2 {
  return {
    version: 2,
    candidateRevisionId: row.candidate_revision_id as string,
    candidateId: row.candidate_id as string,
    revision: Number(row.revision),
    runId,
    planRevisionId: row.plan_revision_id as string,
    planVersion: Number(row.plan_version),
    planHash: row.plan_hash as string,
    cardContentEpoch: Number(row.card_content_epoch),
    planObjectiveLocalId: row.plan_objective_local_id as string,
    recommendation: row.recommendation as never,
    derivedFromCandidateRevisions: row.derived_from as never,
    objective: row.objective_draft as never,
    presentation: row.presentation_draft as never,
    evidenceSetHash: row.evidence_set_hash as string,
    candidateRevisionHash: row.candidate_revision_hash as string,
  } as unknown as LearningCardCandidateRevisionV2;
}

/**
 * recheck 接受的 run 状态。`checking` 是必需的：主管线在"候选被判 rewrite、等待复核"
 * 时保持的进行中状态。
 */

/**
 * 源文本被规模上限截断时的那一条留痕（39d W4-4：不许"静默截前半篇冒充整篇输入"）。
 *
 * 旧链四处进入点共用这一份：主管线计划段、regenerate、replan、recheck。判据与载荷都只有
 * 简化链（39d W7-7 刀二之后）也算一个进入点：它经 `loadV2RunInputs` 拿到的就是截断过的
 * 源文本，留痕与旧链同判据——不然"新链少一道护栏"只能靠测试搬档时才发现。
 * 一处，免得"某一个进入点忘了记"。**只在真的截断时写**（没截断 = 没有这件事要记）。
 */
export async function emitSourceContentCapEvent(
  tx: WorkerTransaction,
  input: {
    workspaceId: string;
    runId: string;
    cap: { truncated: boolean; originalLength: number; limit: number };
  },
): Promise<void> {
  if (!input.cap.truncated) return;
  await insertEvent(tx, input.workspaceId, input.runId, "card_generation.source_content_capped", {
    limit: input.cap.limit,
    originalLength: input.cap.originalLength,
    usedLength: input.cap.limit,
  });
}

/**
 * 对失败候选做局部 repair 的**出网那一半**：调 author provider 重写 → 新 immutable
 * revision 对象。**不碰数据库**——它连 `tx` 都不收，类型上就写不出"顺手把新行也插了"。
 *
 * 拆开的理由（39d W3-2/#19）：修复原本是"作者调用＋落库"同体、非拿事务才调得动的函数，
 * 于是 regenerate 整条链只能挤在事务里，一次慢响应就把 run 行锁按住。现在出网与写分成
 * 两半，调用方按 D5 §5.2 的三段形状自己组织：短事务读 → **事务外**调本函数 →
 * 短事务插入（`insertRepairedCandidateV2`）。
 */

/**
 * 有界修复的**落库那一半**：只写，不出网。
 *
 * 刻意不用 `ON CONFLICT DO NOTHING`：同一目标重复修复会产出同样的 `revision + 1`，必须
 * 当场撞 0253 那条唯一索引。静默跳过会让第二次修复带着一个库里不存在的 revision 继续跑门禁。
 * （钉这条的用例是 `card-generation-v2-bounded-repair-postgres.integration.ts`，
 * 已随四阶段链在 39d W7-7 刀二删掉——这条不变量现在只有索引本身在执法。）
 */
export async function insertRepairedCandidateV2(
  tx: WorkerTransaction,
  input: {
    runId: string;
    workspaceId: string;
    candidate: LearningCardCandidateRevisionV2;
    hints: CardHintPairV2;
  },
): Promise<void> {
  const candidate = input.candidate;
  await tx.execute(sql`
    INSERT INTO public.card_generation_candidates_v2
      (id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
       plan_revision_id, plan_version, plan_hash, card_content_epoch,
       plan_objective_local_id, recommendation, derived_from,
       objective_draft, presentation_draft, hints, evidence_set_hash,
       candidate_revision_hash, quality_state, review_decision, publish_state)
    VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.runId},
      ${candidate.candidateId}, ${candidate.candidateRevisionId}, ${candidate.revision},
      ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
      ${candidate.cardContentEpoch}, ${candidate.planObjectiveLocalId},
      ${JSON.stringify(candidate.recommendation)}::jsonb,
      ${JSON.stringify(candidate.derivedFromCandidateRevisions)}::jsonb,
      ${JSON.stringify(candidate.objective)}::jsonb,
      ${JSON.stringify(candidate.presentation)}::jsonb,
      ${JSON.stringify(input.hints)}::jsonb,
      ${candidate.evidenceSetHash},
      ${candidate.candidateRevisionHash},
      'authored', 'undecided', 'unpublished'
    )
  `);
}

// ─── 确定性辅助 ──────────────────────────────────────────────────────────
// 确定性 Grounding 的实现在 `@ailearn/shared/card-generation-v2-pipeline`（W7-1 刀a 上移，V3 共用）。


/**
 * 持久化 binding plan 行到 `candidate_evidence_binding_plans_v2`
 * （2026-08-24 §4.4 第二批：plan 组装在 shared 纯逻辑层，本函数是 worker
 * 侧 IO——与 apps/api persistCandidateEvidenceBindingPlanV2 落同一张表、
 * 同样的列闭包（R32：完整 bindings 条目），仅以 raw SQL 表达。
 * 注意：表/列名以 packages/shared db-schema 的 drizzle 定义为准
 * （candidate_evidence_binding_plans_v2，无 card_ 前缀）。）
 */
export async function insertBindingPlanRow(
  tx: WorkerTransaction,
  args: {
    runId: string;
    workspaceId: string;
    candidate: LearningCardCandidateRevisionV2;
    result: ReturnType<typeof assembleCandidateEvidenceBindingPlanV2>;
  },
): Promise<void> {
  const { runId, workspaceId, candidate, result } = args;
  await tx.execute(sql`
    INSERT INTO public.candidate_evidence_binding_plans_v2
      (id, workspace_id, binding_plan_id, run_id,
       candidate_revision_id, candidate_revision_hash,
       plan_revision_id, plan_version, plan_hash,
       target_unit_bindings, binding_plan_hash, evidence_eligibility_vector_hash)
    VALUES (
      gen_random_uuid(), ${workspaceId}, ${result.bindingPlanId}, ${runId},
      ${candidate.candidateRevisionId}, ${candidate.candidateRevisionHash},
      ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
      ${JSON.stringify(result.plan.bindings)}::jsonb, ${result.bindingPlanHash},
      ${result.evidenceEligibilityVectorHash}
    )
  `);
}

/** 单条 V2 运行事件写入（一次 MAX + 一次 INSERT；语义同 api helpers.insertEvent）。 */
export async function insertEvent(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await insertEventsBatched(tx, workspaceId, runId, [{ eventType, payload }]);
}

/**
 * 批量写入 V2 领域事件（一次 MAX + 一次多行 INSERT）。
 * event_seq 在同一 (workspace, run) 内唯一且递增；批量写入时按插入顺序
 * 顺序分配 seq，避免逐事件 MAX 查询 + INSERT 的 N+1 round-trip。
 * 仅在事务内调用（调用方已持有 run 行锁/事务上下文）。
 */
async function insertEventsBatched(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  events: Array<{ eventType: string; payload: Record<string, unknown> }>,
): Promise<void> {
  if (events.length === 0) return;
  const rows = await tx.execute(sql`
    SELECT COALESCE(MAX(event_seq), 0) AS max_seq
    FROM public.card_generation_events_v2
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
  `);
  const base = Number(rows[0]?.max_seq ?? 0);
  await tx.execute(sql`
    INSERT INTO public.card_generation_events_v2
      (id, workspace_id, run_id, event_seq, event_type, payload, created_at)
    VALUES ${sql.join(events.map((e, i) => sql`(
      gen_random_uuid(), ${workspaceId}, ${runId}, ${base + i + 1},
      ${e.eventType}, ${JSON.stringify(e.payload)}::jsonb, now()
    )`), sql`, `)}
  `);
}

/**
 * 落库缺省值。作者链路总会给出提示，这里只兜住"确实没有提示"的行（历史数据、
 * 以及不经过作者的未来来源）；读取方见到空 level1 时退回按卡片结构派生的提示。
 */
const EMPTY_HINTS: CardHintPairV2 = { level1: "", level2: "" };

/**
 * 批量持久化刚 author 出来的候选（一次多行 INSERT + 一次批量事件）。
 *
 * M8（2026-09-15 管线评审）：主管线此前已批量化，replan 仍是逐候选 INSERT +
 * 逐候选 insertEvent（每候选 2 次 SQL，事件插入还各带一次 MAX 往返）。两条路径
 * 合并到本 helper，杜绝再次漂移。
 */
/**
 * 候选行的列清单与取值（A1·B2 抽出来共用）。
 *
 * 抽出来的理由不是省事：批量落地的 replan 与逐候选落地的主管线**必须**写同一份列，
 * 否则"哪条路径少写一列"又会变成一次考古（M8 当年合并两条路径就是这个原因）。
 */
const AUTHORED_CANDIDATE_COLUMNS = sql`(
  id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
  plan_revision_id, plan_version, plan_hash, card_content_epoch,
  plan_objective_local_id, recommendation, derived_from,
  objective_draft, presentation_draft, hints, evidence_set_hash,
  candidate_revision_hash, quality_state, review_decision, publish_state
)`;

function authoredCandidateValues(
  candidate: LearningCardCandidateRevisionV2,
  workspaceId: string,
  runId: string,
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>,
) {
  return sql`(
      ${randomUUID()}, ${workspaceId}, ${runId},
      ${candidate.candidateId}, ${candidate.candidateRevisionId}, ${candidate.revision},
      ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
      ${candidate.cardContentEpoch}, ${candidate.planObjectiveLocalId},
      ${JSON.stringify(candidate.recommendation)}::jsonb,
      ${JSON.stringify(candidate.derivedFromCandidateRevisions)}::jsonb,
      ${JSON.stringify(candidate.objective)}::jsonb,
      ${JSON.stringify(candidate.presentation)}::jsonb,
      ${JSON.stringify(hintsByCandidateRevisionId.get(candidate.candidateRevisionId) ?? EMPTY_HINTS)}::jsonb,
      ${candidate.evidenceSetHash},
      ${candidate.candidateRevisionHash},
      'authored', 'undecided', 'unpublished'
    )`;
}

export async function insertAuthoredCandidatesBatched(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  candidates: LearningCardCandidateRevisionV2[],
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>,
  options: { skipExisting?: boolean } = {},
): Promise<string[]> {
  if (candidates.length === 0) return [];
  // A1·B2：`skipExisting` 时同目标的已提交行**跳过而不是报错**，并且只给真的插进去
  // 的那些发事件——主管线逐候选提交与重放复用都靠这个返回值判断"这张是我写的吗"。
  const inserted = options.skipExisting
    ? (await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          ${AUTHORED_CANDIDATE_COLUMNS}
        VALUES ${sql.join(candidates.map((candidate) => authoredCandidateValues(candidate, workspaceId, runId, hintsByCandidateRevisionId)), sql`, `)}
        ON CONFLICT (workspace_id, run_id, plan_version, plan_objective_local_id, revision)
        DO NOTHING
        RETURNING candidate_revision_id
      `)) as Array<{ candidate_revision_id: string }>
    : (await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          ${AUTHORED_CANDIDATE_COLUMNS}
        VALUES ${sql.join(candidates.map((candidate) => authoredCandidateValues(candidate, workspaceId, runId, hintsByCandidateRevisionId)), sql`, `)}
        RETURNING candidate_revision_id
      `)) as Array<{ candidate_revision_id: string }>;
  const insertedIds = new Set(inserted.map((row) => String(row.candidate_revision_id)));
  const authored = candidates.filter((candidate) => insertedIds.has(candidate.candidateRevisionId));
  await insertEventsBatched(tx, workspaceId, runId, authored.map((candidate) => ({
    eventType: "card_candidate.authored",
    payload: {
      candidateId: candidate.candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
    },
  })));
  return [...insertedIds];
}

/**
 * 逐候选提交（A1 · B2）：一张候选一个短事务，行与它的 `authored` 事件同生同死。
 *
 * 为什么事件要跟在同一个事务里：分开写就会出现"行在、事件没有"的崩溃窗口，而事件是
 * 审核页与审计回答"这张卡是哪一遍产出的"的凭证。
 *
 * 为什么要重试：`event_seq` 由 `MAX+1` 分配，`(workspace_id, run_id, event_seq)` 是唯一
 * 索引——两张候选各自的短事务并发写同一 run 的事件会撞（23505）。撞了只能**重开整个
 * 短事务**（Postgres 里语句一旦报错，当前事务已进入中止状态，原地重跑不了），
 * 重开之后重新分配 seq。候选行本身不会重复插（冲突目标是 0253 那条五列索引，DO NOTHING）。
 *
 * 返回 true = 这一行是本次写进去的；false = 库里已有同目标行（并发/重放），
 * 调用方必须改用它，不能带着自己新造的身份继续跑。
 */

/** 只认这一种唯一冲突（事件序号被并发抢走），别的约束违反照常往上抛。 */

// ─── Providers 构造（惰性，减小 worker 重边）─────────────────────────────

/**
 * 在开管道事务**之前**解析治理上下文（A，2026-09-21）。
 *
 * 0237 把 AI 同意与数据外发政策从工作区级搬到账号级之后，读 `user_ai_settings`
 * 必须带 `app.user_id`；而这四条 LLM 管道的事务是以 `userId: null` 打开的，
 * 在事务内部再开一个带用户身份的作用域会被作用域守卫直接拒
 * （`nested worker workspace database work cannot change workspace or user context`）。
 * 伴星侧（`companion-thought.ts`、`companion-dialogue.ts`）一直是在事务外解析好
 * 再传进去的，这里对齐同一个写法：一次普通读取 + 一次解析，都在 tx 外完成。
 */
