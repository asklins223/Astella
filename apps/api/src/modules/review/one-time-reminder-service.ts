/**
 * 「仅提醒这一次」的两条命令（39d W5-4 刀一；39 §9.1 末段与 §16.24）。
 *
 * 这一对服务只做两件事，且都刻意**不**做几件事，先把边界写清楚，免得后来的人把它们
 * 当成"顺便也能做"：
 *
 *  - **不做**排期决策（哪天提醒、间隔多少）。建立/关联待处理安排只有唯一调度边界一个
 *    入口（`ensurePendingReviewScheduleV2`，0287 那把部分唯一索引），这里只是它的一个
 *    调用方，并按约定把库里的实际读数原样交回。
 *  - **不做**学习判定。关闭一条单次提醒是**安排回执**，不是活动回执也不是能力证据
 *    （§9.2 三种事实分开；§9.1 末段"提醒的处理与学习判定分开"）。所以下面两个函数
 *    一个字都不写 `learning_*` 那几张表——判据在 `one-time-reminder-service.test.ts`
 *    里按源码形状钉住，不靠注释。
 *  - **不做**"部分学完顺手关掉提醒"。§16.24 的验收是"打开通知和部分学习不默认关闭
 *    提醒"，所以关闭只有一个显式入口；完成那一轮活动后由谁来关，归 W5-4 刀二
 *    （它要接结算那条链，而那条链此刻有并行会话在途）。
 */
import { REVIEW_DIMENSION_VALUES_V2 } from "@ailearn/shared/review-dimension-v2";
import { and, eq } from "drizzle-orm";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import type { ApiTransaction } from "../../db/client.ts";
import { ensurePendingReviewScheduleV2 } from "./review-schedule-boundary.ts";
import { visibleNotesCondition } from "../note/visibility.ts";
import { notes } from "@ailearn/shared/db-schema/note";

/** 关闭单次提醒时写进 `reason_code` 的那一档；也是"这一条是被处理掉的"的唯一标记。 */
export const ONE_TIME_REMINDER_ACKNOWLEDGED_REASON = "user_acknowledged_one_time";
/** 立一条单次提醒时写进 `reason_code` 的那一档。 */
export const ONE_TIME_REMINDER_REQUESTED_REASON = "user_requested_one_time";

/** 笔记不在本人书房里；这一档要能被路由翻成 404，而不是 500 或 409。 */
export class OneTimeReminderNoteNotFoundV2 extends Error {
  constructor() {
    super("note_not_found");
  }
}

