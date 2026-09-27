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
import { taskIntentSchema } from "./learning-run-contracts.ts";

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

/** 一行的答案片段：`label` 只在 pairs 那一支用得上（左边）。 */
export const cardGenerateV3AnswerPartSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  label: z.string().min(1).max(300).optional(),
});

/**
 * **模型真正被要求交的那一份**（39d W7-1 附刀七：模型只交内容，V2 形状由服务端展开）。
 *
 * 三条边界都是六发真模型换来的：不交 id／`*Hash`／`relations`（那是脚手架，也是模型必然
 * 出错的地方）；不选七支判别式（`answerForm` 只留四种产出型，comparison/formula/code
 * 由服务端按内容展开）；判分点只指"第几个答案片段"（1 起），不指 unit id——引用由服务端
 * 重指，模型永远看不见自己起的名字会不会悬空。
 */
export const cardGenerateV3CandidateContentSchema = z.strictObject({
  objectiveLocalId: z.string().min(1).max(160),
  /** 概念级标题（名词短语，不是 cue／prompt／整句命题）。 */
  conceptLabel: z.string().min(1).max(200),
  publicSummary: z.string().min(1).max(1500),
  answerForm: z.enum(["prose", "bullets", "steps", "pairs"]),
  answerParts: z.array(cardGenerateV3AnswerPartSchema).min(1).max(40),
  judgingPoints: z
    .array(
      z.strictObject({
        facet: taskIntentSchema,
        criterion: z.string().min(1).max(2000),
        required: z.boolean(),
        /**
         * 答案片段序号，**1 起**（服务端换成 `au-*`）。允许 0：第七发真模型就是写了 0 起的
         * 序号被 `too_small` 整批拒掉——序号约定不该是整批红的原因，展开器会按"含 0 且不
         * 含越界值"判出 0 起写法并整体 +1（见 `normalizePartIndexesV3`）。
         */
        partIndexes: z.array(z.number().int().min(0).max(40)).min(1).max(40),
      }),
    )
    .min(1).max(40),
  explanation: z.string().min(1).max(6000),
  boundary: z.string().min(1).max(3000).optional(),
  misconception: z.string().min(1).max(3000).optional(),
  workedExample: z.string().min(1).max(6000).optional(),
  front: z.strictObject({
    cue: z.string().min(1).max(2000),
    prompt: z.string().min(1).max(2000),
    context: z.string().min(1).max(3000).optional(),
  }),
  hints: cardHintPairV2Schema,
  estimatedReviewSeconds: z.number().int().min(1).max(3600),
  /** 只能取提示里「可用依据」列出的那些 id（服务端仍会按 sealed 清单复检）。 */
  evidenceSnapshotIds: z.array(z.string().uuid()).min(1).max(100),
});
export type CardGenerateV3CandidateContent = z.infer<
  typeof cardGenerateV3CandidateContentSchema
>;

/** 生成任务的一条候选草稿（**服务端内部形状**，展开之后的产物）。 */
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
    candidates: z.array(cardGenerateV3CandidateContentSchema).max(8),
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

/**
 * **服务端内部形状**（脚手架搭好之后）的同一份输出：模型交上面那份内容，
 * `expandCardGenerateV3OutputV3` 搭成这一份；下游（草稿级程序校验、组装、落库、审核页）
 * 读的一直是它——V2 的候选表与 binding plan 吃的就是 `learningObjectiveDraftV2`。
 */
/**
 * **逐候选宽进**的信封（运行时走这一份）：计划意图与提案仍严格校验，`candidates` 先收
 * `unknown[]`，由展开器逐条按 `cardGenerateV3CandidateContentSchema` 解析——**一条候选少给
 * 一格不该让整批红**（第八发真模型就是少了个 `front.cue` 把整批判成 `output_shape`）。
 * 剔掉的候选要**带原文原因**记账，不是静默丢。
 */
