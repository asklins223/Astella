/** Strict, sanitized Review queue consumed by the Member V2 desktop slice. */

import { z } from "zod";

const cursorV2Schema = z.string().min(1).max(128);
/**
 * 排期那一族共用的时间形状（队列、延后、单次提醒）。导出而不是各抄一份：
 * 这三处对"带时区的 ISO 串"的收紧程度必须一样，抄开之后改一处就会安静地放过另一种。
 */
export const isoTimestampV2Schema = z.string().datetime({ offset: true });

/**
 * 到期队列只会返回「已到期」的排期（`nextReviewAt <= now()`，见
 * apps/api/src/modules/review/service.ts 的 listReviews），所以唯一可能挡在
 * 开始之前的条件是方案 16 的「无辅助冷却期」。早先列出的 not_due /
 * stale_generation / invalid_identity / feature_unavailable 没有任何生产者，
 * 已删除，避免前端为不存在的状态维护文案与分支。
 */
export const reviewQueueStartabilityV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("blocked"), reason: z.literal("cooldown") }),
]);
export type ReviewQueueStartabilityV2 = z.infer<typeof reviewQueueStartabilityV2Schema>;

/**
 * 审计 F28：这条目标的正式验证**没有可比的原文证据**。
 *
 * 它与 `startability: cooldown` 是两件事，所以不塞进同一个枚举：冷却说的是
 * "现在还不能开始"，等一会儿就变了；证据缺口说的是"这条目标现在判不出结论"，
 * 靠等和靠用户补充都不会变——`run-processing-tick.ts` 的结算闸会因为
 * `task rubric has no frozen evidence` fail closed，实机两题各 39 毫秒空判。
 *
 * 队列把缺哪些评分点一起下发，界面才能指名缺口；`missingRubricUnitIds` 为空
 * 表示"评分点读不出来"（历史双重编码行），那种情况同样不能正式验证。
 */
export const reviewQueueFormalValidationBlockedV2Schema = z.strictObject({
  reason: z.literal("evidence_gap"),
  missingRubricUnitIds: z.array(z.string().min(1)).max(80),
});
export type ReviewQueueFormalValidationBlockedV2 = z.infer<
  typeof reviewQueueFormalValidationBlockedV2Schema
>;

export const reviewQueueItemV2Schema = z.strictObject({
  version: z.literal(2),
  reviewId: z.string().uuid(),
  scheduleId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  /** 有卡目标是卡 id；无卡笔记目标为 null，仍按 objectiveId 消费同一条日程。 */
  cardId: z.string().uuid().nullable(),
  scheduleGeneration: z.number().int().min(1),
  dueAt: isoTimestampV2Schema,
  startability: reviewQueueStartabilityV2Schema,
  /**
   * null = 这条目标的评分点都有冻结证据，正式验证能形成结论。
   * 非 null = 结算必然 fail closed，界面必须说清"不是你答得不好"。
   */
  formalValidationBlocked: reviewQueueFormalValidationBlockedV2Schema.nullable(),
});
export type ReviewQueueItemV2 = z.infer<typeof reviewQueueItemV2Schema>;

export const reviewQueueV2Schema = z.strictObject({
  version: z.literal(2),
  items: z.array(reviewQueueItemV2Schema).max(100),
  /**
   * 服务端确认的到期项总数（当前筛选条件下的 count），与已返回的 items 无关。
   * 卡叠用它显示「共 N 张」，因此不必把整条队列读进内存才能说出真实规模。
   */
  total: z.number().int().min(0),
  nextCursor: cursorV2Schema.nullable(),
});
export type ReviewQueueV2 = z.infer<typeof reviewQueueV2Schema>;

/**
 * 方案 16 §18.1/§18.3 的展示层延后：只写 user_deferred_until，不改 official
 * nextReviewAt、不消费 schedule。generation 是乐观令牌，不匹配即为过期。
 */
export const reviewDeferRequestV2Schema = z.strictObject({
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  deferredUntil: isoTimestampV2Schema,
  reasonCode: z.enum(["user_requested", "temporary_unavailable"]),
});
export type ReviewDeferRequestV2 = z.infer<typeof reviewDeferRequestV2Schema>;

export const reviewDeferResultV2Schema = z.strictObject({
  version: z.literal(2),
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  userDeferredUntil: isoTimestampV2Schema,
  officialNextReviewAt: isoTimestampV2Schema,
});
export type ReviewDeferResultV2 = z.infer<typeof reviewDeferResultV2Schema>;

