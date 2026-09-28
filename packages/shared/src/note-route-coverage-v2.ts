/**
 * 跨轮聚合的**判据与形状**（39d W4-5 ③；PRD §4.4、§10.3、§16.23）。
 *
 * ## 它回答哪一句话
 *
 * §4.4 的原话是：「整体路线进展按**适用目标**汇总多轮实际记录，不要求把它们保存在一个
 * 永不结束的大轮次里」。所以这一份的**单位是目标（核心问题）**，不是轮次：轮次仍然是
 * `learning_runs` 的外层容器（`note_learning_rounds`，D1 §0），而这一份是把**多轮**
 * 摊平之后、按同一个问题归并的那一层。**它不新建第三套状态机**——下面每一个状态都由
 * 既有事实派生（讲解产物行、run 的结论、暴露账本、待核对警示），没有一个是存出来的。
 *
 * ## 「已走完这份核心路线」这句话的门槛
 *
 * §4.4 三句话定死了三件事，逐条对应下面的判据：
 *
 *  1. 「纳入的每个核心问题都已经实际学习，**或有适用证据可略过重复教学**时，才能说
 *     『已走完这份核心路线』」⇒ 分母是**纳入的问题集合**，分子只认
 *     `learned_independently` 与 `learned_with_help`。
 *  2. 「**用户主动跳过、系统未能提供可靠讲解和待核对问题不能算已覆盖**」⇒
 *     `skipped_by_user` / `not_assessable` / `blocked_by_material_conflict`
 *     一律**不**进分子。
 *  3. 「用户缩小范围时，结果注明**按调整后的范围完成**」⇒ 范围变过就换一句结论，
 *     而**不是**把变少的那部分从分母里悄悄拿掉（§4.4 头一句就是禁止这个）。
 *
 * 「借助完成和仍需帮助另外列出，不宣称全部会用」：所以 `assistedCount` 是**独立**的一格，
 * 屏上据此说「已走完，其中 N 个是借助完成的」，而**不是**「全部会用」。
 *
 * ## 「帮助条件」的判据不在这里重写
 *
 * §14.1.1 那句「以**回答锁定先后**为界，而非评分返回时间」由
 * `help-condition-rules-v2.ts` 的 `decideHelpConditionV2` 一处判。这一份**调它**，
 * 不抄第二份判定——抄一份就会有一天两处对同一个回答给出不同的档。
 */
import { z } from "zod";
import { decideHelpConditionV2, type HelpConditionV2 } from "./help-condition-rules-v2.ts";
import { EXPOSURE_KINDS_V2 } from "./learning-card-v2-contracts.ts";
import { learningRunOutcomeSchema } from "./learning-run-contracts.ts";

/**
 * 一次作答的结论那一档。**从 `learning_run_contracts` 的 schema 推导**，不另抄一份
 * 字面量：那份枚举加了新档而这里没跟上时，会在**类型层**红一次，而不是等到某天
 * `attemptGroupV1` 把一档新值悄悄落到"还差着"。
 */
export type NoteRouteAttemptOutcomeV1 = z.infer<typeof learningRunOutcomeSchema>;

/**
 * 一个核心问题在这一篇笔记里的**归属状态**。八档，每一档都对应一句用户能听懂的话，
 * 且**没有一档是「别的都算」**。
 *
 * 为什么不压成 `covered: boolean`：§4.4 要屏上分开说「独立做过」「借助完成」
 * 「因材料矛盾没能学」「用户主动跳过」，而 §4.1 又明写「不要把沉默与跳过记作能力不足」。
 * 压成一个布尔，这四句话就都要在渲染层各写一遍——而那正是这批代码一直在拆的形状。
 */