export interface OneTimeReminderScope {
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * 关一条单次提醒的判决。**纯函数**——不碰库，所以五种结局各自能造样本，
 * 不用去数据库里造出"并发已处理"那种形状。
 *
 * `already_acknowledged` 那一档是重放：同一发点两次、或两个窗口同时点，第二次要交回与
 * 第一次**同一份**回执（§9.6"迟到与重放不重复计学习"的形状）。判据是"读出来的这一行
 * 已经是终态且 reason 就是这一次处理"，不是进程内的记忆——后者在多窗口下必然判错。
 */
export type AcknowledgeDecisionV1 =
  | { readonly action: "acknowledge" }
  | { readonly action: "already_acknowledged" }
  | { readonly action: "not_found" }
  | { readonly action: "stale_generation" }
  | { readonly action: "not_pending" }
  | { readonly action: "not_one_time" };

export interface AcknowledgeSubjectV1 {
  readonly status: string;
  readonly generation: number;
  readonly reminderKind: "one_time" | "sustained";
  readonly reasonCode: string | null;
}

export function decideAcknowledgeOneTimeReminderV1(
  subject: AcknowledgeSubjectV1 | null,
  input: { readonly scheduleGeneration: number },
): AcknowledgeDecisionV1 {
  if (!subject) return { action: "not_found" };
  // 先看终态：一条已经被处理掉的单次提醒，重放要交回同一份回执，而不是 409——
  // "关闭"不是可以失败的写操作，它有确定的幂等形状。
  if (subject.status === "completed" && subject.reasonCode === ONE_TIME_REMINDER_ACKNOWLEDGED_REASON) {
    return { action: "already_acknowledged" };
  }
  // 乐观令牌在这一步之后判：一条已经关掉的提醒无论客户端拿着几代令牌，都归上一档，
  // 不该被"版本旧了"盖掉（那会让重放看起来像冲突，调用方去提示"请刷新"）。
  if (subject.generation !== input.scheduleGeneration) return { action: "stale_generation" };
  if (subject.status !== "pending") return { action: "not_pending" };
  // 持续安排的那一条**不许**用这条命令关掉：那是取消订阅，而 §9.1 把它归在"暂停/移除
  // 订阅只停用该授权来源"那一行，有自己的入口和自己的回执。把两种混在一起，用户想
  // "这次先不提醒"就会顺手把自己的长期复习关掉，而那句话他没说过。
  if (subject.reminderKind !== "one_time") return { action: "not_one_time" };
  return { action: "acknowledge" };
}

export type AcknowledgeOneTimeReminderOutcomeV1 =
  | { readonly status: "ok"; readonly scheduleId: string; readonly generation: number; readonly dueAt: string }
  | { readonly status: "already_acknowledged"; readonly scheduleId: string; readonly generation: number; readonly dueAt: string }
  | { readonly status: "not_found"; readonly scheduleId: string }
  | { readonly status: "stale"; readonly scheduleId: string }
  | { readonly status: "not_pending"; readonly scheduleId: string }
  | { readonly status: "not_one_time"; readonly scheduleId: string };

/**
 * 关掉一条单次提醒。**只写这一行**：不建继任、不消费别处的待办、不碰学习观察。
 *
 * 权限判据是 (space, person) 加行锁取行——与延后同一形状（`review-defer-service.ts`）。
 * `FOR UPDATE` 在这里是必要的：两个窗口同时点这一发，没有它会两个都判"该关"，
 * 而后写的会把前一次的 `generation` 盖掉。
 */
export async function acknowledgeOneTimeReminderV2(
  tx: ApiTransaction,
  scope: OneTimeReminderScope,
  input: { readonly scheduleId: string; readonly scheduleGeneration: number; readonly at?: Date },
): Promise<AcknowledgeOneTimeReminderOutcomeV1> {
  const rows = await tx
    .select({
      id: reviewSchedules.id,
      status: reviewSchedules.status,
      generation: reviewSchedules.generation,
      reminderKind: reviewSchedules.reminderKind,
      reasonCode: reviewSchedules.reasonCode,
      nextReviewAt: reviewSchedules.nextReviewAt,
    })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.id, input.scheduleId),
      eq(reviewSchedules.workspaceId, scope.workspaceId),
      eq(reviewSchedules.userId, scope.userId),
    ))
    .for("update")
    .limit(1);
  const subject = rows[0] ?? null;
  const decision = decideAcknowledgeOneTimeReminderV1(subject, {
    scheduleGeneration: input.scheduleGeneration,
  });
  if (decision.action === "not_found") return { status: "not_found", scheduleId: input.scheduleId };
  if (decision.action === "already_acknowledged") {
    return {
      status: "already_acknowledged",
      scheduleId: subject!.id,
      generation: subject!.generation,
      dueAt: subject!.nextReviewAt.toISOString(),
    };
  }
  if (decision.action === "stale_generation") return { status: "stale", scheduleId: input.scheduleId };
  if (decision.action === "not_pending") return { status: "not_pending", scheduleId: input.scheduleId };
  if (decision.action === "not_one_time") return { status: "not_one_time", scheduleId: input.scheduleId };

  const at = input.at ?? new Date();
  const updated = await tx
    .update(reviewSchedules)
    .set({
      // `completed` 而不是 `cancelled`：本条是"处理掉了"，不是系统撤的。
      // 两种终态在 §9.1 那一列里是不同的话（`objective-review-holds.ts` 头注已经
      // 把 `dismissed`／`cancelled` 分开，这里沿用同一层区分）。
      status: "completed",
      reasonCode: ONE_TIME_REMINDER_ACKNOWLEDGED_REASON,
      generation: subject!.generation + 1,
      updatedAt: at,
    })
    .where(and(
      eq(reviewSchedules.id, subject!.id),
      eq(reviewSchedules.generation, input.scheduleGeneration),
      eq(reviewSchedules.status, "pending"),
    ))
    .returning({ id: reviewSchedules.id, generation: reviewSchedules.generation });
  // 行锁已经挡住了并发，这里读回 0 行只可能是这一发自己被外层事务回滚过；
  // 如实报冲突，不假装关掉了。
  if (updated.length === 0) return { status: "stale", scheduleId: input.scheduleId };
  return {
    status: "ok",
    scheduleId: updated[0].id,
    generation: updated[0].generation,
    dueAt: subject!.nextReviewAt.toISOString(),
  };
}