// ─── W7-3 刀三：目标级「暂不安排」的屏上回执（39 §9.1 行 2、行 3）──────────
//
// **请求体**不在这儿再写一份：服务端已经用 `holdObjectiveRequestV2Schema` /
// `resumeObjectiveRequestV2Schema` 校验过（那是执法点），桌面这一层再抄一份
// 就多一个会分叉的地方。要抄的只有**回执**——回执必须有一份 zod 形状让网关
// `safeParse`，否则"服务端改了什么字段"永远没人先发现。
//
// 两种说法必须分开的原因写在字段注释里，不是洁癖：`alreadyHeld: false` 与
// `released: false` 都意味着"这次没有发生改变"，而屏上该念的话不一样
// （"已经安排好了" vs "本来就没有在暂不安排中"）。

/** `POST /reviews/v2/objectives/hold` 的回执。 */
export const objectiveHoldResultV2Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  noteId: z.string().uuid(),
  /**
   * 已经是活着的排除 ⇒ 这一发只是把原来那条交回。屏上要说"本来就在暂不安排中"，
   * 不能说成"刚刚设好了"——§9.1 那颗按钮连点两下不该让人以为它改了什么。
   */
  alreadyHeld: z.boolean(),
  /**
   * 立排除时顺手撤下的、这个目标**此刻待处理**的那些待办条数。
   * 屏上要把这个数念出来（§9.1：立排除要有看得见的后果），所以服务端在
   * `holdObjectiveFromReviewV2` 里一并回，而不是让界面自己猜。
   */
  dismissedPendingSchedules: z.number().int().min(0),
});
export type ObjectiveHoldResultV2 = z.infer<typeof objectiveHoldResultV2Schema>;

/** `POST /reviews/v2/objectives/resume` 的回执。 */
export const objectiveResumeResultV2Schema = z.strictObject({
  version: z.literal(2),
  objectiveId: z.string().uuid(),
  /**
   * 解除掉了一条活行？`false` = 本来就没在排除中——但**排上**了仍要说排上，
   * 这两件事在回执里是两个字段，不合成一句"已恢复"。
   */
  released: z.boolean(),
  /**
   * 排期的三种结果分两档回执：新建 / 沿用库里已有的那一格。第三种
   * （`still_held`）不是 200，是 409，桌面那一层把它当失败处理。
   * `reused_existing` 的到期时间取**库里那一条**的（边界回读），不是客户端算的。
   */
  scheduled: z.enum(["created", "reused_existing"]),
  scheduleId: z.string().uuid(),
  nextReviewAt: isoTimestampV2Schema,
});
export type ObjectiveResumeResultV2 = z.infer<typeof objectiveResumeResultV2Schema>;

/**
 * 桌面侧要发的**两条请求体**。与服务端那份同形（`holdObjectiveRequestV2Schema` /
 * `resumeObjectiveRequestV2Schema`），但在这里另起一个名字而不是直接引那两份：
 * IPC 合同是渲染层唯一看得见的形状，它必须自带一份，缺字段时渲染层先红，
 * 而不是等到运行时从主进程报一个没有上下文的 400。
 *
 * 两条都带 `noteId`，理由是服务端那一发要按笔记判可见性（`resumeObjectiveRequestV2Schema`
 * 的 `noteId` 自 2026-09-27 起必填）。渲染层传的是**屏幕上那一篇**的 id，
 * 不给界面自造一个"当前笔记"的概念。
 */
export const objectiveHoldCommandV2Schema = z.strictObject({
  noteId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  /** 界面上选的因由；省略＝服务端默认那一档。 */
  reasonCode: z.string().min(1).max(120).optional(),
});
export type ObjectiveHoldCommandV2 = z.infer<typeof objectiveHoldCommandV2Schema>;

export const objectiveResumeCommandV2Schema = z.strictObject({
  noteId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  releaseReason: z.string().min(1).max(120).optional(),
});
export type ObjectiveResumeCommandV2 = z.infer<typeof objectiveResumeCommandV2Schema>;

// ─── W7-3 刀六：订阅来源分别开停的屏上合同（39 §9.1 第一段与规则表行 1）──
//
// **两条命令而不是一颗 toggle**：§9.1 明写「两种意图可以分别存在」，规则表行 1
// 写的是「暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该授权来源**」。合成一颗开关会把
// "停哪一个"变成系统的默认，而那正是"偷偷联动"。
//
// `stillCoveredBy` 是这一族存在的理由（规则表行 1「其他来源仍有效时**显示原因**」）：
// 停掉笔记订阅而那张卡还单独开着时，屏上必须说"仍由卡片复习继续安排"。**空数组
// 与非空数组是两句话**，所以它是一个字段而不是一个布尔——布尔会让"还有别人撑着"
// 与"没有人撑着了"在界面上说成同一句。

/** 授权来源的词表。与服务端 `REVIEW_SUBSCRIPTION_SUBJECT_TYPE` 同源，不另抄一份。 */
export const reviewAuthorizationSourceV2Schema = z.enum(["note_subscription", "card_review"]);
export type ReviewAuthorizationSourceV2Wire = z.infer<typeof reviewAuthorizationSourceV2Schema>;

