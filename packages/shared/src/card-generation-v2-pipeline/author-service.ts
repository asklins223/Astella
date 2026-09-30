/**
 * 方案 20 C2：Candidate Author（§11）。
 *
 * 职责（§11.1–11.6）：
 * - 从 PlannedObjective 生成 CardV2 草案（objective + presentation + rubric + evidence）；
 * - 遵守 CardPlan 冻结的 budget（不扩预算、不增卡数）；
 * - 输出 LearningCardCandidateRevisionV2（含 candidateRevisionHash）。
 *
 * 硬约束：
 * - Author 无 publish 权；
 * - 内部备选不是用户可见 Candidate；
 * - 不得用扩大 proposal 数量提高最终卡数；
 * - 不得为了 coverage 把每个 Atom 各生成一张。
 *
 * 本模块由 worker V2 handler 驱动，模型调用由调用方注入。
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：本文件自 apps/api/src/modules/card-generation-v2/
 * 下沉至 packages/shared（纯逻辑、无 DB/provider 依赖）。worker 与 api 作为平级
 * 消费者经 @ailearn/shared/card-generation-v2-pipeline 子路径引用，消除 worker
 * 该模块是 card-generation-v2 pipeline 的 canonical authoring 实现。
 */

import type {
  CardPlanV2,
  LearningObjectiveDraftV2,
  CardPresentationDraftV2,
  ObjectiveRubricV2,
  CanonicalAnswerV2,
  PlannedObjectiveV2,
  KnowledgeFormV2,
  CardStrategyV2,
  CardHintPairV2,
  TeachingTransformationV2,
} from "../contracts/card-generation-v2-contracts.ts";
import {
  computeRubricHashV2,
} from "../card-generation-v2-hashing.ts";
import { hashCanonicalV2 } from "../hash-canonical-v2.ts";
import { deriveConceptLabel } from "./concept-label.ts";
import { taskIntentsForStrategy } from "./planner-service.ts";

// ─── Authoring Provider 接口 ─────────────────────────────────────────────

/**
 * 模型调用接口：调用方注入实际的 LLM 调用。
 * 本模块不直接调用 provider。
 */
export interface AuthoringProvider {
  /**
   * 为单个 PlannedObjective 生成 objective draft + presentation draft。
   * 返回的结构化内容必须经 zod strict parse。
   */
  authorCandidate(input: AuthoringProviderInput): Promise<AuthoringProviderOutput>;
}

export interface AuthoringProviderInput {
  planObjective: PlannedObjectiveV2;
  sourceContent: string;
  semanticSpecHash: string;
  planHash: string;
  /** R26：sealed evidence 清单（ID + quote hash），供 Author 引用（evidenceRefIds）。 */
  evidenceList?: Array<{ evidenceSnapshotId: string; quoteHash?: string | null }>;
  /**
   * M2（2026-09-15 管线评审）：调用方基于 sealed manifest 计算的 evidenceSetHash。
   *
   * 该值是 candidateRevisionHash 的闭包输入之一。provider 必须原样回传（不得
   * 自行编造），否则 revision hash 会用错误的 evidenceSetHash 计算，与下游
   * 独立重算的值永久不一致（审计/跨服务校验必然 mismatch）。
   */
  evidenceSetHash?: string;
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。 */
  signal?: AbortSignal;
}

export interface AuthoringProviderOutput {
  objective: LearningObjectiveDraftV2;
  presentation: CardPresentationDraftV2;
  evidenceSetHash: string;
  /**
   * 两级提示。**不是** objective/presentation 的一部分：候选修订哈希
   * （computeCandidateRevisionHashV2）对整对象取哈希，塞进那两个草稿里就等于
   * 把提示并入判分内容的审计链。提示按候选行的兄弟列独立存放。
   */
  hints: CardHintPairV2;
}

// ─── 出卡预算（一处收敛）──────────────────────────────────────────────────

