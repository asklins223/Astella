/**
 * 星图三层展开与状态三轴的公共合同（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、§16.12）。
 *
 * ── 为什么要一份**新**合同，而不是把 V3 拓扑加宽 ──────────────────────────
 * 拓扑快照那份回答的是"**图上有哪些节点**"；这三层回答的是"**沿着一篇笔记往下读
 * 会依次看到什么**"，两者不是同一个读法。§11.5 写死了"总览只显示当前层，局部按需
 * 加载"——把局部塞进整张快照，等于让每一次读星图都把每一篇笔记的学习记录搬一遍，
 * 而用户当下只要了一篇。所以：层一（笔记总览）由既有拓扑投影，层二与层三走这一份
 * **按一篇笔记**的读。
 *
 * ── 三条产品决定写在这一层，而不是留给渲染层临场发挥 ──────────────────────
 *  1. **三轴分开，不合成一个亮度**（§11.4）。`noteStateAxesV3` 是三个**具名事实**，
 *     不是三个分数也不是一个分数。任何"把三轴折成一个 0..100"的新增字段都会在
 *     `noteDeepeningV3Schema` 那个 `strictObject` 上当场红。
 *  2. **不用数量画理解百分比**（§11.4 逐字）。所以三轴的值域是**字面量枚举**，
 *     不是数字；`noteDeepeningV3` 里也不许出现任何表达"掌握程度"的数值。
 *  3. **没有学习记录时不伪造内部要点与关系**（§11.2 逐字）。`buildNoteDeepeningV3`
 *     在"零目标、零记录"时返回的层二是**空的**——空数组是事实，"核心问题：正在
 *     建立理解"是编的。
 */
import { z } from "zod";
import { objectivePersonalStateV3Schema } from "./learning-objective-surface-contracts.ts";
import { personalRelationKindV2Schema } from "../personal-relation-decision-rules-v2.ts";
import type { ObjectivePersonalStateV3 } from "./learning-objective-surface-contracts.ts";

// ─── §11.4 三轴：三份**具名事实**，不是三份分数 ─────────────────────────────

/**
 * 轴一「学习表现」（§11.4 第一行「可展示事实」那一列）。
 *
 * 五档照那一列抄：曾接触、借助完成、某次独立用过、跨时间有重复证据，外加"还没有
 * 学习记录"这一档**空**。空档必须在这里而不是让调用方拿 `undefined` 顶——五档全
 * 是陈述句，渲染层可以直接念，不会出现"这一轴读不出来"。
 *
 * **没有 `mastered`**：§11.4 第一行「不能混成的含义」写着「自动等于长期掌握」。
 * 值域里放一个"已掌握"就是把那半句禁令抄了回来。
 */
export const notePerformanceAxisV3Schema = z.enum([
  "no_record_yet",
  "met_once",
  "assisted_once",
  "used_independently",
  "repeated_over_time",
]);
export type NotePerformanceAxisV3 = z.infer<typeof notePerformanceAxisV3Schema>;

/**
 * 轴二「下一步」（§11.4 第二行）。「到期就变成'不会'」是那一行**禁止**的混法，
 * 所以 `due_for_review` 说的是"适合回访"，不是"没学会"。
 */
export const noteNextStepAxisV3Schema = z.enum([
  "nothing_to_do",
  "can_continue",
  "suggest_relearn",
  "due_for_review",
  "paused_by_user",
]);
export type NoteNextStepAxisV3 = z.infer<typeof noteNextStepAxisV3Schema>;

/**
 * 轴三「内容适用性」（§11.4 第三行）。「资料变化就是用户退步」是禁止的混法，
 * 所以 `basis_updated` / `needs_check` 说的是**材料**的状态。
 */
export const noteApplicabilityAxisV3Schema = z.enum([
  "basis_holds",
  "basis_updated",
  "needs_check",
  "no_permission",
]);
export type NoteApplicabilityAxisV3 = z.infer<typeof noteApplicabilityAxisV3Schema>;

/**
 * 三轴**就是三个并列的键**，没有第四个。
 *
 * `strictObject` 是这份合同里最要紧的一个字：多写一格 `understandingScore` 会在
 * 解析那一刻就红，而不是渲染层悄悄把它画成一颗更亮的星。
 */
export const noteStateAxesV3Schema = z.strictObject({
  performance: notePerformanceAxisV3Schema,
  nextStep: noteNextStepAxisV3Schema,
  applicability: noteApplicabilityAxisV3Schema,
});
export type NoteStateAxesV3 = z.infer<typeof noteStateAxesV3Schema>;