export type RequestOneTimeReminderOutcomeV1 =
  | {
      readonly status: "ok";
      readonly scheduleId: string;
      readonly dueAt: string;
      readonly reminderKind: "one_time" | "sustained";
      readonly created: boolean;
    }
  /** 被本人那句「暂不安排」挡下：库里什么都没写（§9.1 行 2），不编一条 id 交出去。 */
  | { readonly status: "held" };

/**
 * 立一条「仅提醒这一次」。
 *
 * 走唯一调度边界而不是自己 insert——0287 之后裸 insert 的症状是"安静地多一条"或
 * "一次 23505"，两条都比"排期只有一处能写"更坏（判据在 `review-schedule-single-writer.test.ts`）。
 *
 * `noteId` 在这里只用来**判可见性**：§16.24 里用户从结果页关掉一条提醒时，界面得能回
 * 笔记；而这一条提醒之所以该存在，前提就是这篇笔记此刻在她书房里。这一发**不按笔记排期**
 * （`subjectId` 是目标），所以注释里写死了"笔记还没有目标的那一档不在这里"。
 */
export async function requestOneTimeReminderV2(
  tx: ApiTransaction,
  scope: OneTimeReminderScope,
  input: {
    readonly noteId: string;
    readonly objectiveId: string;
    readonly dueAt: Date;
    readonly intervalDays?: number;
    readonly at?: Date;
  },
): Promise<RequestOneTimeReminderOutcomeV1> {
  const visible = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(
      eq(notes.id, input.noteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  if (!visible[0]) throw new OneTimeReminderNoteNotFoundV2();

  const at = input.at ?? new Date();
  const ensured = await ensurePendingReviewScheduleV2(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    subjectId: input.objectiveId,
      // §9.1 事实提取与综合应用分别观察。一次性提醒服务的是**提取**这一件事。
      reviewDimension: REVIEW_DIMENSION_VALUES_V2[0],
    reminderKind: "one_time",
    nextReviewAt: input.dueAt,
    intervalDays: input.intervalDays ?? 1,
    // 单次提醒没有"下一次"，generation 只服务于并发与重放（§16.31）。
    generation: 1,
    policyVersion: "one_time_reminder_v1",
    reasonCode: ONE_TIME_REMINDER_REQUESTED_REASON,
    at,
  });
  if (ensured.held || ensured.scheduleId === null || ensured.nextReviewAt === null) {
    // 边界把"不许排"与"已经排着了"分成两个读数（它的 `held`），这里只把前一档
    // 往上传；后一档在正常路径上必然两个 id 都非空，缺一个就是边界坏了。
    if (ensured.held) return { status: "held" };
    throw new Error("唯一调度边界说它复用了既有安排，却没有交回 id 与到期时间");
  }
  return {
    status: "ok",
    scheduleId: ensured.scheduleId,
    dueAt: ensured.nextReviewAt.toISOString(),
    // 库里那一行的实际档位：撞上已排着的持续安排时如实回 sustained，界面据此告诉
    // 用户"这个目标已经在持续安排里了"（合同里的 `created: false` 与这一格一起说）。
    reminderKind: ensured.reminderKind,
    created: ensured.created,
  };
}
