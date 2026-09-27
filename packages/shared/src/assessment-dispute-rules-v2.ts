/**
 * 学习判定的**争议与更正**裁决（39d W5-5；39 §14.2、§16.11、§16.22、§16.25）。
 *
 * 为什么单独一份纯函数：§14.2 的原话是"用户提出争议后……**不能反复要求用户接受同一判定**"，
 * 而"反复"的形状不是某一个 bug，是**多处各自解释**。今天只有结算与结果页两处会读
 * "这条判定现在算不算数"，明天复核台、历史与星图也要读。规则写在调用方 = 抄 N 份，
 * 少抄一份就出现"同一个争议在结算页被压住、在历史页又被当成定论"。
 * 与 `review-authorization-rules-v2`（§9.1 那张规则表）同一条纪律：执法点要少，
 * 判据要能被逐条单测。
 *
 * 这里只有**判断**，没有读写：争议现在是什么状态、复核做过没有、更正写过没有，
 * 由 `apps/api/src/modules/learning-runs/run-disputes.ts` 查出来交进来。
 *
 * §14.2 的六条规则各自对应下面一段函数；§16.25 把其中最容易混的两件事拆成不可覆盖的
 * 不变量（`correctionBackdatesFirstAnswerV2` / `correctionOverwritesFirstAnswerV2`），
 * 它们是**返回常量的判据而不是判断**：这两条如果哪天能返回 false，§16.25 就破了，
 * 而那种破损在集成测试里很难看出来，所以让它在单测里一眼可见。
 */
import { z } from "zod";

// ─── 词汇（§14.2「用户可以报告"解释不对""题目有问题""我的意思被误解"」）────────────

/**
 * 争议的种类。四种都**不预设**系统错了——§16.11 的验收是"用户提出一种不同解释时，
 * 不因表述不一致直接判错"，所以 `misunderstood` 与 `item_faulty` 都可能是用户自己
 * 想错了。把它们压成一个 `dispute` 布尔值会让复核台无从下手：题目有问题要去核题面，
 * 我的意思被误解要去核原回答，方向不同。
 */
export type AssessmentDisputeKindV2 =
  | "explanation_faulty" // 解释不对
  | "item_faulty" // 题目有问题
  | "misunderstood" // 我的意思被误解
  | "misjudged"; // 系统判错了

/**
 * 一次重新检查的三个结论（§14.2："展示**维持／修正／仍无法判断**的理由"）。
 *
 * 三个都不能省：`upheld` 是"看过原题原答之后原判定仍成立"，`corrected` 是"原回答
 * 本身已满足原评分条件、原判被纠正"，`undetermined` 是"仍然不可靠，维持争议状态，
 * **不强行选一方作为事实**"。少了 `undetermined` 就会逼系统二选一，那正是 §14.2
 * 明写不许做的事。
 */
export type AssessmentDisputeRecheckOutcomeV2 = "upheld" | "corrected" | "undetermined";

/** 争议行自身的生命周期。`recheck_*` 三态与 `recheck_outcome` 一一对应，不重复表达。 */
export type AssessmentDisputeStatusV2 =
  | "open" // 已受理，尚未复核
  | "recheck_upheld" // 复核维持
  | "recheck_corrected" // 复核修正原判
  | "recheck_undetermined" // 复核仍无法判断（**争议保持未决**，不是关闭）
  | "closed_held"; // 本人选择结束并把该项暂不安排

/**
 * 更正的两种形状（§16.25：第一位用户原答案**包含**必要条件、系统漏判；第二位用户
 * 原来**缺少**条件、看到反馈后才补充）。
 *
 * 两者在库上是**不同形状的更正记录**，不是同一条的两个取值：前者纠正的是**系统误判**，
 * 依据仍然是同一份原回答；后者形成的是**新的解释或练习**，依据是用户后来补的答案。
 * §14.2 末段明写"前者纠正系统误判，后者形成新的解释或练习，均保留第一次原文"——
 * 合成一种形状就必然要靠一个布尔去猜，而那个布尔正是 §16.25 要防的"混算"。
 */
export type AssessmentCorrectionKindV2 = "system_misjudgment" | "user_supplement";

// ─── 规则一：一次重新检查，争议不形成死循环（§16.22）────────────────────

/**
 * §16.22 的验收原话是"本批不自动变长，**争议不形成死循环**"。
 *
 * 判据只问"这一次判定上有没有已经落库的复核结果"，不问原因、不看是谁触发的：
 * 允许"维持之后用户再补充说明"是**产品**要的（§14.2："用户提出争议后，可补充说明"），
 * 但那之后**不得再触发第二次重新检查**——所以闸门是"复核已经发生过"，不是"结果是否有用"。
 * 结果是 `upheld` 也不例外：让系统可以对着同一次回答反复重检，就是这条规则要挡的死循环。
 *
 * 返回 `null` 表示可以复核；返回原因时调用方要把既有回执原样交回，**不得**当成新一次。
 */