export const cardGenerateV3OutputEnvelopeSchema = z
  .strictObject({
    planIntent: cardGenerateV3PlanIntentSchema,
    objectiveProposals: z.array(cardGenerateV3ObjectiveProposalSchema).max(12),
    candidates: z.array(z.unknown()).max(8),
  })
  .superRefine((output, ctx) => {
    // 计划意图与提案**这一层仍然严格**（那是"零候选是正常结果"那条纪律的一部分）；
    // 宽进只放宽到"每条候选自己的内容"。
    if (output.planIntent.kind !== "author_candidates"
      && (output.candidates.length > 0 || output.objectiveProposals.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "no_cards_recommended must not carry candidates or objective proposals",
        path: ["candidates"],
      });
    }
  });
export type CardGenerateV3OutputEnvelope = z.infer<typeof cardGenerateV3OutputEnvelopeSchema>;

export const cardGenerateV3DraftOutputSchema = z.strictObject({
  planIntent: cardGenerateV3PlanIntentSchema,
  objectiveProposals: z.array(cardGenerateV3ObjectiveProposalSchema).max(12),
  candidates: z.array(cardGenerateV3CandidateDraftSchema).max(8),
});
export type CardGenerateV3DraftOutput = z.infer<typeof cardGenerateV3DraftOutputSchema>;

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
  rewrites: z.array(cardGenerateV3CandidateContentSchema).min(1).max(8),
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

/** An issue may quote the exact sealed source span for a suspected factual claim. */
export const cardContentCheckV3IssueSchema = z.strictObject({
  code: z.string().min(1).max(120),
  severity: z.enum(["hard", "soft"]),
  detail: z.string().min(1).max(2000),
  sourceQuote: z.string().min(1).max(2000).optional(),
});

/**
 * 逐候选的检查结论。`grounding` 带 **grounding 级**的依据支持报告：
 * 审核页的"可保留"门槛要求候选带 binding plan hash，而 binding plan 的组装
 * 消费的是 grounding 合同——简化链把它合并进这一次批量检查的输出里，
 * 不再单独跑一遍 Grounding Critic。
 */
/**
 * 检查腿里**模型真正要交的那一份**：裁决＋原因，**不交 grounding 报告**。
 *
 * `groundingCriticReportV2Schema` 要 `version`／`reportId`／两个哈希与逐答案单元的证据向量——
 * 那些要么是服务端盖章的（`stampCardContentCheckV3Output` 会覆盖），要么本来就有**确定性实现**
 * （`runDeterministicGroundingContract`，离线那一版就是它在跑）。第十发真模型在这里写错一个字面量
 * （`grounding.version` ≠ 2）就让整批红，说明这一层也不该由模型手写。
 */
export const cardContentCheckV3EntryContentSchema = z.strictObject({
  objectiveLocalId: z.string().min(1).max(160),
  verdict: cardContentCheckV3VerdictSchema,
  issues: z.array(cardContentCheckV3IssueSchema).max(40),
});

export const cardContentCheckV3EntrySchema = z.strictObject({
  objectiveLocalId: z.string().min(1).max(160),
  verdict: cardContentCheckV3VerdictSchema,
  /** 39c §6.2："有问题的候选单独显示原因"；措辞类是建议不升级整批失败。 */
  issues: z.array(cardContentCheckV3IssueSchema).max(40),
  grounding: groundingCriticReportV2Schema,
});

/**
 * 检查腿的**逐条宽进**信封：`perCandidate` 先收 `unknown[]`，由调用方逐条按
 * `cardContentCheckV3EntrySchema` 解析——一条检查结论不合合同只让**那一条**变成
 * "没检查过"（`stampCardContentCheckV3Output` 会按 insufficient＋`check_missing` 记账），
 * 不该把整批判成 `output_shape`（第十发真模型在 `grounding.version` 上正是这么整批红的）。
 */
export const cardContentCheckV3EnvelopeSchema = z.strictObject({
  perCandidate: z.array(z.unknown()).max(8),
  setIssues: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(120),
        detail: z.string().min(1).max(2000),
      }),
    )
    .max(20),
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