/** 主体类型：`note` 是整篇笔记的订阅，`objective` 是那颗目标的卡片订阅。 */
export const reviewSubscriptionSubjectTypeV2Schema = z.enum(["note", "objective"]);
export type ReviewSubscriptionSubjectTypeV2 = z.infer<typeof reviewSubscriptionSubjectTypeV2Schema>;

/** 两条命令共用的请求体（`subjectId` 按 `source` 判它该是笔记还是目标）。 */
export const reviewSubscriptionCommandV2Schema = z.strictObject({
  source: reviewAuthorizationSourceV2Schema,
  subjectId: z.string().uuid(),
  /** 开启时那句话（§9.1「开启时用一句话说明这个持续范围」）。停用时可省。 */
  scopeNote: z.string().min(1).max(500).optional(),
  reasonCode: z.string().min(1).max(120).optional(),
});
export type ReviewSubscriptionCommandV2Wire = z.infer<typeof reviewSubscriptionCommandV2Schema>;

export const reviewSubscriptionV2Schema = z.strictObject({
  source: reviewAuthorizationSourceV2Schema,
  subjectType: reviewSubscriptionSubjectTypeV2Schema,
  subjectId: z.string().uuid(),
  status: z.enum(["active", "paused"]),
  scopeNote: z.string().min(1).max(500),
  createdAt: isoTimestampV2Schema,
  pausedAt: isoTimestampV2Schema.nullable(),
});
export type ReviewSubscriptionV2Wire = z.infer<typeof reviewSubscriptionV2Schema>;

/**
 * 两条命令的回执**同形**——这不是偷懒，是 §9.1 行 1 的形状：开与停是同一份授权
 * 的两个动作，屏上要回答的是同一个问题（「现在是什么状态、还有什么在撑着」）。
 * 分成两个 schema 只会让两处各写一遍那三个字段。
 */
export const reviewSubscriptionResultV2Schema = z.strictObject({
  subscription: reviewSubscriptionV2Schema,
  /** 这次是真的开了/停了，还是本来就在那一档。连点两下不该让人以为它改了什么。 */
  changed: z.boolean(),
  /** 空数组 = 这一份不再被安排；非空 = 仍由这些来源撑着（屏上要把它们念出来）。 */
  stillCoveredBy: z.array(reviewAuthorizationSourceV2Schema),
});
export type ReviewSubscriptionResultV2Wire = z.infer<typeof reviewSubscriptionResultV2Schema>;

/** 笔记那一屏的读侧：订阅了哪几篇，**连暂停的也列**——开关要能拨回"开"。 */
export const noteReviewSubscriptionsV2Schema = z.strictObject({
  version: z.literal(2),
  items: z.array(reviewSubscriptionV2Schema),
});
export type NoteReviewSubscriptionsV2Wire = z.infer<typeof noteReviewSubscriptionsV2Schema>;

/**
 * 首页「只推一件」的五层合同（39d W7-4 刀六；39 §12.1）。
 *
 * ## 为什么单独一份 wire 而不是直接用纯函数的类型
 *
 * `decideHomeSuggestionV2` 的返回里 `kind` 是**可辨联合**，而屏上要按 `kind` 分成两棵
 * 完全不同的树（有建议 ⇒ 一张便签；没建议 ⇒ 三个入口）。让渲染层**先**解成 union 会
 * 让"忘了判 `kind`"变成运行时事故而不是类型错误——所以这里把两档**显式**列成两个
 * schema，`kind` 用 `literal` 钉死。
 *
 * ## 「换一个」返回的是**下一件**，不是"请再读一次"
 *
 * 屏上按一下「换一个」，要立刻看到**另一件**，而不是"空一下再刷"。所以这一发的回执
 * 交回**已经算好的下一件**（判据在服务端跑完），渲染层不重排。
 */
export const homeSuggestionWireV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("suggested"),
    /** 判据选出来的那一件（§12.1「只推荐一件」）。 */
    itemKey: z.string().min(1),
    kindOfItem: z.enum(["user_named", "unfinished_run", "authorized_review"]),
    headline: z.string().min(1),
    /** §12.1「推荐附一句理由」——**必填且非空**：空理由就是一句没有出处的断言。 */
    reasonLine: z.string().min(1),
    /** 同档里还有几件可换。0 ⇒ 那颗「换一个」**不画**，而不是画一颗按了没反应的。 */
    swappableCount: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("nothing_due"),
    /**
     * §12.1「没有到期需求不制造"今日任务"」——这一档给的是**入口**，不是建议。
     * 空数组也是合法读数（那三件事都用不了时）。
     */
    emptyActions: z.array(z.enum(["new_note", "write_from_source", "resume_reading"])),
  }),
]);
export type HomeSuggestionWireV2 = z.infer<typeof homeSuggestionWireV2Schema>;

