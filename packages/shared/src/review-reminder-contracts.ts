/**
 * 「仅提醒这一次」的线上形状（39d W5-4 刀一；39 §9.1 末段与 §16.24）。
 *
 * 这一对请求/回执与 `review-queue-v2-contracts.ts` 的延后那一对是**同一族但不同件事**，
 * 分开放是有意的：
 *
 *  - 延后（`reviewDeferRequestV2Schema`）只改展示层的时间列，schedule 还在队列里。
 *  - 处理单次提醒（`acknowledgeOneTimeReminderV2Schema`）**把这一条关掉**，而且此后
 *    不会再长出下一次。两件事在界面上都长成"那颗提醒我不想要了"，规则表里却是两行。
 *
 * 为什么"关闭"必须是一个**显式命令**而不是别处的副产物：§16.24 的验收是"打开通知和
 * 部分学习不默认关闭提醒"。今天所有会碰到这张表的动作里，结算（消费掉那一条）与
 * 「暂不安排」（撤下待处理）都在 `review_schedules` 之外另有归属；把关闭做成它们的一个
 * 分支，就等于允许"学了一半"悄悄把提醒结掉——那正是 §9.1「提醒的处理与学习判定分开」
 * 要挡的事。所以它只有这一个入口，入口自己也不写任何学习观察。
 */
import { z } from "zod";
import { isoTimestampV2Schema } from "./review-queue-v2-contracts.ts";

/** 一次提醒的两种来意（`review_schedules.reminder_kind` 的线上同形）。 */
export const reviewReminderKindV2Schema = z.enum(["one_time", "sustained"]);
export type ReviewReminderKindV2 = z.infer<typeof reviewReminderKindV2Schema>;

/**
 * 立一条「仅提醒这一次」。
 *
 * `noteId` 不是用来排期的，而是**排完之后要让人知道这条挂在哪**（§16.24 走完一轮后
 * 从结果页处理提醒时，界面得能回笔记）。它由服务端读可见性，客户端给错时返回 404 而不是
 * 409——与 `holdObjectiveFromReviewV2` 的 `ObjectiveHoldNoteNotFoundV2` 同一档处理。
 */
export const requestOneTimeReminderV2Schema = z.strictObject({
  noteId: z.string().uuid(),
  /** 可确认的目标 id。笔记还没有目标时，§9.1 说的"只保留一个明确的初次回访提醒"另开一刀。 */
  objectiveId: z.string().uuid(),
  /** 用户自己选的那一天；服务端只校验"在未来"，不替她挑。 */
  dueAt: isoTimestampV2Schema,
  // 刻意**没有** `reviewDimension`：0287 那把唯一键带着维度，而读侧有 21 处还不认识它
  // （`review-schedule-single-writer.test.ts` 的读侧台账逐条登记）。第一个传维度的人必须
  // 先处理那批读点——那枚触发器就是为此存在的，这里不抢它。维度是 W7-5 的杠杆。
});
export type RequestOneTimeReminderV2 = z.infer<typeof requestOneTimeReminderV2Schema>;

/**
 * 立一条单次提醒的回执。
 *
 * `created: false` 与 `mergedIntoSustained` 必须分开说：前者是"这一格已经排着了"，
 * 后者是"已经排着的那条**不是**一次性的"——后者意味着用户点的「仅提醒这一次」并没有
 * 变成一次性的，而这正是 §9.1 末段那句话（"前者处理后不自动产生后续提醒"）在数据上
 * 第一次能被读出来的地方。把两者合成一个布尔，那句授权差异就永远只存在于文案里。
 */
export const requestOneTimeReminderResultV2Schema = z.strictObject({
  version: z.literal(2),
  scheduleId: z.string().uuid(),
  /** 库里那一条的**实际**到期时间；复用别人已排好的安排时不是自己算的那个。 */
  dueAt: isoTimestampV2Schema,
  reminderKind: reviewReminderKindV2Schema,
  created: z.boolean(),
  /** 被目标级「暂不安排」挡下 ⇒ 库里什么都没写。 */
  held: z.boolean(),
});
export type RequestOneTimeReminderResultV2 = z.infer<typeof requestOneTimeReminderResultV2Schema>;

/**
 * 关掉一条单次提醒（§9.1：「用户部分结束时保留提醒，在结果页提供处理或延后选择」——
 * 延后走 `reviewDeferRequestV2Schema`，处理走这一条）。
 *
 * `scheduleGeneration` 是乐观令牌（与延后同一形状）：提醒在别的窗口被处理或改期之后，
 * 这一发要拿到 409 而不是把新状态按旧的意图改掉（§16.31 同一条纪律）。
 */
export const acknowledgeOneTimeReminderV2Schema = z.strictObject({
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
});
export type AcknowledgeOneTimeReminderV2 = z.infer<typeof acknowledgeOneTimeReminderV2Schema>;

export const acknowledgeOneTimeReminderResultV2Schema = z.strictObject({
  version: z.literal(2),
  scheduleId: z.string().uuid(),
  scheduleGeneration: z.number().int().min(1),
  /** 库里那一行**现在**的到期时间；已经关掉的那一条照实回它原来的日期。 */
  dueAt: isoTimestampV2Schema,
  /**
   * 已经是 `completed` 且 reason 就是这一次处理 ⇒ 重放同一发，回执原样交回。
   * §9.6「迟到与重放不重复计学习」的形状：幂等靠**读出那一行的事实**判定，不靠记忆。
   */
  alreadyAcknowledged: z.boolean(),
});
export type AcknowledgeOneTimeReminderResultV2 = z.infer<typeof acknowledgeOneTimeReminderResultV2Schema>;

/**
 * Member 对已有共享卡开启**本人**个人复习的请求（W5-6 刀四；§14.4、§16.20）。
 *
 * 与上面那对「仅提醒这一次」是同一族的另一件事，形状刻意保持一致：都只带一个主体 id ＋
 * 一个可选维度 ＋ 一个乐观理由，不带"日期"也不带"策略"——间隔由服务端按策略头一档给，
 * 因为"开启"不是一次观察（§9.2 三种事实分开），客户端报一个日期上来反而会变成
 * "用户自己挑的间隔"那种没有出处的数字。
 */
export const startSharedCardPersonalReviewV2Schema = z.strictObject({
  cardId: z.string().uuid(),
  // 刻意**没有** reviewDimension：唯一键带着维度，而读侧有 21 处还不认识它。第一版带上了，
  // 立刻被 `review-schedule-single-writer.test.ts` 的那枚触发器判红——那枚守卫就是干这个的。
});
export type StartSharedCardPersonalReviewV2 = z.infer<typeof startSharedCardPersonalReviewV2Schema>;