export const noteRouteQuestionStateV1Schema = z.enum([
  /** 锁定前没有任何帮助，独立做出并判过（§5.6「独立用过」）。 */
  "learned_independently",
  /** 锁定前呈现过帮助，做出来了（§5.6「借助完成」）。**进分子**，但单独报数。 */
  "learned_with_help",
  /** 练过但缺口仍在（`partial` / `needs_repair` / `declared_unable`）。**不进分子**。 */
  "still_needs_help",
  /**
   * §14.1.1 的「帮助条件无法确认」与「根本没有能判的东西」两档合成**一档**：
   * 对用户来说都是同一句话——这一次**不算**独立。它不进分子，但也**不是**「她不会」
   * （§4.1「不将沉默与跳过记作能力不足」）。
   */
  "help_condition_unknown",
  /** `not_assessable`：系统判不了（§4.4「系统未能提供可靠讲解」）。不进分子。 */
  "not_assessable",
  /**
   * 练了，但这一发还没有结论（还在跑／评分待返回／被中断）。
   *
   * **它必须单独一档**：§5.5 末句「系统故障与评分待返回是**附加原因**，不作为『不会』
   * 的终态」——而 `not_attempted` 那一格的话是「纳入但还没练过」，拿它来接一个正在
   * 跑的发，等于把"正在进行"读成"没开始"。两句话对用户完全不同。
   */
  "in_progress",
  /** 用户主动跳过这一题（`skipped`）。§4.4 点名不进分子。 */
  "skipped_by_user",
  /** 这一块材料的说法自相矛盾，压根没形成可练的目标（§4.1 待核对）。不进分子。 */
  "blocked_by_material_conflict",
  /** 纳入了但还没练过。不进分子。 */
  "not_attempted",
]);
export type NoteRouteQuestionStateV1 = z.infer<typeof noteRouteQuestionStateV1Schema>;

/**
 * **算「已覆盖」的那两档**。§4.4 门槛句的直接编码，单独成一个常量而不是散在
 * 比较里：这一份集合就是那句话的全部内容，改它等于改产品定义，要看得见。
 *
 * 注意它**不含** `still_needs_help`：「已经实际学习」不覆盖「练了但还差着」。
 */
export const NOTE_ROUTE_COVERED_STATES_V1: ReadonlySet<NoteRouteQuestionStateV1> = new Set([
  "learned_independently",
  "learned_with_help",
]);

/** 一个问题归并到哪一类「它是什么」。两种形状的差别是屏上要说的两句话。 */
export const noteRouteQuestionKindV1Schema = z.enum(["objective", "material_conflict"]);
export type NoteRouteQuestionKindV1 = z.infer<typeof noteRouteQuestionKindV1Schema>;