/**
 * 一次生成**实际该出几张卡**的预算，从计划结果里取，两处消费者共用同一份。
 *
 * 事故记录（2026-09-17）：planner 的目标池在被客户端 hardMaxCards 或服务端上限
 * 截断之前可以先更长，于是出卡数超过 `activationHardMax`，deck gate 以
 * `count_out_of_plan` **硬失败整条 run**——内容全部通过门禁，却一张都交付不了。
 * 修法就是把"预算内"这一步收进一处，被截断的原子由 planner 记 `omit_over_budget`。
 */
export function budgetedPlanObjectives(plan: Pick<CardPlanV2, "result">): PlannedObjectiveV2[] {
  if (plan.result.kind !== "author_candidates") return [];
  const budget = Math.max(0, plan.result.activationHardMax);
  return plan.result.objectives.slice(0, budget);
}

export class DeterministicAuthoringProvider implements AuthoringProvider {
  async authorCandidate(input: AuthoringProviderInput): Promise<AuthoringProviderOutput> {
    const { planObjective, sourceContent } = input;

    // Build canonical answer from source
    const canonicalAnswer: CanonicalAnswerV2 = {
      kind: "text",
      unit: {
        unitId: `ans-${planObjective.objectiveLocalId}`,
        text: sourceContent.slice(0, 4000),
      },
    };

    // Build rubric
    const rubricWithoutHash: Omit<ObjectiveRubricV2, "rubricHash"> = {
      version: 2,
      units: [{
        rubricUnitId: `rubric-${planObjective.objectiveLocalId}`,
        facet: "recall",
        criterion: `能正确回答：${planObjective.objectiveStatement}`,
        required: true,
        answerUnitIds: [`ans-${planObjective.objectiveLocalId}`],
        evidenceRefIds: [],
      }],
      passingPolicy: {
        requireAllRequiredUnits: true,
        allowContradiction: false,
      },
    };
    const rubricHash = computeRubricHashV2(rubricWithoutHash);
    const rubric: ObjectiveRubricV2 = { ...rubricWithoutHash, rubricHash };

    // Build objective draft
    // 确定性 fallback 没有模型做「教学转换」，正面/摘要只能从目标陈述派生；
    // 而陈述本身就是答案（canonicalAnswer 由同一命题派生）。整句贴进正面或
    // 摘要会产出「题面即答案」的卡（2026-09-18 复盘：库中 34 张已发布卡均此
    // 形态）。因此这里只保留派生概念标题，句子本体留给 canonicalAnswer 与
    // 验证 rubric —— 概念标签足够定位一张卡，又不把答案送到读者眼前。
    const conceptLabel = deriveConceptLabel({
      objectiveStatement: planObjective.objectiveStatement,
    }) || "未命名知识点";
    const objective: LearningObjectiveDraftV2 = {
      objectiveStatement: planObjective.objectiveStatement,
      publicSummary: conceptLabel,
      conceptLabel,
      knowledgeForm: planObjective.knowledgeForm,
      preferredTaskIntents: [...taskIntentsForStrategy(planObjective.strategy)],
      canonicalAnswer,
      learningSupport: {
        explanation: sourceContent.slice(0, 6000),
      },
      rubric,
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: [],
    };

    // Build presentation
    // 题型来自 planner 的整批分配（`planObjective.strategy`），此处不再自行推导——
    // 此前每次都由 knowledgeForm 现推，用户在生成设置里勾的题型因此对产出毫无影响。
    const strategy = planObjective.strategy;
    const transformationKind = mapKnowledgeFormToTransformation(planObjective.knowledgeForm);
    const presentation: CardPresentationDraftV2 = {
      strategy,
      transformationKind,
      front: {
        cue: conceptLabel,
        prompt: deterministicFrontPrompt(strategy, conceptLabel),
      },
      estimatedReviewSeconds: planObjective.estimatedReviewCostSeconds,
    };

    const evidenceSetHash = hashCanonicalV2("evidence-set-v2", { source: sourceContent.slice(0, 500) });

    return {
      objective,
      presentation,
      evidenceSetHash,
      hints: fallbackCardHints({
        conceptLabel,
        knowledgeForm: planObjective.knowledgeForm,
        strategy,
        answerUnitCount: countAnswerUnits(canonicalAnswer),
      }),
    };
  }
}