// ─── 事实输入（服务端读出来的东西；纯函数据此投影，不自己查库）────────────

/** 投影三轴要的那些事实。**全部可选**：缺哪一档就落哪一档的空值，不许互相顶。 */
export interface NoteAxisFactsV3 {
  /** 真实学习记录条数（只用来分"有没有"，不参与任何比例运算）。 */
  readonly recordCount: number;
  /** 独立作答过（不经提示）过几次。 */
  readonly independentCount: number;
  /** 借助（提示／演示）完成过几次。 */
  readonly assistedCount: number;
  /** 独立作答落在几个不同的自然日上——"跨时间有重复证据"问的是**跨日**。 */
  readonly independentDayCount: number;
  /** 本人是否明确把这条路停下了（review hold / 暂停轮次）。 */
  readonly paused: boolean;
  /** 有没有没走完的一轮（有 `activeRunId` 或 open round）。 */
  readonly openJourney: boolean;
  /** 有没有到期该回访的。 */
  readonly reviewDue: boolean;
  /** 目标表里有没有"要补学"那一类（needs_repair / fragile / outdated）。 */
  readonly needsRelearn: boolean;
  /** 材料适用性：已失效 / 待核对 / 无权限，都没有就落 `basis_holds`。 */
  readonly basis: "holds" | "updated" | "needs_check" | "no_permission";
}

/**
 * 三轴投影（§11.4 那张表的读法，纯函数）。
 *
 * **两条纪律，都是"不合成"的那半句：**
 *  - **不看数量大小，只看有没有**。`recordCount` 参与的唯一一件事是"是不是零"。
 *    1 条记录与 400 条记录落在**同一档**——这正是"不用卡片数、证据条数、阅读时长
 *    或模型推断比例画理解百分比"在实现层的形状：函数里没有除法。
 *  - **三档互不影响**。轴二说"该回访"不会把轴一改写成"没学会"（§11.4「到期就变成
 *    '不会'」）；轴三说"材料更新了"也不会把轴一改写成退步（「资料变化就是用户退步」）。
 */
export function deriveNoteStateAxesV3(facts: NoteAxisFactsV3): NoteStateAxesV3 {
  const performance = ((): NotePerformanceAxisV3 => {
    if (facts.recordCount <= 0) return "no_record_yet";
    if (facts.independentDayCount >= 2) return "repeated_over_time";
    if (facts.independentCount > 0) return "used_independently";
    if (facts.assistedCount > 0) return "assisted_once";
    return "met_once";
  })();
  const nextStep = ((): NoteNextStepAxisV3 => {
    // 「用户已暂停」排在最前：§11.4「用户已暂停」是**本人的决定**，任何到期或缺口
    // 都不许把它顶掉（否则"我先停一下"会在下一次到期时失效）。
    if (facts.paused) return "paused_by_user";
    if (facts.recordCount <= 0) return facts.openJourney ? "can_continue" : "nothing_to_do";
    if (facts.needsRelearn) return "suggest_relearn";
    if (facts.reviewDue) return "due_for_review";
    if (facts.openJourney) return "can_continue";
    return "nothing_to_do";
  })();
  return {
    performance,
    nextStep,
    applicability: facts.basis === "updated" ? "basis_updated"
      : facts.basis === "needs_check" ? "needs_check"
        : facts.basis === "no_permission" ? "no_permission"
          : "basis_holds",
  };
}

// ─── 层二：笔记局部（§11.2 第二行）───────────────────────────────────────

/** 「核心问题」：一条目标实际在追问什么。不是这一篇的目录，是**问句**。 */
export const noteDeepeningCoreQuestionV3Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  label: z.string().min(1).max(200),
  summary: z.string().min(1).max(1500),
});
export type NoteDeepeningCoreQuestionV3 = z.infer<typeof noteDeepeningCoreQuestionV3Schema>;

/** 「已形成的目标」：从这一篇的正文长出来、且此刻仍是他的一条主张。 */
export const noteDeepeningObjectiveV3Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  label: z.string().min(1).max(200),
  summary: z.string().min(1).max(1500),
  state: objectivePersonalStateV3Schema,
  /** 「打开某个学习位置」要用的那一把钥匙（打开目标 / 打开这一轮）。 */
  runId: z.string().uuid().nullable(),
  cardId: z.string().uuid().nullable(),
});
export type NoteDeepeningObjectiveV3 = z.infer<typeof noteDeepeningObjectiveV3Schema>;

