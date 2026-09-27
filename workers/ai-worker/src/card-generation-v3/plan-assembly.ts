/**
 * 制卡简化链（V3）的**服务端组装**（39d W7-1 刀a；39c §6.1、39 §8.6）。
 *
 * 模型交回来的只是一份**草稿**（`card-generation-v3-contracts` 那三件：
 * planIntent / objectiveProposals / candidates）。这张计划与这些候选要能被审计，
 * 靠的是三件模型说了不算的事，全部在这里做：
 *
 *   1. **整批分配题型与练习件配额**——`allocateStrategies` / `allocatePracticeForms`
 *      是 V2 planner 在用的两份判据，原样调用不另写。逐张出题时模型看不见别的卡，
 *      所以 `presentationDraft.strategy` **以分配结果为准**；
 *   2. **一切身份与哈希**——planHash / rubricHash / candidateRevisionHash 与两个
 *      uuid 全部服务端算。草稿里带的 `rubricHash` 丢弃重算：V2 的 author 是"校验
 *      模型给的哈希"，V3 没有逐候选 author 再补一次，所以是"不信、自己算"；
 *   3. **知识原子定位**——`sourceAtomIds` 是"这张卡从哪一句来"的可审计线索，取自
 *      确定性原子抽取（零模型调用）。定位不到的候选**剔除并留因**，不拿一个不相干
 *      的原子凑数（39c §6.1："程序剔除无效项并保留可独立解析的完整候选"）。
 *
 * 产物形状与 V2 完全一致（同一张 `card_generation_plans_v2` 与同一张候选表），所以
 * 审核页、激活与状态机都不需要为新链改判据。
 */