/** 「换一个」/「暂不处理」两个动作的命令。两颗按钮共用一个 schema 而不各写一份。 */
export const homeSuggestionActionCommandV2Schema = z.strictObject({
  itemKey: z.string().min(1),
  action: z.enum(["swapped", "dismissed"]),
  timeZone: z.string().min(1),
});
export type HomeSuggestionActionCommandV2 = z.infer<typeof homeSuggestionActionCommandV2Schema>;

/** 两个动作的回执：**顺带**交回下一件，省掉渲染层再发一次读。 */
export const homeSuggestionActionResultV2Schema = z.strictObject({
  action: z.enum(["swapped", "dismissed"]),
  /** 记下去之后**现在**该推的那一件；`nothing_due` 时就是空态。 */
  suggestion: homeSuggestionWireV2Schema,
});
export type HomeSuggestionActionResultV2 = z.infer<typeof homeSuggestionActionResultV2Schema>;

/**
 * 今日复习那三个动作的五层合同（39d W7-4 刀十二；39 §12 表「今日复习」行）。
 *
 * ## 三个动作**共用一个 schema**
 *
 * 减量／暂停／恢复只差 `action` 那一档与屏上的文案，而分成三个入口就是三处会分叉
 * ——其中一处很可能忘了把 `remaining` 原样带回判据（刀十那一格正是在防这个）。
 *
 * ## 回执交回**读出来的那一句**
 *
 * §12 表第三列最后那半句是「**剩余需求不伪称完成**」。这一句由服务端按真读数生成，
 * 渲染层**原样念**——渲染层自己拼的话，迟早有一处忘了带「剩下 N 道」。
 */
export const todayBatchOptionCommandV2Schema = z.strictObject({
  action: z.enum(["reduce", "pause", "resume"]),
  /** `action: "reduce"` 时才看它；<= 0 视为 0（不是"重算今天该有多少道"）。 */
  reduceBy: z.number().int().min(0).optional(),
  timeZone: z.string().min(1),
});
export type TodayBatchOptionCommandV2 = z.infer<typeof todayBatchOptionCommandV2Schema>;

export const todayBatchOptionResultV2Schema = z.strictObject({
  action: z.enum(["reduce", "pause", "resume"]),
  /** 改完之后今天这一批锁定的新长度（**暂停那一档不变**——长度是记录，不是当前值）。 */
  lockedLength: z.number().int().min(0),
  paused: z.boolean(),
  /** §12 表「剩余需求不伪称完成」——三档都原样带出去。 */
  remaining: z.number().int().min(0),
  /** 屏上那一行的**读法**，由服务端按真读数生成。 */
  screenLine: z.string().min(1),
});
export type TodayBatchOptionResultV2 = z.infer<typeof todayBatchOptionResultV2Schema>;

/**
 * 今日复习那一批的读侧 wire（39d W7-4 刀十四；39 §12 表「今日复习」行）。
 *
 * ## 为什么**逐项**带 `reasonLine`
 *
 * 那一行第二列写的是「一批有限任务，**展示选择原因**」。「展示」两个字是判据：屏上
 * 必须能说出**每一道为什么在这一批里**，而不是只说"你有 5 道"。所以 wire 逐项带理由，
 * 而不是一个笼统的批次说明。
 *
 * ## `deferredCount` 单独一列
 *
 * §9.4 末段「系统结束本批后可以看到『今天先到这里；另外还有可回访内容』」。那个数
 * **必须**由服务端给（判据的 `deferredCount`），渲染层自己数就是"屏上编一个数"。
 */
export const todayBatchWireV2Schema = z.strictObject({
  /** 本批的项。**长度由锁定规则决定**，不由"现在有多少到期"决定。 */
  items: z.array(z.strictObject({
    objectiveId: z.string().uuid(),
    /** 它为什么在这一批里（到期／轮换抽查）——屏上要念出来。 */
    reason: z.enum(["due_now", "rotation_stale", "user_asked_more"]),
    reasonLine: z.string().min(1),
  })),
  /** 本批**开始时**锁的长度。 */
  lockedLength: z.number().int().min(0),
  /** §9.4 末段那个数：没进这一批、但可以回访的还有多少。 */
  deferredCount: z.number().int().min(0),
  /** 今天这一批现在**停着**吗（0307 那一列）。停着时屏上画「接着做」而不是「先停一下」。 */
  paused: z.boolean(),
});
export type TodayBatchWireV2 = z.infer<typeof todayBatchWireV2Schema>;