/**
 * 「必要前置和明确关系」+「查看关系理由」（§11.2 第二行动作，§11.3）。
 *
 * **为什么理由与关系在一行里**：§11.2 把"查看关系理由"写成这一层的动作，理由
 * 不是另一条记录，它是**这条边为什么被推出来**的凭据。拆成两张表，屏上就得自己
 * 拼回去，而拼不上的那一行会变成一条没有理由的实线。
 */
export const noteDeepeningRelationV3Schema = z.strictObject({
  edgeId: z.string().min(1).max(200),
  otherObjectiveId: z.string().uuid(),
  otherLabel: z.string().min(1).max(200),
  relation: personalRelationKindV2Schema,
  /** 本人对这一条的态度（`relates_to` 那一族才有；血缘边不进这里）。 */
  status: z.enum(["confirmed", "dismissed", "suggested"]),
  /** §11.3「每条关系可以查看依据或确认来源」——屏上那一句"为什么"。 */
  reasonCodes: z.array(z.string().min(1)).max(10),
});
export type NoteDeepeningRelationV3 = z.infer<typeof noteDeepeningRelationV3Schema>;

/**
 * 「当前缺口」。
 *
 * **缺口是目标表里已经写着的那一档**（needs_repair / fragile / outdated / 还没碰过），
 * 不是从三轴折出来的一个数。§11.4「没有单一'整篇掌握亮度'」在层二的具体形状就是
 * 这里：列出来的是**哪一个目标**卡在哪一档，不是一句"整体 60%"。
 */
export const noteDeepeningGapV3Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  label: z.string().min(1).max(200),
  /** 这一条为什么算缺口——直接是目标状态的人话，不另算。 */
  state: objectivePersonalStateV3Schema,
});
export type NoteDeepeningGapV3 = z.infer<typeof noteDeepeningGapV3Schema>;

// ─── 层三：证据详情（§11.2 第三行）────────────────────────────────────────

/** 一条反馈。`verdict` 是评估器的判词，`reason` 是**给人看的那句**。 */
export const noteDeepeningFeedbackV3Schema = z.strictObject({
  verdict: z.enum(["covered", "partial", "missing", "contradicted", "not_assessable"]),
  reason: z.string().min(1).max(1000),
});
export type NoteDeepeningFeedbackV3 = z.infer<typeof noteDeepeningFeedbackV3Schema>;

/** 「材料依据」：这一条凭什么被记下来。空数组＝真的没有材料，不是"忘了读"。 */
export const noteDeepeningMaterialV3Schema = z.strictObject({
  evidenceSnapshotId: z.string().uuid(),
  supportSummary: z.string().min(1).max(2000),
});
export type NoteDeepeningMaterialV3 = z.infer<typeof noteDeepeningMaterialV3Schema>;

/**
 * 一条**真实**学习记录（§11.2 第三行的五格）。
 *
 * `answerText` 可以是 `null`：**结构化作答**（排序、配对、选择）没有一句可念的
 * 回答。把它写成 `"用户选择了 B"` 就是让屏上多一句系统自己造的句子——所以那一格
 * 如实是 `null`，`answerForm` 说清它是哪一种。
 */
export const noteDeepeningRecordV3Schema = z.strictObject({
  recordId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  objectiveId: z.string().uuid().nullable(),
  /**
   * 挂到哪一条目标上。`null` 是**可能**的（一次练习没有 origin 目标），那一格
   * 如实是 `null`——屏上写"这一步没有挂到具体目标上"是事实，补一句"未标注的
   * 目标"就不是了。
   */
  objectiveLabel: z.string().min(1).max(200).nullable(),
  answerForm: z.enum(["prose", "voice_transcript", "structured", "none"]),
  answerText: z.string().min(1).max(20_000).nullable(),
  feedback: z.array(noteDeepeningFeedbackV3Schema).max(8),
  /** 「日期」。是**这一次作答**的落库时刻，不是渲染那一刻。 */
  occurredAt: z.string().datetime({ offset: true }),
  materialBasis: z.array(noteDeepeningMaterialV3Schema).max(8),
  /** 「可选卡片」——§11.2 把它写成可选项，所以 `null` 是常态。 */
  cardId: z.string().uuid().nullable(),
});
export type NoteDeepeningRecordV3 = z.infer<typeof noteDeepeningRecordV3Schema>;

// ─── 整份读（层一由拓扑投影，这里是层二＋层三）───────────────────────────

/**
 * 一篇笔记的向下展开。
 *
 * **`strictObject` 承担一条纪律**：这份读里不出现任何"整篇掌握"标量。将来谁想加
 * 一个 `masteryScore`，解析层当场红。
 */
