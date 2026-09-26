/**
 * 制卡简化链（V3）的**模型输出合同**（39d W7-1；39c §6.1–6.2、39 §8.6）。
 *
 * 改前的事实（W3-2 拆完漏斗后仍成立的形状）：一条 run 的默认路径要过
 * Planner → 逐候选 Author → Grounding Critic → Pedagogy Critic 四段语义调用，
 * 外加有界修复与投机 pedagogy。W7-1 把默认路径压成**两次语义调用**：
 *
 *   ① `card_generate_v3`：同一次结构化生成里**选目标并形成少量候选**
 *      （39 §8.6 第 1 步原话："直接制卡时在同一次生成中选择目标并形成少量候选，
 *      不固定多加一个 Planner 调用"）；
 *   ② `card_content_check_v3`：一次独立批量内容检查，逐候选给出
 *      可保留 / 需修改 / 依据不足 的裁决（39c §6.2），不强制拆成两个 Critic。
 *
 * 服务端保留的职责（模型说了不算的三件）：
 *   - **strategy / practiceForm 整批分配**：card-generation-v2-contracts.ts:404-414
 *     的教训原样生效——题型配额是整批层面的决定，模型逐张自选会整批同型。
 *     所以本合同的生成输出只带**提案**（无 strategy 字段），落库前由服务端分配。
 *   - 哈希与身份：planHash / candidateRevisionHash / evidenceSetHash 全部服务端
 *     计算（computeCardPlanHashV2 / computeCandidateRevisionHashV2 /
 *     computeCandidateEvidenceSetHashV2）——模型产物只是草稿。
 *   - 程序校验：引用存在、必需字段、版本、明确重复（buildCandidatePrecheck /
 *     runCandidateDeterministicGatesV2 复用，不另写第二份）。
 *
 * 零候选是正常结果（39 §8.6）：`planResult.kind = "no_cards_recommended"`
 * 且 `candidates` 为空数组，不是失败。
 */
import { z } from "zod";
import {
  cardHintPairV2Schema,
  cardPresentationDraftV2Schema,
  knowledgeFormV2Schema,
  learningObjectiveDraftV2Schema,
} from "./card-generation-v2-contracts.ts";
import { groundingCriticReportV2Schema } from "./card-quality-v2-contracts.ts";

// ─── ① 生成任务（card_generate_v3）──────────────────────────────────────

/**
 * 单次生成里对"要立哪些目标"的**提案**。没有 strategy / practiceForm 强制档：
 * 那两件由服务端在整批上分配（见文件头），模型给的是内容与建议。
 */
export const cardGenerateV3ObjectiveProposalSchema = z.strictObject({
  objectiveLocalId: z.string().min(1).max(160),
  objectiveStatement: z.string().min(1).max(2000),
  priority: z.enum(["critical", "important", "optional"]),
  knowledgeForm: knowledgeFormV2Schema,
  /** 模型的题型建议；服务端分配 strategy 时可参考可覆盖。 */
  practiceFormSuggestion: z.string().min(1).max(60).optional(),
  /** 一句"为什么值得记"（39 §8.3 候选展示要求），进候选的推荐理由码。 */
  rationale: z.string().min(1).max(500),
});
export type CardGenerateV3ObjectiveProposal = z.infer<
  typeof cardGenerateV3ObjectiveProposalSchema
>;

/** 生成任务的一条候选草稿：内容齐全，但所有哈希与身份由服务端计算。 */
export const cardGenerateV3CandidateDraftSchema = z.strictObject({
  /** 必须指向上面的 objectiveProposals 之一（superRefine 钉）。 */
  objectiveLocalId: z.string().min(1).max(160),
  objectiveDraft: learningObjectiveDraftV2Schema,
  presentationDraft: cardPresentationDraftV2Schema,
  hints: cardHintPairV2Schema,
});
export type CardGenerateV3CandidateDraft = z.infer<
  typeof cardGenerateV3CandidateDraftSchema
>;

/**
 * 模型给的**计划意图**是轻量的：strategy / practiceForm / sourceAtomIds /
 * changeContext 这些 planner 级字段全部由服务端在落库前组装
 * （strategy 整批分配的教训见 card-generation-v2-contracts.ts:404-414；
 * sourceAtomIds 引用确定性原子抽取的产出——零模型调用）。所以这里
 * **不复用** `cardPlanResultV2Schema`：那份形状的重字段不是模型该交的东西。
 */