export function decideDisputeRecheckV2(input: {
  readonly disputeClosed: boolean;
  readonly recheckPerformed: boolean;
}): { readonly allowed: true } | {
  readonly allowed: false;
  readonly reasonCode: "dispute_closed" | "recheck_already_performed";
} {
  if (input.disputeClosed) return { allowed: false, reasonCode: "dispute_closed" };
  if (input.recheckPerformed) return { allowed: false, reasonCode: "recheck_already_performed" };
  return { allowed: true };
}

// ─── 规则二：待复核时不持续放大结论（§14.2）────────────────────────────────

/**
 * §14.2："待复核时**不持续放大结论**"；§14.3 对可疑断言也是同一句
 * "不能因为用户准确复述原句就增加正式正确证据或推进该主张的记忆间隔"。
 *
 * 三个取值对应结算与推荐对**这一次观察**能做的三件事：
 *  - `withhold_conclusion`：结论保留可查，但不据此推进间隔、不作为负面推荐依据
 *    （§14.2 末句"未经确认的争议结果不继续作为负面推荐依据"）；
 *  - `apply_correction_once`：复核结论是"修正"——写**一条**更正记录（不是改原判定），
 *    并且只许应用一次（§16.25 的"不倒算"在数据面上的形状）；
 *  - `use_as_is`：无活争议，或复核结论是"维持"——按原判定走。
 *
 * `recheck_corrected` 仍然**不**直接"用修正后的结果去推进间隔"：§9.6 要求"需要重新
 * 计算时仍经唯一调度服务，基于全部适用事实和当前授权给出一次明确回执"，所以这一发
 * 交给调度边界重算，而不是就地插一条安排。
 */
export function decideDisputedObservationV2(input: {
  readonly hasLiveDispute: boolean;
  readonly recheckOutcome: AssessmentDisputeRecheckOutcomeV2 | null;
  readonly correctionAlreadyApplied: boolean;
}): {
  readonly action: "use_as_is" | "withhold_conclusion" | "apply_correction_once";
  /** §14.2"问题产物对本人暂停复用"：这一发要顺带交回去的话，就是"别再用这题了"。 */
  readonly suspendsArtifactReuse: boolean;
  readonly reasonCode: string;
} {
  if (!input.hasLiveDispute) {
    return { action: "use_as_is", suspendsArtifactReuse: false, reasonCode: "no_live_dispute" };
  }
  if (input.recheckOutcome === null) {
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "awaiting_recheck" };
  }
  if (input.recheckOutcome === "undetermined") {
    // 维持争议状态，**不强行选一方**（§14.2 末句）。所以它仍然不发结论。
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "recheck_undetermined" };
  }
  if (input.recheckOutcome === "upheld") {
    return { action: "use_as_is", suspendsArtifactReuse: true, reasonCode: "recheck_upheld" };
  }
  // corrected：更正记录只许应用一次。第二次进来（重试、迟到回执）必须回到
  // "已经应用过"，否则同一次更正会被消费两次，也就是重复计学习。
  if (input.correctionAlreadyApplied) {
    return { action: "withhold_conclusion", suspendsArtifactReuse: true, reasonCode: "correction_already_applied" };
  }
  return { action: "apply_correction_once", suspendsArtifactReuse: true, reasonCode: "recheck_corrected" };
}

// ─── 规则三：更正不重写历史原回答（§14.2、§16.25）────────────────────────

/**
 * §14.2："更正以新的有理由记录表达，**不重写历史原回答**"。
 *
 * 常量判据，不是判断：调用方（服务层）照它写代码，单测照它钉住这个不变量。
 * 写成 `true` 而不是由入参推导，是为了让它在"入参写错"时仍然报出矛盾——
 * 任何一次试图让更正覆盖原回答的改法，都会在这条单测上立刻红。
 */
export function correctionOverwritesFirstAnswerV2(
  _kind: AssessmentCorrectionKindV2,
): false {
  return false;
}

/**
 * §14.2 末段与 §16.25："**不能倒算第一次已答对**"；用户的补充"是新材料，不覆盖第一次
 * 回答，也不能倒算第一次已答对"。
 *
 * 与上一条同形：两种更正都不倒算。区别在于第二种**另外**形成一次新的表现记录
 * （§16.25："后者保留原回答并记录补充后的表现"）——那是"新增一次观察"，
 * 而不是"把第一次那次改成答对"。
 */
export function correctionBackdatesFirstAnswerV2(
  _kind: AssessmentCorrectionKindV2,
): false {
  return false;
}