import { randomUUID } from "node:crypto";
import {
  NoCardReasonCodeValuesV2,
  cardPlanV2Schema,
  derivePracticeItemFromCanonicalAnswer,
  type AtomDecisionV2,
  type CardHintPairV2,
  type CardPlanV2,
  type CardStrategyV2,
  type LearningCardCandidateRevisionV2,
  type NoCardReasonCodeV2,
  type ObjectiveRubricV2,
  type PlannedObjectiveV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeCandidateRevisionHashV2,
  computeCardPlanHashV2,
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import {
  allocatePracticeForms,
  allocateStrategies,
  buildCandidatePrecheck,
  type AssemblerEvidenceManifest,
  type ExtractedKnowledgeAtom,
  type SealedEvidenceEntryV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  type CardGenerateV3CandidateDraft,
  type CardGenerateV3DraftOutput,
} from "@ailearn/shared/card-generation-v3-contracts";
// W7-5 刀三：判据是**纯函数**（不查库、不看模型输出），所以装配这一层只负责
// 把"新候选的块"与"读侧给来的既有目标"递给它，然后照它交回的结论改 changeContext。
import {
  decideObjectiveReuseV2,
  type ObjectiveReuseCandidateV2,
} from "@ailearn/shared/objective-reuse-rules-v2";

export interface CardGenerateV3AssemblyInput {
  readonly generated: CardGenerateV3DraftOutput;
  /** 过程序校验后**留下**的候选草稿（顺序即落库顺序）。 */
  readonly acceptedCandidates: readonly CardGenerateV3CandidateDraft[];
  readonly runId: string;
  readonly planRevisionId: string;
  readonly planVersion: number;
  readonly previousPlanRevisionId: string | null;
  readonly inputSnapshotHash: string;
  readonly cardContentEpoch: number;
  readonly activationHardMax: number;
  /** sealed manifest 的 evidenceSetHash：进 candidateRevisionHash 的闭包。 */
  readonly evidenceSetHash: string;
  /** 确定性原子抽取的产出（零模型调用）。 */
  readonly atoms: readonly ExtractedKnowledgeAtom[];
  /** sealed evidence 清单：候选的依据 id 经它换算到块，再定位原子。 */
  readonly sealedEvidence: readonly SealedEvidenceEntryV2[];
  /** 本轮生效的题型偏好（整批分配的输入之一）。 */
  readonly preferredStrategies?: readonly CardStrategyV2[];
  /**
   * W7-5 刀三：这一篇里**已有**的目标，连同它们的块锚与形态（读侧
   * `loadReusableObjectivesForNoteV2` 的产出，已经按 (工作区, 笔记) 收窄）。
   *
   * 缺省 `[]`＝这一篇还没有任何目标（首篇笔记那一档），全部 `create_new`——
   * 那是判据的输入，不是"复用被关掉了"。
   */
  readonly reusableObjectives?: readonly ObjectiveReuseCandidateV2[];
}

export interface CardGenerateV3AssemblyResult {
  /** 过 `cardPlanV2Schema` 的完整计划（planHash 已算）。 */
  readonly plan: CardPlanV2;
  readonly candidates: LearningCardCandidateRevisionV2[];
  readonly hintsByCandidateRevisionId: Map<string, CardHintPairV2>;
  /** 组装阶段剔除的候选（与草稿级剔除同一留痕形状）。 */
  readonly dropped: ReadonlyArray<{ readonly objectiveLocalId: string; readonly reason: string }>;
}

/**
 * 依据 id → 它所在的块 → 该块里**最可学的那一句**原子。
 *
 * 原子自己不带 evidenceSnapshotId（确定性抽取只认块），所以这一跳必须经 sealed
 * 清单换算块 id，而不是拿字符串去近似匹配句子。一个块可以有多个原子，这里每个块
 * 只留 learnability 最高的一条：`sourceAtomIds` 说的是"这张卡来自这几句"，把整块
 * 的每句都挂上会让"覆盖了多少原子"这类读数虚高。定位不到就返回空集，由调用方剔除。
 */
function atomsForCandidate(
  evidenceRefIds: readonly string[],
  atoms: readonly ExtractedKnowledgeAtom[],
  sealedEvidence: readonly SealedEvidenceEntryV2[],
): string[] {
  const blockIds = new Set(
    sealedEvidence
      .filter((entry) => evidenceRefIds.includes(entry.evidenceSnapshotId))
      .map((entry) => entry.blockId),
  );
  if (blockIds.size === 0) return [];
  const picked: string[] = [];
  for (const blockId of blockIds) {
    const inBlock = atoms.filter((atom) => atom.sourceSectionKeys.includes(blockId));
    if (inBlock.length === 0) continue;
    const best = inBlock.reduce((a, b) => (b.learnabilityBps > a.learnabilityBps ? b : a));
    picked.push(best.atomId);
  }
  return picked;
}

/** 模型给的"零候选理由"折进冻结词表；折不进时按服务端自己的读数说。 */
function noCardReasons(
  modelCodes: readonly string[],
  atomCount: number,
): NoCardReasonCodeV2[] {
  const frozen: readonly string[] = NoCardReasonCodeValuesV2;
  const kept = modelCodes.filter((code) => frozen.includes(code)) as NoCardReasonCodeV2[];
  if (kept.length > 0) return [...new Set(kept)].slice(0, 8);
  return [atomCount === 0 ? "no_learnable_objective" : "no_pedagogically_useful_transformation"];
}

export function assembleCardGenerationV3(
  input: CardGenerateV3AssemblyInput,
): CardGenerateV3AssemblyResult {
  const { generated } = input;
  const dropped: Array<{ objectiveLocalId: string; reason: string }> = [];

  const planBase = (
    result: CardPlanV2["result"],
    atomDecisions: AtomDecisionV2[],
  ) => {
    const base = {
      version: 2 as const,
      planRevisionId: input.planRevisionId,
      runId: input.runId,
      inputSnapshotHash: input.inputSnapshotHash,
      cardContentEpoch: input.cardContentEpoch,
      planVersion: input.planVersion,
      previousPlanRevisionId: input.previousPlanRevisionId,
      result,
      atomDecisions,
    };
    // parse 之后再取 planHash 一致的这一份：合同里的 superRefine（推荐数不超预算）
    // 必须在落库之前说过话，而不是由调用方自己保证。
    return cardPlanV2Schema.parse({ ...base, planHash: computeCardPlanHashV2(base) });
  };

  if (generated.planIntent.kind === "no_cards_recommended") {
    const plan = planBase(
      {
        kind: "no_cards_recommended",
        reasonCodes: noCardReasons(generated.planIntent.reasonCodes, input.atoms.length),
      },
      input.atoms.map((atom) => ({ atomId: atom.atomId, decision: "omit_over_budget" as const })),
    );
    return { plan, candidates: [], hintsByCandidateRevisionId: new Map(), dropped };
  }

  // ① 先定"这一批留下谁"。
  const kept = input.acceptedCandidates.flatMap((draft) => {
    const sourceAtomIds = atomsForCandidate(
      draft.objectiveDraft.evidenceRefIds,
      input.atoms,
      input.sealedEvidence,
    );
    if (sourceAtomIds.length > 0) return [{ draft, sourceAtomIds }];
    dropped.push({
      objectiveLocalId: draft.objectiveLocalId,
      reason: "依据落在没有可学原子的块上，这一版不为其出卡",
    });
    return [];
  });

  // 模型说要出卡、但一张都留不下来：计划仍然要出得来（`author_candidates` 的
  // objectives 是 min(1)，硬塞空数组会让整批发不出去），落成"这一批没有可交出去的
  // 转换"，并把剔除原因带回给调用方——是 `no_cards_recommended` 还是
  // `needs_attention` 由作业层判（刀b），这里不替它决定。
  if (kept.length === 0) {
    const plan = planBase(
      {
        kind: "no_cards_recommended",
        reasonCodes: [
          input.acceptedCandidates.length === 0
            ? "no_learnable_objective"
            : "no_pedagogically_useful_transformation",
        ],
      },
      input.atoms.map((atom) => ({ atomId: atom.atomId, decision: "omit_over_budget" as const })),
    );
    return { plan, candidates: [], hintsByCandidateRevisionId: new Map(), dropped };
  }

  // ② 整批分配：看不到别的卡的那一方不做这个决定。
  const forms = kept.map((entry) => entry.draft.objectiveDraft.knowledgeForm);
  const strategyAllocations = allocateStrategies(forms, input.preferredStrategies);
  const practiceAllocations = allocatePracticeForms(forms);

  // 原子 → 块：候选的依据最终落在**块**上，而判据要比的也是块。
  //
  // 走的不是"原子自己带 blockId"——`ExtractedKnowledgeAtom` **没有**那一列，它带的是
  // `evidenceRefIds`（依据快照 id）。块 id 在 sealed 清单上（`evidenceSnapshotId → blockId`），
  // 所以要经证据换算。**这是第一版写错的地方**：`atom.blockId` 不存在，tsc 立刻报出来，
  // 而如果它存在却指错东西，`tsc` 是不会说的——所以换算这一步照着真实形状写。
  const blockIdByEvidenceSnapshotId = new Map(
    input.sealedEvidence.map((entry) => [entry.evidenceSnapshotId, entry.blockId]),
  );
  const blockIdsForSourceAtoms = (sourceAtomIds: readonly string[]): string[] => {
    const atomById = new Map(input.atoms.map((atom) => [atom.atomId, atom]));
    return [...new Set(sourceAtomIds.flatMap((atomId) => {
      const atom = atomById.get(atomId);
      if (!atom) return [];
      // 块 id 有两条路：`sourceSectionKeys`（确定性抽取器直接带块 id）与
      // `evidenceRefIds` 经 sealed 清单换算（模型抽取那一种）。**先走前者**——
      // `extractAtomsDeterministic` 产出的原子 `evidenceRefIds` 是**空数组**
      // （`planner-service.ts:114`），只走后者会一块都换算不出来，复用就永远不命中。
      // 两条都走：一条空、另一条有值时，块集是它们的并集。
      const fromSections = atom.sourceSectionKeys.filter((key) => key.length > 0);
      const fromEvidence = atom.evidenceRefIds
        .map((snapshotId) => blockIdByEvidenceSnapshotId.get(snapshotId))
        .filter((id): id is string => Boolean(id));
      return [...fromSections, ...fromEvidence];
    }))];
  };

  /**
   * W7-5 刀三：对每一条目标**跑一次判据**。判据是纯函数（`decideObjectiveReuseV2`），
   * 它不知道模型、不知道库里有什么，只看"新候选的块 ∩ 既有目标的块"与形态。
   * 命中就把 `changeContext` 换成复用那一档，并在 `reasonCodes` 里记下判据依据。
   *
   * **为什么不让模型说"这条我见过"**：§4.2「系统无法确定一个主张是否与历史相同
   * 时保留差异，不按标题相似自动继承能力证据」。模型的"我见过"既不可复核也不可
   * 重算；块交集可以。
   */
  const reuseByLocalId = new Map<string, Extract<PlannedObjectiveV2["changeContext"], { kind: "reuse_existing_objective" }>>();
  const reuseCandidates = input.reusableObjectives ?? [];
  if (reuseCandidates.length > 0) {
    for (const entry of kept) {
      const candidateBlockIds = blockIdsForSourceAtoms(entry.sourceAtomIds);
      const decided = decideObjectiveReuseV2({
        candidateBlockIds,
        knowledgeForm: entry.draft.objectiveDraft.knowledgeForm,
        existing: reuseCandidates,
      });
      if (decided.outcome === "reuse") {
        reuseByLocalId.set(entry.draft.objectiveLocalId, {
          kind: "reuse_existing_objective",
          objectiveId: decided.objectiveId,
          basis: decided.basis,
          evidence: {
            candidateBlockIds: decided.evidence.candidateBlockIds as [string, ...string[]],
            sharedBlockIds: decided.evidence.sharedBlockIds as [string, ...string[]],
            knowledgeForm: decided.evidence.knowledgeForm,
          },
        });
      }
    }
  }

  const objectives: PlannedObjectiveV2[] = kept.map((entry, index) => {
    const proposal = generated.objectiveProposals.find(
      (item) => item.objectiveLocalId === entry.draft.objectiveLocalId,
    );
    const reasonCodes = [
      `priority-${proposal?.priority ?? "important"}`,
      `knowledge-form-${entry.draft.objectiveDraft.knowledgeForm}`,
    ];
    if (strategyAllocations[index]?.reasonCode) reasonCodes.push(strategyAllocations[index]!.reasonCode!);
    if (practiceAllocations[index]?.reasonCode) reasonCodes.push(practiceAllocations[index]!.reasonCode!);
    const reuse = reuseByLocalId.get(entry.draft.objectiveLocalId);
    // 复用的理由码要**进 planHash 的闭包**（它在 objective 上），所以"为什么落到
    // 既有目标上"是可复核的，而不是只在内存里存在过。
    if (reuse) reasonCodes.push(`reuse-${reuse.basis}`);
    return {
      objectiveLocalId: entry.draft.objectiveLocalId,
      objectiveStatement: entry.draft.objectiveDraft.objectiveStatement.slice(0, 2000),
      priority: proposal?.priority ?? "important",
      knowledgeForm: entry.draft.objectiveDraft.knowledgeForm,
      strategy: strategyAllocations[index]!.strategy,
      practiceForm: practiceAllocations[index]!.form,
      sourceAtomIds: entry.sourceAtomIds.slice(0, 100),
      reasonCodes: reasonCodes.slice(0, 20),
      estimatedReviewCostSeconds: entry.draft.presentationDraft.estimatedReviewSeconds,
      changeContext: reuse ?? { kind: "create_new" },
    };
  });

  const claimedAtoms = new Set(objectives.flatMap((objective) => objective.sourceAtomIds));
  const plan = planBase(
    {
      kind: "author_candidates",
      recommendedCardCount: objectives.length,
      activationHardMax: input.activationHardMax,
      objectives,
      existingActions: [],
    },
    [
      ...objectives.flatMap((objective) => objective.sourceAtomIds.map((atomId) => (
        objective.changeContext.kind === "reuse_existing_objective"
          // 复用那一条的原子记成"已被既有目标覆盖"——这份决定里"哪个原子去了哪里"
          // 是要能被读出来的（复盘里问过"候选为什么变少"，同一条纪律）。
          ? { atomId, decision: "covered_by_existing_objective" as const, existingLearningObjectiveId: objective.changeContext.objectiveId }
          : { atomId, decision: "create_objective" as const, objectiveLocalId: objective.objectiveLocalId }
      ))),
      ...input.atoms
        .filter((atom) => !claimedAtoms.has(atom.atomId))
        .map((atom) => ({ atomId: atom.atomId, decision: "omit_over_budget" as const })),
    ],
  );

  // ③ 候选：身份与哈希（candidateRevisionHash 的闭包里就有 planHash，所以顺序不能倒）。
  const candidates: LearningCardCandidateRevisionV2[] = [];
  const hintsByCandidateRevisionId = new Map<string, CardHintPairV2>();
  kept.forEach((entry, index) => {
    const built = buildCandidateRevisionV3({
      draft: entry.draft,
      plan,
      runId: input.runId,
      strategy: strategyAllocations[index]!.strategy,
      reasonCodes: objectives[index]!.reasonCodes,
      evidenceSetHash: input.evidenceSetHash,
    });
    candidates.push(built.candidate);
    hintsByCandidateRevisionId.set(built.candidate.candidateRevisionId, built.hints);
  });

  return { plan, candidates, hintsByCandidateRevisionId, dropped };
}

// ── 组装之后的程序校验（依据越界、格式、安全、题面泄题…）──────────────────

export interface CardGenerateV3CandidateGateRejection {
  readonly objectiveLocalId: string;
  readonly codes: string[];
}

export interface CardGenerateV3CandidateGateResult {
  /** 过闸的候选：这批才是能进批量检查、能到用户眼前的。 */
  readonly kept: LearningCardCandidateRevisionV2[];
  readonly rejected: ReadonlyArray<CardGenerateV3CandidateGateRejection>;
  /** soft 信号不拦，但要随审计落盘（V2 主管线同一纪律）。 */
  readonly softCodesByCandidate: Map<string, string[]>;
}

/**
 * 对**组装后**的候选跑一次现成的确定性闸（`buildCandidatePrecheck`，与 V2 主管线
 * 同一份实现、同一组冻结 code）。
 *
 * 依据引用越界就是在这一跳被抓出来的（code `evidence_not_in_sealed_scope`），
 * 所以草稿级校验里不需要再写一遍那条判据。
 */
export function runCardGenerateV3CandidateGates(args: {
  assembled: CardGenerateV3AssemblyResult;
  sourceContent: string;
  evidenceManifest: AssemblerEvidenceManifest;
}): CardGenerateV3CandidateGateResult {
  const kept: LearningCardCandidateRevisionV2[] = [];
  const rejected: CardGenerateV3CandidateGateRejection[] = [];
  const softCodesByCandidate = new Map<string, string[]>();
  for (const candidate of args.assembled.candidates) {
    const { fatalPre, softPre } = buildCandidatePrecheck(
      candidate,
      args.sourceContent,
      args.evidenceManifest,
    );
    if (fatalPre.length > 0) {
      rejected.push({
        objectiveLocalId: candidate.planObjectiveLocalId,
        codes: [...new Set(fatalPre.map((issue) => issue.code))],
      });
      continue;
    }
    kept.push(candidate);
    if (softPre.length > 0) {
      softCodesByCandidate.set(
        candidate.candidateRevisionId,
        [...new Set(softPre.map((issue) => issue.code))],
      );
    }
  }
  return { kept, rejected, softCodesByCandidate };
}
// ── 单张候选的身份与哈希（首稿与增量改写共用这一段）─────────────────────

export interface BuildCandidateRevisionV3Args {
  readonly draft: CardGenerateV3CandidateDraft;
  readonly plan: CardPlanV2;
  readonly runId: string;
  /** 首稿＝整批分配那一份；改写＝**沿用原候选的题型**（改写只改内容，不换形状）。 */
  readonly strategy: CardStrategyV2;
  readonly reasonCodes: readonly string[];
  readonly evidenceSetHash: string;
  /** 有上一版＝增量改写：同 `candidateId`、`revision + 1`、`derivedFrom` 追加一条。 */
  readonly previous?: LearningCardCandidateRevisionV2;
}

/**
 * 草稿 → 可审计的候选修订。
 *
 * 三条不许商量：`rubricHash` 丢弃重算；`practiceItem` 缺省时按答案派生（判分内容
 * 必须进闭包）；改写**不丢原证据闭包**（`evidenceRefIds` 以传入草稿为准，但 rubric
 * 单元里模型漏填的那些沿用上一版——否则"改写题面"会把有效证据悄悄清空，下游必然
 * 被 `no_evidence_reference` 那道硬闸拒掉，这是 V2 修复链踩过的账）。
 */
export function buildCandidateRevisionV3(args: BuildCandidateRevisionV3Args): {
  candidate: LearningCardCandidateRevisionV2;
  hints: CardHintPairV2;
} {
  const { draft, plan, previous } = args;
  const { rubricHash: _modelSuppliedRubricHash, ...rubricWithoutHash } = draft.objectiveDraft.rubric;
  const previousUnits = new Map(
    (previous?.objective.rubric.units ?? []).map((unit) => [unit.rubricUnitId, unit.evidenceRefIds]),
  );
  const objective = draft.objectiveDraft.practiceItem
    ? draft.objectiveDraft
    : {
      ...draft.objectiveDraft,
      practiceItem: derivePracticeItemFromCanonicalAnswer(draft.objectiveDraft.canonicalAnswer),
    };
  const mergedRubric: Omit<ObjectiveRubricV2, "rubricHash"> = {
    version: rubricWithoutHash.version,
    passingPolicy: rubricWithoutHash.passingPolicy,
    units: rubricWithoutHash.units.map((unit) => ({
      ...unit,
      // 模型在改写时漏填依据的那几格沿用上一版——"改写题面"不许把有效证据清空。
      evidenceRefIds: unit.evidenceRefIds.length > 0
        ? unit.evidenceRefIds
        : (previousUnits.get(unit.rubricUnitId) ?? unit.evidenceRefIds),
    })),
  };
  const rubric: ObjectiveRubricV2 = { ...mergedRubric, rubricHash: computeRubricHashV2(mergedRubric) };
  const candidateWithoutHash: Omit<LearningCardCandidateRevisionV2, "candidateRevisionHash"> = {
    version: 2,
    candidateRevisionId: randomUUID(),
    candidateId: previous?.candidateId ?? randomUUID(),
    revision: (previous?.revision ?? 0) + 1,
    runId: args.runId,
    planRevisionId: plan.planRevisionId,
    planVersion: plan.planVersion,
    planHash: plan.planHash,
    cardContentEpoch: plan.cardContentEpoch,
    planObjectiveLocalId: draft.objectiveLocalId,
    recommendation: { recommended: true, reasonCodes: [...args.reasonCodes] },
    derivedFromCandidateRevisions: previous
      ? [...previous.derivedFromCandidateRevisions, {
        candidateRevisionId: previous.candidateRevisionId,
        candidateId: previous.candidateId,
        revision: previous.revision,
        revisionHash: previous.candidateRevisionHash,
      }]
      : [],
    objective: { ...objective, rubric },
    presentation: { ...draft.presentationDraft, strategy: args.strategy },
    evidenceSetHash: args.evidenceSetHash,
  };
  return {
    candidate: {
      ...candidateWithoutHash,
      candidateRevisionHash: computeCandidateRevisionHashV2(candidateWithoutHash),
    },
    hints: draft.hints,
  };
}
