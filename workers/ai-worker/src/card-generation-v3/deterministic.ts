/**
 * 简化链（V3）的**确定性 provider**（39d W7-1 刀a；设计件 §2"确定性 provider 先行"）。
 *
 * 它与真模型那一份实现**同一个端口**（`CardGenerationV3ProviderPort`），交回的也是
 * 同一份合同要过的 JSON 文本——所以走的是同一段 execute、同一次合同解析、同一份
 * 程序校验。这不是"测试走的捷径"，而是生产在 `CARD_GENERATION_V2_LLM` 关掉时的
 * 那一版（与 V2 主管线同一档选择）。
 *
 * 它只做"材料里看得见的事"：
 * - 目标＝确定性原子抽取里最可学的那几句（`extractAtomsDeterministic`，零模型调用）；
 * - 卡体＝`DeterministicAuthoringProvider` 的派生形状（概念标题当正面，答案句留在
 *   canonicalAnswer——整句贴正面会产出"题面即答案"的卡，那是 2026-09-18 复盘的账）；
 * - 依据＝该原子所在块在 sealed manifest 里的依据 id。**挂不上依据的原子不出卡**，
 *   没有依据的卡在这一版里根本不该存在（合同也要求 `evidenceRefIds` 至少一条）；
 * - 一批原子都没有 ⇒ `no_cards_recommended`，这是正常结果不是失败。
 *
 * 内容检查那一份同理：确定性结论只有 grounding 这一维（依据在不在范围内），
 * 它把 `criticVersion: "deterministic-grounding-v1"` 原样带在报告里，**不装作做过
 * 语义判断**——真模型那一刀换的是这个文件里的两个函数，外壳与判据不动。
 */
const FACET_BY_KNOWLEDGE_FORM_V3: Record<string, "recall" | "paraphrase" | "explain" | "example" | "apply" | "boundary" | "procedure" | "relate" | "repair"> = {
  fact: "recall",
  definition: "paraphrase",
  relationship: "relate",
  comparison: "relate",
  sequence: "procedure",
  procedure: "procedure",
  causal_model: "explain",
  boundary: "boundary",
  application_rule: "apply",
};

import {
  DeterministicAuthoringProvider,
  allocateStrategies,
  extractAtomsDeterministic,
  runDeterministicGroundingContract,
  type SourceBlockInput,
} from "@astella/shared/card-generation-v2-pipeline";
import { contentFromObjectiveDraftV3 } from "./expand-content.ts";
import type { PlannedObjectiveV2 } from "@astella/shared/card-generation-v2-contracts";
import type {
  CardGenerateV3ObjectiveProposal,
  CardGenerateV3CandidateContent,
} from "@astella/shared/card-generation-v3-contracts";
import type {
  CardCandidateRewriteV3TaskInput,
  CardContentCheckV3TaskInput,
  CardGenerateV3TaskInput,
  CardGenerationV3ProviderPort,
} from "./tasks.ts";

const DETERMINISTIC_MODEL_ID = "deterministic-card-generation-v3";

function toSourceBlocks(
  input: CardGenerateV3TaskInput,
): SourceBlockInput[] {
  return input.noteBlocks.map((block) => ({
    blockId: block.blockId,
    type: "text",
    content: block.text,
    ordinal: block.ordinal,
  }));
}