export const noteDeepeningV3Schema = z.strictObject({
  version: z.literal(3),
  noteId: z.string().uuid(),
  noteTitle: z.string().min(1).max(500),
  /** §11.2「有正文的笔记无需制卡即可出现」：这一格记的是**有没有正文**。 */
  hasBody: z.boolean(),
  sourceId: z.string().uuid().nullable(),
  axes: noteStateAxesV3Schema,
  local: z.strictObject({
    /** §11.2 第四行那句话"本轮问题"——未完的那一轮的问题句；没有就空。 */
    openDrivingQuestion: z.string().min(1).max(1000).nullable(),
    coreQuestions: z.array(noteDeepeningCoreQuestionV3Schema).max(200),
    objectives: z.array(noteDeepeningObjectiveV3Schema).max(200),
    relations: z.array(noteDeepeningRelationV3Schema).max(400),
    gaps: z.array(noteDeepeningGapV3Schema).max(200),
  }),
  records: z.array(noteDeepeningRecordV3Schema).max(200),
  /**
   * §11.5「只有拿到完整计数才展示全量总数，截断数据明确说明」。
   *
   * `false` 时屏上**不许**报"一共 N 条"——那个 N 是本页条数冒充的总数。
   */
  recordsComplete: z.boolean(),
});
export type NoteDeepeningV3 = z.infer<typeof noteDeepeningV3Schema>;

// ─── 纯投影：事实 → 合同（§11.2「不伪造内部要点与关系」的执法点）──────────

export interface NoteDeepeningInputV3 {
  readonly noteId: string;
  readonly noteTitle: string;
  readonly hasBody: boolean;
  readonly sourceId: string | null;
  readonly openDrivingQuestion: string | null;
  readonly objectives: readonly NoteDeepeningObjectiveV3[];
  readonly relations: readonly NoteDeepeningRelationV3[];
  readonly records: readonly NoteDeepeningRecordV3[];
  readonly recordsComplete: boolean;
  /** 轴一需要的三样：独立次数、借助次数、独立作答落在几个自然日。 */
  readonly independentCount: number;
  readonly assistedCount: number;
  readonly independentDayCount: number;
  readonly paused: boolean;
  readonly reviewDue: boolean;
  readonly basis: NoteAxisFactsV3["basis"];
}

/** §11.4「下一步：到期就变成'不会'」的反面——哪些目标算"当前缺口"。 */
const GAP_STATES = new Set<ObjectivePersonalStateV3>([
  "needs_repair", "fragile", "outdated",
]);

/**
 * 把服务端读出来的事实投影成一份合同。
 *
 * **唯一一处"删东西"的地方**（`dismissed` 的关系不进层二）：§11.3「用户可纠正或
 * 隐藏建议关系」。被收起的那条还在拓扑里（收的是**本人的视图**，不是公共关系），
 * 但它不该继续在"这一篇里有哪些关系"这一层占一行。
 */
export function buildNoteDeepeningV3(input: NoteDeepeningInputV3): NoteDeepeningV3 {
  const objectives = input.objectives.map((objective) => ({ ...objective }));
  const relations = input.relations
    .filter((relation) => relation.status !== "dismissed")
    .map((relation) => ({ ...relation }));
  const records = input.records.map((record) => ({ ...record }));
  const openJourney = objectives.some((objective) => objective.runId !== null)
    || input.openDrivingQuestion !== null;
  const axes = deriveNoteStateAxesV3({
    recordCount: records.length,
    independentCount: input.independentCount,
    assistedCount: input.assistedCount,
    independentDayCount: input.independentDayCount,
    paused: input.paused,
    openJourney,
    reviewDue: input.reviewDue,
    needsRelearn: objectives.some((objective) => GAP_STATES.has(objective.state)),
    basis: input.basis,
  });
  return noteDeepeningV3Schema.parse({
    version: 3 as const,
    noteId: input.noteId,
    noteTitle: input.noteTitle,
    hasBody: input.hasBody,
    sourceId: input.sourceId,
    axes,
    local: {
      openDrivingQuestion: input.openDrivingQuestion,
      // 「核心问题」就是这些目标在问什么——不是另外编的一组句子。零目标时这里是空数组。
      coreQuestions: objectives.map((objective) => ({
        objectiveId: objective.objectiveId,
        label: objective.label,
        summary: objective.summary,
      })),
      objectives,
      relations,
      gaps: objectives
        .filter((objective) => GAP_STATES.has(objective.state))
        .map((objective) => ({
          objectiveId: objective.objectiveId,
          label: objective.label,
          state: objective.state,
        })),
    },
    records,
    recordsComplete: input.recordsComplete,
  });
}