/**
 * §16.25："用户补答"这一档**必须**挂一份新的作答产物。
 *
 * 判据是给数据面用的：没有 `supplement_artifact_id` 的 `user_supplement` 更正
 * 无法说清"补充后的表现"是哪一次表现，那种行会让 §14.1"每个可观察目标至少保留：
 * 观察时间、使用的内容、任务与回答"这一格读不出来。返回原因码而不是抛错，
 * 便于路由翻成 422 而不是 500。
 */
export function decideSupplementArtifactRequiredV2(input: {
  readonly kind: AssessmentCorrectionKindV2;
  readonly supplementArtifactId: string | null;
}): { readonly required: false } | { readonly required: true; readonly provided: boolean } {
  if (input.kind !== "user_supplement") return { required: false };
  return { required: true, provided: Boolean(input.supplementArtifactId) };
}

// ─── 规则四：仍有争议时可结束并暂不安排（§14.2）────────────────────────────

/**
 * §14.2："仍有争议时可结束并将该项**暂不安排**，不能反复要求用户接受同一判定"。
 *
 * 走的是 0295 那张目标级排除（`objective_review_holds_v2`），不是新的一套：
 * §9.1 把它定义为"优先于笔记和卡片授权"的持续排除，争议收尾要的就是这一个语义。
 * 复用它的另一个好处是"结束并暂不安排"会**连带撤下此刻已排着的那一条待办**
 * （`holdObjectiveFromReviewV2` 已有这个行为），不必在这里再抄一遍。
 *
 * 排除**按目标**生效，所以争议指向哪个目标是判据的一部分；判不出来（那次观察没有
 * 挂目标）时只能结束争议而**不能**顺手动别人的安排——返回 `close_without_hold`。
 *
 * 第三档 `hold_unavailable`：本人要暂不安排，但这一发**排不出**可挂的笔记
 * （排除表的 `note_id` 不可空，而手动／导入来源的目标没有"这一篇笔记"）。
 * 单独一档而不是静默降级成 `close_without_hold`——那会让界面显示"已暂不安排"而库里
 * 什么都没写，是假回执；也不抛错把整个结束动作卡死：争议**照样结束**，只把没能落排除
 * 这件事如实说出来。§14.2 的出口是"可结束"，让用户走不掉是更坏的失败。
 */
export function decideDisputeCloseV2(input: {
  readonly objectiveId: string | null;
  readonly userAskedForHold: boolean;
  /** 能不能挂上一篇真笔记（`origin_kind='note'` 的绑定）。缺省按"能"处理。 */
  readonly noteBindingAvailable?: boolean;
}): {
  readonly outcome: "hold_objective" | "close_without_hold" | "hold_unavailable";
} {
  if (!input.objectiveId || !input.userAskedForHold) return { outcome: "close_without_hold" };
  if (input.noteBindingAvailable === false) return { outcome: "hold_unavailable" };
  return { outcome: "hold_objective" };
}

// ─── 规则五：争议是个人数据（§14.4）────────────────────────────────────────

/**
 * §14.4："每个人的作答、安排、提示暴露、学习位置和学习回写建议为**个人数据**"。
 *
 * 争议报告的是"我为什么觉得这次判得不对"——同一个人对同一题可能开两次、也可能撤掉，
 * 另一位成员看不到、也不该被这条记录影响。判据把"能不能读"这件事收在
 * (workspace, user) 两列上，与表上的 RLS 策略同一条；共享材料侧的撤回与修改
 * 仍按权限另走，**不由这一发代替**（§14.2 末段）。
 */
export function disputeIsPersonalOnlyV2(): {
  readonly readableByAuthorOnly: true;
  readonly affectsOtherMembersEvidence: false;
  readonly sharedMaterialWithdrawalHandledElsewhere: true;
} {
  return {
    readableByAuthorOnly: true,
    affectsOtherMembersEvidence: false,
    sharedMaterialWithdrawalHandledElsewhere: true,
  };
}

// ─── wire 合同（路由与桌面共用）────────────────────────────────────────────
const isoTimestampV2Schema = z.string().datetime({ offset: true });

export const assessmentDisputeKindV2Schema = z.enum([
  "explanation_faulty",
  "item_faulty",
  "misunderstood",
  "misjudged",
]);
export type AssessmentDisputeKindV2Wire = z.infer<typeof assessmentDisputeKindV2Schema>;

export const assessmentDisputeRecheckOutcomeV2Schema = z.enum([
  "upheld",
  "corrected",
  "undetermined",
]);
export type AssessmentDisputeRecheckOutcomeV2Wire = z.infer<
  typeof assessmentDisputeRecheckOutcomeV2Schema
>;

