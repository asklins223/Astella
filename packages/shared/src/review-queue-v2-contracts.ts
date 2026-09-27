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
  /**
   * 审计 F04：这张排程**属于哪一张卡**。此前 DTO 只带 `objectiveId`，于是"一个目标
   * 多张卡"与"同一张卡被排了多条"在界面上长得一样——实机就被读成了"三张卡分不清"
   * （量下来其实是同一张卡的 6 条夹具排程）。有了它，卡面至少能说清"这两条是同一张卡"。
   */
  cardId: z.string().uuid(),
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