/**
 * 答案单元数——提示用它描述"答案由几块构成"，不取任何单元文本。
 *
 * 导出给 worker 复用：模型漏交提示时也要用同一套派生规则兜底，两处不能各写一份。
 */
export function countAnswerUnits(answer: CanonicalAnswerV2): number {
  switch (answer.kind) {
    case "text": return 1;
    case "bullets": return answer.items.length;
    case "ordered_steps": return answer.steps.length;
    case "mapping": return answer.pairs.length;
    case "comparison": return answer.rows.length;
    case "formula": return 1;
    case "code": return 1;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export function fallbackCardHints(input: {
  conceptLabel: string;
  knowledgeForm: KnowledgeFormV2;
  strategy: CardStrategyV2;
  answerUnitCount: number;
}): CardHintPairV2 {
  const { conceptLabel, knowledgeForm, strategy, answerUnitCount } = input;
  const shape: Record<KnowledgeFormV2, string> = {
    fact: "这一条是一个具体事实",
    definition: "这一条是一个定义：被定义项、它属于什么类、以及它的区别特征",
    relationship: "这一条讲的是两个东西之间的关系，不是各自的定义",
    comparison: "这一条要同时说出两侧，以及它们在哪里分开",
    sequence: "这一条有先后顺序，顺序本身就是要记住的东西",
    procedure: "这一条是一套步骤，逐步都要对上",
    causal_model: "这一条讲的是原因如何导致结果，不是结论本身",
    boundary: "这一条讲的是适用条件，以及在什么条件下失效",
    application_rule: "这一条要落到一个具体场景里才说得清",
  };
  const structural = answerUnitCount > 1
    ? `答案由 ${answerUnitCount} 个部分构成，先想清楚它们各自管什么。`
    : "答案是一个整体，先试着说出它的主干，再补限定。";
  return {
    level1: `${shape[knowledgeForm]}。${structural}`,
    level2: strategy === "cloze"
      ? `被遮住的那一处正是判分要点：回到「${conceptLabel}」这句话，看它缺的是主体、结论还是数值。`
      : `先从「${conceptLabel}」里挑一个侧面开口，说错也没关系，评分只看必答要点。`,
  };
}

/**
 * 确定性兜底的题面措辞。真实的教学转换（挖空、构造对照表、设计反例）需要模型，
 * 兜底路径只能保证**题面按分配到的题型提问**，而不是所有卡都问同一句"请回忆并说明"。
 */
function deterministicFrontPrompt(strategy: CardStrategyV2, conceptLabel: string): string {
  const prompts: Record<CardStrategyV2, string> = {
    recall: `请回忆并说明「${conceptLabel}」的关键内容`,
    cloze: `「${conceptLabel}」中缺掉的关键表述是什么？请补全`,
    compare: `请对比「${conceptLabel}」与它最容易被混淆的对象，说出差别在哪里`,
    sequence: `请按顺序说出「${conceptLabel}」的各个步骤，并指出顺序不能换的原因`,
    why: `请解释「${conceptLabel}」成立的原因，而不是复述结论`,
    boundary: `「${conceptLabel}」在什么情况下不成立？请给出边界`,
    application: `给出一个「${conceptLabel}」的具体应用场景，并说明怎么用`,
  };
  return prompts[strategy];
}

function mapKnowledgeFormToTransformation(form: KnowledgeFormV2): TeachingTransformationV2 {
  const map: Record<KnowledgeFormV2, TeachingTransformationV2> = {
    fact: "retrieval_definition",
    definition: "retrieval_definition",
    relationship: "structured_comparison",
    comparison: "structured_comparison",
    sequence: "procedure_reconstruction",
    procedure: "procedure_reconstruction",
    causal_model: "mechanism_reconstruction",
    boundary: "boundary_discrimination",
    application_rule: "source_grounded_application",
  };
  return map[form] ?? "retrieval_definition";
}

// ─── Errors ──────────────────────────────────────────────────────────────