/**
 * 争议状态的 zod 那一档，**只在读侧用**（写侧的状态由服务端按复核结论推进，
 * 不接受调用方指定——否则就能凭空写出一个"已结束"来结束掉别人的争议）。
 *
 * 单独导出而不是就地内联在 `assessmentDisputeViewV2Schema` 里：0296 的
 * `adv2_status_chk` 是这五档的抄本，`assessment-dispute-kinds.test.ts` 要把三处
 * 一次对齐，内联的那一份它抓不到。
 */
export const assessmentDisputeStatusV2Schema = z.enum([
  "open",
  "recheck_upheld",
  "recheck_corrected",
  "recheck_undetermined",
  "closed_held",
]);
export type AssessmentDisputeStatusV2Wire = z.infer<typeof assessmentDisputeStatusV2Schema>;

export const assessmentCorrectionKindV2Schema = z.enum([
  "system_misjudgment",
  "user_supplement",
]);

/** 开一份争议。`statement` 是必填：没有理由的"我不同意"没法进复核。 */
export const openAssessmentDisputeV2Schema = z.strictObject({
  assessmentId: z.string().uuid(),
  kind: assessmentDisputeKindV2Schema,
  statement: z.string().min(1).max(2000),
});
export type OpenAssessmentDisputeV2Input = z.infer<typeof openAssessmentDisputeV2Schema>;

/** 补充说明。§14.2 明写这是允许的，且**不重开**已落库的复核。 */
export const submitDisputeSupplementV2Schema = z.strictObject({
  supplement: z.string().min(1).max(2000),
});
export type SubmitDisputeSupplementV2Input = z.infer<typeof submitDisputeSupplementV2Schema>;

/**
 * 一次重新检查的落库形状。
 *
 * `reason` 必填：§14.2 要求"**展示**维持／修正／仍无法判断的**理由**"，
 * 交不出一句话就等于没展示。`reportHash` 必填，同 `learning_assessments` 的
 * 终态要求（§12.4 fail closed）——理由要能被追溯到哪一次复核产物。
 */
export const completeDisputeRecheckV2Schema = z.strictObject({
  outcome: assessmentDisputeRecheckOutcomeV2Schema,
  reason: z.string().min(1).max(2000),
  reportHash: z.string().min(1).max(128),
});
export type CompleteDisputeRecheckV2Input = z.infer<typeof completeDisputeRecheckV2Schema>;

/** 写一条更正。`kind` 决定 `supplementArtifactId` 是否必填（见上面的规则三）。 */
export const recordAssessmentCorrectionV2Schema = z.strictObject({
  kind: assessmentCorrectionKindV2Schema,
  reason: z.string().min(1).max(2000),
  /** `user_supplement` 必填：这次"补充后的表现"是哪一次作答。 */
  supplementArtifactId: z.string().uuid().nullish(),
  correctedRubricResults: z.array(z.unknown()).max(200).default([]),
});
export type RecordAssessmentCorrectionV2Input = z.infer<
  typeof recordAssessmentCorrectionV2Schema
>;

/** 结束争议。`holdObjective` 是"把该项暂不安排"那颗按钮（§14.2）。 */
export const closeAssessmentDisputeV2Schema = z.strictObject({
  holdObjective: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type CloseAssessmentDisputeV2Input = z.infer<typeof closeAssessmentDisputeV2Schema>;

/** 读侧：一份争议在界面上要能说清的全部内容。 */
export const assessmentDisputeViewV2Schema = z.strictObject({
  version: z.literal(2),
  id: z.string().uuid(),
  assessmentId: z.string().uuid(),
  /** §14.2"争议记录关联原产物和版本"——原答案冻结在哪个修订上，界面要能念出来。 */
  artifactId: z.string().uuid(),
  artifactRevision: z.number().int().positive(),
  objectiveId: z.string().uuid().nullable(),
  kind: assessmentDisputeKindV2Schema,
  status: assessmentDisputeStatusV2Schema,
  statement: z.string(),
  supplement: z.string().nullable(),
  recheckOutcome: assessmentDisputeRecheckOutcomeV2Schema.nullable(),
  /** 界面直接念这一句；`null` 表示复核还没做，不要显示成"维持"。 */
  recheckReason: z.string().nullable(),
  corrections: z.array(z.strictObject({
    id: z.string().uuid(),
    kind: assessmentCorrectionKindV2Schema,
    reason: z.string(),
    supplementArtifactId: z.string().uuid().nullable(),
    createdAt: isoTimestampV2Schema,
  })),
  createdAt: isoTimestampV2Schema,
  resolvedAt: isoTimestampV2Schema.nullable(),
});
export type AssessmentDisputeViewV2 = z.infer<typeof assessmentDisputeViewV2Schema>;