/** 一次语义调用都不花的生成回答：从正文原子拼出草稿。 */
export function createDeterministicCardGenerateV3Provider(): CardGenerationV3ProviderPort<CardGenerateV3TaskInput> {
  const author = new DeterministicAuthoringProvider();
  return {
    modelId: DETERMINISTIC_MODEL_ID,
    async complete({ input }) {
      const blocks = toSourceBlocks(input);
      const sourceContent = blocks.map((block) => block.content).join("\n\n");
      const atoms = extractAtomsDeterministic(blocks);
      const usable = atoms
        .map((atom) => ({
          atom,
          evidenceRefIds: input.evidence
            .filter((entry) => atom.sourceSectionKeys.includes(entry.blockId))
            .map((entry) => entry.evidenceSnapshotId),
        }))
        .filter((entry) => entry.evidenceRefIds.length > 0)
        .sort((a, b) => (
          b.atom.learnabilityBps * b.atom.importanceBps
          - a.atom.learnabilityBps * a.atom.importanceBps
        ))
        .slice(0, input.activationHardMax);

      if (usable.length === 0) {
        return {
          text: JSON.stringify({
            planIntent: {
              kind: "no_cards_recommended",
              reasonCodes: atoms.length === 0 ? ["no_learnable_objective"] : ["insufficient_reliable_evidence"],
            },
            objectiveProposals: [],
            candidates: [],
          }),
        };
      }

      // 题型整批分配在这里也走一遍——决定题型的是批次，不是逐张出题的那一方。
      const allocations = allocateStrategies(usable.map((entry) => entry.atom.knowledgeFormHint));
      const candidates: CardGenerateV3CandidateContent[] = [];
      const proposals: CardGenerateV3ObjectiveProposal[] = [];

      for (const [index, entry] of usable.entries()) {
        const objectiveLocalId = `obj-${index + 1}`;
        const strategy = allocations[index]!.strategy;
        const planObjective: PlannedObjectiveV2 = {
          objectiveLocalId,
          objectiveStatement: entry.atom.proposition.slice(0, 2000),
          priority: index === 0 ? "critical" : index < 3 ? "important" : "optional",
          knowledgeForm: entry.atom.knowledgeFormHint,
          strategy,
          practiceForm: null,
          sourceAtomIds: [entry.atom.atomId],
          reasonCodes: [
            `learnability-${entry.atom.learnabilityBps}`,
            `importance-${entry.atom.importanceBps}`,
          ],
          estimatedReviewCostSeconds: Math.min(300, Math.max(30, entry.atom.proposition.length)),
          changeContext: { kind: "create_new" },
        };
        // 确定性这一版也只交**内容**（模型那一份小形状）：脚手架由
        // `expandCardGenerateV3ContentV3` 搭，两条路共用同一个端口、同一份展开。
        // 题面与两级提示仍取自离线作者——它那两句是**不泄答案**的（闸门判
        // `front_leaks_answer`／`cue_is_claim_copy`，第一版我拿目标陈述当 cue，整批被拦）。
        const drafted = await author.authorCandidate({
          planObjective,
          sourceContent,
          semanticSpecHash: input.inputSnapshotHash,
          planHash: input.inputSnapshotHash,
          evidenceList: entry.evidenceRefIds.map((evidenceSnapshotId) => ({ evidenceSnapshotId })),
          evidenceSetHash: input.inputSnapshotHash,
        });
        const proposition = entry.atom.proposition;
        candidates.push({
          objectiveLocalId,
          conceptLabel: planObjective.objectiveStatement.slice(0, 200),
          publicSummary: planObjective.objectiveStatement.slice(0, 1500),
          answerForm: "prose",
          answerParts: [{ text: proposition.slice(0, 4000) }],
          judgingPoints: [{
            facet: FACET_BY_KNOWLEDGE_FORM_V3[entry.atom.knowledgeFormHint] ?? "recall",
            criterion: `说出这一句的关键点：${proposition.slice(0, 200)}`,
            required: true,
            partIndexes: [1],
          }],
          explanation: proposition.slice(0, 6000),
          front: drafted.presentation.front,
          hints: drafted.hints,
          estimatedReviewSeconds: planObjective.estimatedReviewCostSeconds,
          evidenceSnapshotIds: entry.evidenceRefIds,
        });
        proposals.push({
          objectiveLocalId,
          objectiveStatement: planObjective.objectiveStatement,
          priority: planObjective.priority,
          knowledgeForm: planObjective.knowledgeForm,
          rationale: `这一句的可学与重要读数：${planObjective.reasonCodes.join("，")}`,
        });
      }

      return {
        text: JSON.stringify({
          planIntent: { kind: "author_candidates", recommendedCardCount: candidates.length },
          objectiveProposals: proposals,
          candidates,
        }),
      };
    },
  };
}

/** 批量内容检查的确定性回答：只有 grounding 这一维，按依据范围判。 */
export function createDeterministicCardContentCheckV3Provider(): CardGenerationV3ProviderPort<CardContentCheckV3TaskInput> {
  return {
    modelId: DETERMINISTIC_MODEL_ID,
    async complete({ input }) {
      const perCandidate = [];
      for (const entry of input.candidates) {
        const report = await runDeterministicGroundingContract(entry.candidate, input.evidenceManifest);
        // 只交裁决与原因：grounding 报告那一层由**任务侧**按同一份确定性合同现算
        // （模型与离线两条路都不手写它的脚手架）。
        perCandidate.push({
          objectiveLocalId: entry.objectiveLocalId,
          verdict: report.verdict === "pass" ? "keep" : "insufficient",
          issues: [],
        });
      }
      return { text: JSON.stringify({ perCandidate, setIssues: [] }) };
    },
  };
}

/**
 * 改写的确定性那一版：**它不会改写内容**，只把原稿交回去。
 *
 * 这不是偷懒，是把"离线这一档没有语义判断能力"这件事摆明——交回原稿之后重检会给出
 * 同一档结论，那张候选就停在 `authored`（审核页看不见它，也不算通过）。真模型那一版
 * 换的就是这个函数：外壳、身份重算、只重检受影响候选的那些判据都不动。
 */
export function createDeterministicCardCandidateRewriteV3Provider(): CardGenerationV3ProviderPort<CardCandidateRewriteV3TaskInput> {
  return {
    modelId: DETERMINISTIC_MODEL_ID,
    async complete({ input }) {
      return {
        // 走反向映射交回**内容**：同一个端口两条路说同一句话（重形状只在服务端内部流动）。
        text: JSON.stringify({
          rewrites: [contentFromObjectiveDraftV3({
            objectiveLocalId: input.candidate.planObjectiveLocalId,
            draft: input.candidate.objective,
            presentation: input.candidate.presentation,
            hints: input.hints,
          })],
        }),
      };
    },
  };
}