/** 一次作答在跨轮聚合里需要的全部事实（读侧投影，不是 DB 行）。 */
export const noteRouteAttemptFactsV1Schema = z.strictObject({
  runId: z.string().uuid(),
  /** 没有结算就是 `null`（还在跑／被判失败没落结论），**不是**「她不会」。 */
  outcome: learningRunOutcomeSchema.nullable(),
  /**
   * 这一发里最早那个**锁定**的回答的时刻（`learning_artifacts.locked_at` 的最小值）。
   * §14.1.1：界是它，不是评分返回时间。`null` = 这一发没有一份锁定的回答
   * ⇒ `decideHelpConditionV2` 会落到 `unknown_no_evidence`，而那正是它该落的档。
   */
  lockedAt: z.string().datetime({ offset: true }).nullable(),
  settledAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteRouteAttemptFactsV1 = z.infer<typeof noteRouteAttemptFactsV1Schema>;

/** 一次暴露（`learning_exposures_v2` 的一行），只带判帮助条件要用的两格。 */
export const noteRouteExposureFactsV1Schema = z.strictObject({
  kind: z.enum(EXPOSURE_KINDS_V2),
  exposedAt: z.string().datetime({ offset: true }),
});
export type NoteRouteExposureFactsV1 = z.infer<typeof noteRouteExposureFactsV1Schema>;

/**
 * 归并后的一个问题（**读侧投影**）。`roundIds` 带出来是为了 §10.3 详情页能点回
 * 某一轮；`attempts` 带出来是为了 §5.6 那种「每个结论可展开到实际作答」。
 */
export const noteRouteQuestionV1Schema = z.strictObject({
  /**
   * `objective:<uuid>` 或 `material_conflict:<unitId>`。
   *
   * **不是 uuid**：待核对的问题压根没有目标（`persistRoundTarget` 拒收含疑点的单元），
   * 而 §4.4 明确要求它出现在分母里。用纯 uuid 那一档就得编一个假 id，
   * 而假 id 迟早会被当成真目标去点。
   */
  questionId: z.string().min(1).max(200),
  kind: noteRouteQuestionKindV1Schema,
  /** 屏上念的那一句：目标的 `conceptLabel`，或待核对警示的短描述。 */
  label: z.string().min(1).max(300),
  state: noteRouteQuestionStateV1Schema,
  stateHelpCondition: z.enum(["independent", "assisted", "unreconcilable", "unknown_no_evidence"]).nullable(),
  roundIds: z.array(z.string().uuid()).max(50),
  attempts: z.array(noteRouteAttemptFactsV1Schema).max(50),
  /** 只有 `material_conflict` 那档有：为什么这块材料现在不能当依据。 */
  conflictReason: z.string().min(1).max(1_000).nullable(),
  /** 最近一次有结论的时刻（按它排「还卡在哪」那一串）。 */
  lastSettledAt: z.string().datetime({ offset: true }).nullable(),
});
export type NoteRouteQuestionV1 = z.infer<typeof noteRouteQuestionV1Schema>;

/**
 * 这一篇的整条核心路线（**跨轮**汇总）。
 *
 * `scopeAdjusted` 那一格是 §4.4 最后一句的落点：范围变过，结论要改口径，
 * 而**不是**把变少的那部分从 `questions` 里删掉——`questions` 永远是纳入过的全部。
 */
export const noteRouteCoverageV1Schema = z.strictObject({
  version: z.literal(1),
  noteId: z.string().uuid(),
  questions: z.array(noteRouteQuestionV1Schema).max(200),
  summary: z.strictObject({
    totalCount: z.number().int().min(0),
    coveredCount: z.number().int().min(0),
    /** 独立做过的（`learned_independently`）——§5.6「独立用过」。 */
    independentCount: z.number().int().min(0),
    /** 借助完成的（`learned_with_help`）——§5.6「借助完成」，**单独报**。 */
    assistedCount: z.number().int().min(0),
    uncoveredCount: z.number().int().min(0),
  }),
  verdict: z.strictObject({
    /**
     * 四个档，**没有**「已完成」与「部分完成」各说各的：
     *  - `no_questions`：这一篇还没有纳入过任何核心问题（§4.1「目录尚不能可靠整理时
     *    仅提供分次探索，不承诺完整覆盖」——那一句在屏上就是这一档）。
     *  - `route_complete`：每一个纳入的问题都实际学过。
     *  - `route_complete_within_adjusted_scope`：同上，但**范围被缩小过**，
     *    屏上必须念成「按调整后的范围完成」（§4.4 末句）。
     *  - `route_incomplete`：还有没覆盖的，`uncovered` 列出来。
     */
    kind: z.enum([
      "no_questions",
      "route_complete",
      "route_complete_within_adjusted_scope",
      "route_incomplete",
    ]),
    /** 范围调整的事实（来自计划修订里那一次变小的记录）；没有就是 `null`。 */
    scopeAdjustedAt: z.string().datetime({ offset: true }).nullable(),
    scopeAdjustmentReason: z.string().min(1).max(500).nullable(),
    /** 没覆盖的那些，**按状态分组**而不是一长串——屏上要按原因说不同的话。 */
    uncovered: z.array(z.strictObject({
      questionId: z.string().min(1).max(200),
      label: z.string().min(1).max(300),
      state: noteRouteQuestionStateV1Schema,
    })).max(200),
  }),
});
export type NoteRouteCoverageV1 = z.infer<typeof noteRouteCoverageV1Schema>;

// ─── 判据（纯函数）──────────────────────────────────────────────────────

/**
 * 判定一次作答的帮助条件。
 *
 * 它**只是把 `decideHelpConditionV2` 的入参摆好**：暴露账本里这个目标的每一笔，
 * 按 §14.1.1 的界与那一发的锁定时刻比——锁定前呈现过的才是帮助，锁定后送达的
 * （正常提交成功后才显示的答案与反馈）**不**追溯降低那份已锁定的回答。
 *
 * 三个边界都写在这里而不是注释里：
 *  - **多次暴露取最早那笔**的呈现时刻：任一笔落在锁定前就算有帮助，不取「最后一笔」
 *    （后者会让「先看答案再答」被后一笔无关的呈现抹掉）。
 *  - **只有 `EXPOSURE_KINDS_V2` 里的三档**算数；不在成员表里的档位不参与判定
 *    （成员表只有一份，加档时改这一处）。
 *  - **没有锁定回答 ⇒ `unknown_no_evidence`**：这是 `decideHelpConditionV2` 自己的第一档，
 *    这里不去救它——「判不出来」必须显示成判不出来（§14.1.1）。
 */
export function decideAttemptHelpConditionV1(input: {
  attempt: NoteRouteAttemptFactsV1;
  exposures: readonly NoteRouteExposureFactsV1[];
}): HelpConditionV2 {
  const lockedAt = input.attempt.lockedAt === null ? null : new Date(input.attempt.lockedAt);
  const beforeLock = (at: Date): boolean => lockedAt !== null && at.getTime() < lockedAt.getTime();
  const shownBeforeLock = input.exposures
    .filter((exposure) => (EXPOSURE_KINDS_V2 as readonly string[]).includes(exposure.kind))
    .map((exposure) => new Date(exposure.exposedAt))
    .filter(beforeLock)
    .sort((a, b) => a.getTime() - b.getTime());
  // 请求与呈现**同源**：暴露账本记的是「呈现回执」（§14.1.1「以可信呈现回执为依据，
  // 不以生成成功推断看过」），所以没有「只请求过」的中间档。
  return decideHelpConditionV2({
    answerLockedAt: lockedAt,
    helpRequestedAt: shownBeforeLock[0] ?? null,
    helpPresentedAt: shownBeforeLock[0] ?? null,
    // 暴露账本今天有写入方（讲解揭示、答案揭示、审核台），所以「有没有能力判」为真。
    reconcilable: true,
  });
}

/**
 * 一次作答归到哪一档。**分类而不是打分**——打分会把"没结论"和"判不了"压成同一个 0，
 * 而 §5.5 明写这两件事对用户是两句话。
 *
 * 档内再比一个位次，只用���**选哪一发代表这个问题**（最新的优先），
 * 不参与判对错：判定早就在 `learning_assessments` 里落好了。
 */
const ATTEMPT_GROUP_V1: Readonly<Record<"learned" | "needs_help" | "not_assessable" | "skipped" | "in_progress", readonly NoteRouteAttemptOutcomeV1[]>> = {
  learned: ["demonstrated", "practice_completed"],
  needs_help: ["partial", "needs_repair", "declared_unable"],
  not_assessable: ["not_assessable"],
  skipped: ["skipped"],
  in_progress: [],
};

type AttemptGroupV1 = keyof typeof ATTEMPT_GROUP_V1;

function attemptGroupV1(outcome: NoteRouteAttemptOutcomeV1 | null): AttemptGroupV1 {
  if (outcome === null) return "in_progress";
  for (const [group, members] of Object.entries(ATTEMPT_GROUP_V1) as Array<[AttemptGroupV1, readonly NoteRouteAttemptOutcomeV1[]]>) {
    if (members.includes(outcome)) return group;
  }
  // 新增一档 outcome 而这里没跟上 ⇒ 宁可落到"还差着"，也不落到"学会了"（fail safe）。
  return "needs_help";
}

/** 同一档里挑代表发：先按"学会了 > 还差着"那一层的粗序，再取最近的那次结算。 */
const GROUP_PREFERENCE_V1: Readonly<Record<AttemptGroupV1, number>> = {
  learned: 3,
  needs_help: 2,
  not_assessable: 1,
  in_progress: 0,
  skipped: -1,
};

/**
 * 归并一个问题：多轮、多发作答压成一档状态。
 *
 * **优先级的次序是产品定义的一部分**，逐条有理由：
 *
 *  1. **材料矛盾先于一切**（`material_conflict`）：这块材料现在自相矛盾，
 *     拿它练出来的任何结论都不能当「已覆盖」——§4.4 明写待核对不算覆盖。
 *     排在最前而不是最后，是因为后面每一档都在回答「她练得怎么样」，
 *     而这一块根本还不该练。
 *  2. **一次都没练过** ⇒ `not_attempted`（还没发生的分不出更多档）。
 *  3. **任何一次都还没有结论**（`in_progress`）⇒ `in_progress`。它排在跳过的前面，
 *     因为"正在跑"是比"跳过了"更当前的实话（§5.5：迟到判定是补充记录，不改写当时）。
 *  4. **有跳过的那一发**（且没有更好的档）⇒ `skipped_by_user`。
 *     §4.4 点名「用户主动跳过」不算覆盖，而 §4.1 又禁止把跳过读成不会——
 *     两句合起来就是它**单独一档**、不进分子、也不说成「不会」。
 *  5. **`not_assessable`** ⇒ 系统判不了，不进分子（§4.4「系统未能提供可靠讲解」）。
 *  6. 取**位次最高的那一发**：`learned` ＞ `needs_help` ＞ `not_assessable`。
 *  7. 代表发落在 `learned` 那一档时，再按 §14.1.1 判它**独立还是借助**：
 *     `independent` ⇒ `learned_independently`；`assisted` ⇒ `learned_with_help`；
 *     `unreconcilable` / `unknown_no_evidence` ⇒ `help_condition_unknown`
 *     （§14.1.1「保留回答但不签发独立证据」——所以它**不进分子**）。
 *  8. 代表发落在 `needs_help` ⇒ `still_needs_help`。
 *     `declared_unable` 落在这里而不是「不会」那一档：§4.1 明写不能把用户明说的
 *     「不会」报成系统的判不准，而屏上要说的是「还差着」。
 */
export function decideNoteRouteQuestionV1(input: {
  questionId: string;
  kind: NoteRouteQuestionKindV1;
  label: string;
  roundIds: readonly string[];
  attempts: readonly NoteRouteAttemptFactsV1[];
  exposures: readonly NoteRouteExposureFactsV1[];
  conflictReason?: string | null;
}): NoteRouteQuestionV1 {
  const best = [...input.attempts].sort(
    (a, b) => GROUP_PREFERENCE_V1[attemptGroupV1(b.outcome)] - GROUP_PREFERENCE_V1[attemptGroupV1(a.outcome)]
      || (b.settledAt ?? b.lockedAt ?? "").localeCompare(a.settledAt ?? a.lockedAt ?? ""),
  )[0] ?? null;
  const lastSettledAt = input.attempts
    .map((attempt) => attempt.settledAt)
    .filter((value): value is string => value !== null)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;

  const finish = (state: NoteRouteQuestionStateV1, helpCondition: HelpConditionV2 | null): NoteRouteQuestionV1 => ({
    questionId: input.questionId,
    kind: input.kind,
    label: input.label,
    state,
    stateHelpCondition: helpCondition,
    roundIds: [...input.roundIds],
    attempts: [...input.attempts],
    conflictReason: input.kind === "material_conflict" ? (input.conflictReason ?? "这块材料的说法互相矛盾") : null,
    lastSettledAt,
  });

  if (input.kind === "material_conflict") return finish("blocked_by_material_conflict", null);
  if (input.attempts.length === 0) return finish("not_attempted", null);

  const bestGroup = attemptGroupV1(best?.outcome ?? null);
  if (bestGroup === "in_progress") return finish("in_progress", null);
  if (bestGroup === "skipped") return finish("skipped_by_user", null);
  if (bestGroup === "not_assessable") return finish("not_assessable", null);
  if (best === null) return finish("not_attempted", null);
  if (bestGroup === "needs_help") {
    return finish("still_needs_help", decideAttemptHelpConditionV1({ attempt: best, exposures: input.exposures }));
  }
  const helpCondition = decideAttemptHelpConditionV1({ attempt: best, exposures: input.exposures });
  if (helpCondition === "independent") return finish("learned_independently", helpCondition);
  if (helpCondition === "assisted") return finish("learned_with_help", helpCondition);
  return finish("help_condition_unknown", helpCondition);
}

/**
 * 整条路线的那句结论（§4.4 的门槛）。
 *
 * 四条判据，逐条是产品决定：
 *  1. **一个纳入的问题都没有 ⇒ `no_questions`**：那不是「已完成」，是「还不承诺覆盖」
 *    （§4.1「目录尚不能可靠整理时…不承诺完整覆盖」）。
 *  2. **每个问题都在 `NOTE_ROUTE_COVERED_STATES_V1` 里**才是完成。
 *  3. **范围缩小过** ⇒ 结论换成 `route_complete_within_adjusted_scope`，
 *     **而 `uncovered` 仍然是空的**——缩小的是分母的口径，不是把没覆盖的藏起来。
 *  4. `uncovered` **只列没覆盖的**，且带状态：屏上按原因说不同的话
 *    （「有 2 处材料自相矛盾」与「有 1 处你跳过了」是两句不同的话）。
 */
export function summarizeNoteRouteCoverageV1(input: {
  noteId: string;
  questions: readonly NoteRouteQuestionV1[];
  scopeAdjustedAt?: string | null;
  scopeAdjustmentReason?: string | null;
}): NoteRouteCoverageV1 {
  const covered = input.questions.filter((q) => NOTE_ROUTE_COVERED_STATES_V1.has(q.state));
  const uncovered = input.questions.filter((q) => !NOTE_ROUTE_COVERED_STATES_V1.has(q.state));
  const complete = input.questions.length > 0 && uncovered.length === 0;
  const adjustedAt = input.scopeAdjustedAt ?? null;
  return {
    version: 1,
    noteId: input.noteId,
    questions: [...input.questions],
    summary: {
      totalCount: input.questions.length,
      coveredCount: covered.length,
      independentCount: covered.filter((q) => q.state === "learned_independently").length,
      assistedCount: covered.filter((q) => q.state === "learned_with_help").length,
      uncoveredCount: uncovered.length,
    },
    verdict: {
      kind: input.questions.length === 0
        ? "no_questions"
        : complete
          ? (adjustedAt !== null ? "route_complete_within_adjusted_scope" : "route_complete")
          : "route_incomplete",
      scopeAdjustedAt: adjustedAt,
      scopeAdjustmentReason: adjustedAt !== null ? (input.scopeAdjustmentReason ?? "范围被缩小过") : null,
      uncovered: uncovered.map((q) => ({ questionId: q.questionId, label: q.label, state: q.state })),
    },
  };
}

/** 目标 id → 归并用的 `questionId`。**只有这一处**知道这个前缀的形状。 */
export function noteRouteQuestionIdForObjectiveV1(objectiveId: string): string {
  return `objective:${objectiveId}`;
}

/** 待核对那一档的 `questionId`；它没有目标 id 可用，用单元 id（§4.1 的最小单位）。 */
export function noteRouteQuestionIdForConflictV1(unitId: string): string {
  return `material_conflict:${unitId}`;
}