export const cardGenerateV3PlanIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("author_candidates"),
    recommendedCardCount: z.number().int().min(1).max(8),
  }),
  z.strictObject({
    kind: z.literal("no_cards_recommended"),
    reasonCodes: z.array(z.string().min(1).max(120)).min(1).max(8),
  }),
]);
export type CardGenerateV3PlanIntent = z.infer<typeof cardGenerateV3PlanIntentSchema>;

export const cardGenerateV3OutputSchema = z
  .strictObject({
    planIntent: cardGenerateV3PlanIntentSchema,
    objectiveProposals: z
      .array(cardGenerateV3ObjectiveProposalSchema)
      .max(12),
    candidates: z.array(cardGenerateV3CandidateDraftSchema).max(8),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.planIntent.kind !== "author_candidates") {
      if (output.candidates.length > 0 || output.objectiveProposals.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "no_cards_recommended must not carry candidates or objective proposals",
          path: ["candidates"],
        });
      }
      return;
    }
    const proposed = new Set(output.objectiveProposals.map((o) => o.objectiveLocalId));
    output.candidates.forEach((candidate, index) => {
      if (!proposed.has(candidate.objectiveLocalId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidate ${index} references unknown objectiveLocalId ${candidate.objectiveLocalId}`,
          path: ["candidates", index, "objectiveLocalId"],
        });
      }
    });
  });
export type CardGenerateV3Output = z.infer<typeof cardGenerateV3OutputSchema>;

// ─── ② 内容检查任务（card_content_check_v3）──────────────────────────────// ─── ③ 增量改写（card_candidate_rewrite_v3，刀c）────────────────────────

/**
 * 改写任务交回的仍然是**同一种草稿**（39c §6.1："改写走增量"）：形状不新造一份，
 * 服务端组装走的也是 `plan-assembly.ts` 里那同一段。
 *
 * 一条 run 的默认路径仍然只有两次语义调用（生成＋批量检查）；`rewrite` 每命中一张
 * 就多一发改写＋一次只针对这些候选的重检——那是要**如实计入**调用数的（§16.28：
 * "结构修复与网络重试如实计入，不隐藏调用"），而不是再开一轮"修复—再检查"循环。
 */
export const cardCandidateRewriteV3OutputSchema = z.strictObject({
  rewrites: z.array(cardGenerateV3CandidateDraftSchema).min(1).max(8),
});
export type CardCandidateRewriteV3Output = z.infer<
  typeof cardCandidateRewriteV3OutputSchema
>;


/**
 * 逐候选裁决（39c §6.2 的三档）。`rewrite` 走增量改写（只重做受影响候选）；
 * `insufficient` 是确定性结论（依据不足/实质疑点），不是服务故障。
 */
export const cardContentCheckV3VerdictSchema = z.enum([
  "keep",
  "rewrite",
  "insufficient",
]);
export type CardContentCheckV3Verdict = z.infer<typeof cardContentCheckV3VerdictSchema>;

/**
 * 逐候选的检查结论。`grounding` 带 **grounding 级**的依据支持报告：
 * 审核页的"可保留"门槛要求候选带 binding plan hash，而 binding plan 的组装
 * 消费的是 grounding 合同——简化链把它合并进这一次批量检查的输出里，
 * 不再单独跑一遍 Grounding Critic。
 */
export const cardContentCheckV3EntrySchema = z.strictObject({
  objectiveLocalId: z.string().min(1).max(160),
  verdict: cardContentCheckV3VerdictSchema,
  /** 39c §6.2："有问题的候选单独显示原因"；措辞类是建议不升级整批失败。 */
  issues: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(120),
        severity: z.enum(["hard", "soft"]),
        detail: z.string().min(1).max(2000),
      }),
    )
    .max(40),
  grounding: groundingCriticReportV2Schema,
});

export const cardContentCheckV3OutputSchema = z
  .strictObject({
    perCandidate: z.array(cardContentCheckV3EntrySchema).max(8),
    /** 整批层面的问题（如语义重复簇）；逐候选问题在各自条目里。 */
    setIssues: z
      .array(
        z.strictObject({
          code: z.string().min(1).max(120),
          detail: z.string().min(1).max(2000),
        }),
      )
      .max(20),
  })
  .strict();
export type CardContentCheckV3Output = z.infer<typeof cardContentCheckV3OutputSchema>;
