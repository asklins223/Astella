/**
 * 目标级「暂不安排」的三个动作（39d W7-3 刀一；39 §9.1 规则表行 2 与行 3）。
 *
 * 只做"这一发要写什么"，**不判规则**：谁优先、暂停只停哪个来源、延后要不要列范围，
 * 那份判据在 `@ailearn/shared/review-authorization-rules-v2`——入口不止这里一个
 * （审核台、首页、伴星），§9.1 的原话是"不能由入口各自解释"。
 *
 * 为什么单独一个模块而不是并进 `review-schedule-boundary.ts`：那份是"唯一写入安排"的
 * 边界，被两处生产调用共用；这里是被边界**查询**的那一份状态。混在一起会读成
 * "排除也算一种安排写入"，而那正是这张表要避免的类比——排除停的是授权，不是一条待办。
 *
 * 历史不删：一次解除盖一个 `released_at`，同一个人对同一个目标可以再来一次；
 * 唯一性只作用在"还活着的那一份"上（迁移 0295 的部分唯一索引）。
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { objectiveReviewHoldsV2, reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { notes } from "@ailearn/shared/db-schema/note";
import {
  DISCRETE_V2_FIRST_INTERVAL_DAYS,
  DISCRETE_V2_POLICY_VERSION,
  discreteV2FirstDueAt,
} from "@ailearn/shared";
import { visibleNotesCondition } from "../note/visibility.ts";
import { ensurePendingReviewScheduleV2 } from "./review-schedule-boundary.ts";
import { isReviewDimensionV2, REVIEW_DIMENSION_VALUES_V2, type ReviewDimensionV2 } from "@ailearn/shared/review-dimension-v2";

/** 排除只能立在自己书房里的笔记上；这一档要能被路由翻成 404，而不是 500。 */
export class ObjectiveHoldNoteNotFoundV2 extends Error {
  constructor() {
    super("note_not_found");
  }
}
import type { ApiTransaction } from "../../db/client.ts";

type HoldTx = ApiTransaction;

/** 设／解排除的请求体（两条共用一个文件里的定义，免得两个入口各写一份校验）。 */
export const holdObjectiveRequestV2Schema = z.strictObject({
  noteId: z.string().uuid(),
  objectiveId: z.string().uuid(),
  /** 界面给的因由；空串走默认那一档，不让人把"系统没记理由"写成"用户没给理由"。 */
  reasonCode: z.string().min(1).max(120).optional(),
});
export const resumeObjectiveRequestV2Schema = z.strictObject({
  objectiveId: z.string().uuid(),
  releaseReason: z.string().min(1).max(120).optional(),
  /**
   * 恢复**并开启**要排一条安排，而排的是"这一篇的这个目标"——所以必须带上笔记，
   * 由服务端判可见性。与 `holdObjectiveRequestV2Schema` 同一档处理（读不到翻 404）。
   * 2026-09-27 起必填：这一发已经不再只是解除排除，它会写 `review_schedules`。
   */
  noteId: z.string().uuid(),
});
type HoldRow = typeof objectiveReviewHoldsV2.$inferSelect;

export interface ObjectiveHoldV2View {
  readonly objectiveId: string;
  readonly noteId: string;
  readonly reasonCode: string;
  /** 屏幕上要说"这是你什么时候标的"，并且恢复那颗按钮要认得这一条。 */
  readonly createdAt: string;
}

function toView(row: HoldRow): ObjectiveHoldV2View {
  return {
    objectiveId: row.objectiveId,
    noteId: row.noteId,
    reasonCode: row.reasonCode,
    createdAt: row.createdAt.toISOString(),
  };
}

const LIVE = and(isNull(objectiveReviewHoldsV2.releasedAt));

/** 这个（人, 目标）当前是否在排除中。唯一调度边界每一发授权前问的就是这一句。 */
export async function liveHoldForObjectiveV2(
  tx: HoldTx,
  input: { workspaceId: string; userId: string; objectiveId: string },
): Promise<ObjectiveHoldV2View | null> {
  const rows = await tx.select().from(objectiveReviewHoldsV2).where(and(
    eq(objectiveReviewHoldsV2.workspaceId, input.workspaceId),
    eq(objectiveReviewHoldsV2.userId, input.userId),
    eq(objectiveReviewHoldsV2.objectiveId, input.objectiveId),
    LIVE,
  )).limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * 批量那一发：一次查好 N 个目标的活排除，交给 `surface-service` 装进详情与列表
 * **同一个字段**（`personal.reviewHold` / `reviewHold`）。
 *
 * 为什么值得单独写而不是在调用方 `inArray` 一次：`LIVE`（`released_at IS NULL`）这个
 * 判据只要在两个地方各写一遍，将来加一档"部分解除"就会有一处漏掉——而漏掉的后果是
 * 屏上对已经恢复的目标仍然说"暂不安排"，且**不会**有测试红。
 *
 * 同一个目标理论上只有一条活行（0295 的部分唯一索引），但这里仍按"第一条"收敛
 * 而不是直接建 Map 覆盖：万一那条索引哪天被摘掉，覆盖会让读数随行序抖动，
 * 而"取一条"是能被用例钉住的形状。
 */
export async function liveHoldsForObjectivesV2(
  tx: HoldTx,
  input: { workspaceId: string; userId: string; objectiveIds: readonly string[] },
): Promise<Map<string, ObjectiveHoldV2View>> {
  const byObjective = new Map<string, ObjectiveHoldV2View>();
  if (input.objectiveIds.length === 0) return byObjective;
  const rows = await tx
    .select()
    .from(objectiveReviewHoldsV2)
    .where(and(
      eq(objectiveReviewHoldsV2.workspaceId, input.workspaceId),
      eq(objectiveReviewHoldsV2.userId, input.userId),
      inArray(objectiveReviewHoldsV2.objectiveId, [...input.objectiveIds]),
      LIVE,
    ))
    .orderBy(asc(objectiveReviewHoldsV2.createdAt));
  for (const row of rows) {
    if (!byObjective.has(row.objectiveId)) byObjective.set(row.objectiveId, toView(row));
  }
  return byObjective;
}

/**
 * 立一条排除。已经在排除中就把那一条交回（`created: false`）——连点两下不该长出两份，
 * 也不该让调用方以为"这次才生效"。
 */
export async function holdObjectiveFromReviewV2(
  tx: HoldTx,
  input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    objectiveId: string;
    reasonCode?: string;
  },
): Promise<{ hold: ObjectiveHoldV2View; created: boolean; dismissedPendingSchedules: number }> {
  // 点下去要有看得见的后果：这个目标此刻**已经排着**的那一条待办一并撤下（`dismissed`
  // 是"本人不要这条了"那一档，与 `cancelled`（系统撤）分开）。不撤的话她下一到期还是会
  // 从队列里冒出来，那句"暂不安排"就成了只挡未来的空话。
  // 只撤这一个目标的，且只撤待处理的——`completed`/`superseded` 是历史，§9.1 明写不删。
  // 判据与其余笔记读点同一份：这篇必须是本人此刻**看得见**的那一篇。只按 workspace 筛
  // 不够——软删与私有分享那几档都在这一个条件里（守卫 `note-visibility-read-sites` 盯的就是它）。
  const note = await tx.select({ id: notes.id }).from(notes).where(and(
    eq(notes.id, input.noteId),
    eq(notes.workspaceId, input.workspaceId),
    visibleNotesCondition(input.userId),
  )).limit(1);
  if (!note[0]) throw new ObjectiveHoldNoteNotFoundV2();
  const dismissed = await tx.update(reviewSchedules)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.subjectId, input.objectiveId),
      eq(reviewSchedules.status, "pending"),
    ))
    .returning({ id: reviewSchedules.id });
  const inserted = await tx.insert(objectiveReviewHoldsV2).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    noteId: input.noteId,
    objectiveId: input.objectiveId,
    reasonCode: input.reasonCode ?? "user_deferred_objective",
  }).onConflictDoNothing({
    target: [
      objectiveReviewHoldsV2.workspaceId,
      objectiveReviewHoldsV2.userId,
      objectiveReviewHoldsV2.noteId,
      objectiveReviewHoldsV2.objectiveId,
    ],
    where: LIVE,
  }).returning();
  if (inserted[0]) return { hold: toView(inserted[0]), created: true, dismissedPendingSchedules: dismissed.length };
  // 撞了那条部分唯一索引 ⇒ 已经有一份活着的；交回它，不报"我立的"。
  const existing = await tx.select().from(objectiveReviewHoldsV2).where(and(
    eq(objectiveReviewHoldsV2.workspaceId, input.workspaceId),
    eq(objectiveReviewHoldsV2.userId, input.userId),
    eq(objectiveReviewHoldsV2.objectiveId, input.objectiveId),
    LIVE,
  )).limit(1);
  if (!existing[0]) {
    // 唯一索引挡住了 insert、回读又是空 ⇒ 两句之间有人解除过。让这一发失败，
    // 比让它回一句"已暂不安排"而库里什么都没立要诚实。
    throw new Error("objective hold 写入被挡但读不到活行：并发解除，请重试这一发");
  }
  return { hold: toView(existing[0]), created: false, dismissedPendingSchedules: dismissed.length };
}

/**
 * 解除排除——§9.1 行 3 里唯一那条能让一个被排除的目标重新进入安排的路径。
 *
 * 返回解掉了没有：`released: false` 要能被调用方区分出来，因为"本来就没在排除中"与
 * "已恢复"是两句不同的话，界面上不能都念成后者。
 */
export async function releaseObjectiveHoldV2(
  tx: HoldTx,
  input: {
    workspaceId: string;
    userId: string;
    objectiveId: string;
    releaseReason: string;
    at: Date;
  },
): Promise<{ released: boolean }> {
  const updated = await tx.update(objectiveReviewHoldsV2)
    .set({ releasedAt: input.at, releaseReason: input.releaseReason })
    .where(and(
      eq(objectiveReviewHoldsV2.workspaceId, input.workspaceId),
      eq(objectiveReviewHoldsV2.userId, input.userId),
      eq(objectiveReviewHoldsV2.objectiveId, input.objectiveId),
      LIVE,
    ))
    .returning({ id: objectiveReviewHoldsV2.id });
  return { released: updated.length > 0 };
}

/** 解除排除时写进排期 `reason_code` 的一档。 */
export const OBJECTIVE_HOLD_RELEASED_REASON = "objective_hold_released";

export type ResumeAndScheduleOutcomeV2 =
  /** 排上了新的。 */
  | { readonly status: "resumed_and_scheduled"; readonly objectiveId: string; readonly scheduleId: string; readonly nextReviewAt: string; readonly released: boolean }
  /** 那一格已经有安排（别的授权来源排的）：沿用它，回**库里那条**的实际日期。 */
  | { readonly status: "resumed_already_scheduled"; readonly objectiveId: string; readonly scheduleId: string; readonly nextReviewAt: string; readonly released: boolean }
  /** 排期被另一条活着的排除挡下——如实报，不说成「已经开启」。 */
  | { readonly status: "still_held"; readonly objectiveId: string };

/**
 * §9.1 规则表行 3 的**组合动作**：「只有用户选择『恢复此目标并开启』才解除排除」。
 *
 * 为什么必须是组合而不是两个动作：`releaseObjectiveHoldV2` 只写 `released_at`，而它撤
 * 下去的那些排期是 `dismissed`（终态）。于是用户点「恢复」之后——按界面上的承诺那是
 * "恢复**并开启**"——那个目标**永远不会再出现在她队列里**。她的原话是"我想继续被提醒"，
 * 系统回的是"我不再挡你了"，而挡她的是上一秒她自己点的那个排除留下的空洞。§9.1 行 2
 * 那句"主动恢复后才重新进入"说的正是这一格。
 *
 * 三条判断写在这里而不是散进调用方：
 *  1. **顺序是先解除、后排期**，且同一个事务。反过来的话边界会拿刚写下 `released_at`
 *     的那一行问出"还挡着吗"——同事务内它读得到自己，于是自己把自己挡回去。
 *  2. **排期走唯一边界**（`ensurePendingReviewScheduleV2`），不裸 insert：0287 那把
 *     部分唯一索引会把它变成一次 23505，而且绕过边界就绕过了目标级排除的执法。
 *  3. **不调 `calculateDiscreteV2Schedule`**：那是个**观察**策略，要一个 outcome。
 *     「恢复并开启」时用户什么都没做，硬凑一个 `correct` 等于把一次从没发生过的表现
 *     记成发生过。这里排的是策略的**首档**首次回访，policyVersion 仍记 `discrete-v2`
 *     （同一份策略、同一个首档），reasonCode 另取一档把它与任何一次观察分开——
 *     §9.2 三种事实分开，这一条属于**安排回执**，不属于能力证据。
 */
export async function resumeObjectiveAndScheduleV2(
  tx: HoldTx,
  input: {
    workspaceId: string;
    userId: string;
    noteId: string;
    objectiveId: string;
    releaseReason?: string;
    at?: Date;
  },
): Promise<ResumeAndScheduleOutcomeV2> {
  const at = input.at ?? new Date();
  // 可见性与 `holdObjectiveFromReviewV2` 同一档：排除只能立在自己书房里的笔记上，
  // 恢复也只对本人可见的那一篇生效（软删与私有分享都在这一个条件里）。
  const visible = await tx.select({ id: notes.id }).from(notes).where(and(
    eq(notes.id, input.noteId),
    eq(notes.workspaceId, input.workspaceId),
    visibleNotesCondition(input.userId),
  )).limit(1);
  if (!visible[0]) throw new ObjectiveHoldNoteNotFoundV2();

  const released = await releaseObjectiveHoldV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    objectiveId: input.objectiveId,
    releaseReason: input.releaseReason ?? "user_resumed_objective",
    at,
  });

  const ensured = await ensurePendingReviewScheduleV2(tx, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    subjectId: input.objectiveId,
    // §9.1 事实提取与综合应用分别观察。「恢复并开启」是**把一条被排除的安排放回来**，
    // 不是新开一项需求：被排除前那一格是哪一维，就还回哪一维。读出来优先于写死——
    // 写死会在她恢复的是「应用」那一格时新建出一条「提取」，0287 的唯一索引挡不住
    // （那是两个不同的 key），于是同一个目标上平白多出一道她没要的回忆。
    reviewDimension: (await readHeldScheduleDimensionV2(tx, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      objectiveId: input.objectiveId,
    })) ?? REVIEW_DIMENSION_VALUES_V2[0],
    // 「开启」是持续安排；与「仅提醒这一次」共用这一格唯一键（0297 头注第 1 条），
    // 撞上已排着的那一条时边界回读库里实际档位，不由这一发覆盖。
    reminderKind: "sustained",
    // 首档到期时刻走策略自己那个 `discreteV2FirstDueAt`（它带 `addMs` 溢出护栏）。
    // **不要**在这里写 `at.getTime() + N * 86_400_000`——第一版就是这么写的，绕过了护栏，
    // 而且把阶梯头一档又抄了一份到本文件（阶梯改了这里不会跟着改）。
    nextReviewAt: discreteV2FirstDueAt(at),
    intervalDays: DISCRETE_V2_FIRST_INTERVAL_DAYS,
    generation: 1,
    policyVersion: DISCRETE_V2_POLICY_VERSION,
    reasonCode: OBJECTIVE_HOLD_RELEASED_REASON,
    at,
  });
  if (ensured.held || ensured.scheduleId === null || ensured.nextReviewAt === null) {
    // 刚解除的这一条不该再挡住自己（见头注第 1 条）。真到了这一档，说明同一目标上还有
    // 另一条活着的排除——如实报「仍然挡着」，不要报一句「已经开启」。
    return { status: "still_held", objectiveId: input.objectiveId };
  }
  return {
    status: ensured.created ? "resumed_and_scheduled" : "resumed_already_scheduled",
    objectiveId: input.objectiveId,
    scheduleId: ensured.scheduleId,
    nextReviewAt: ensured.nextReviewAt.toISOString(),
    released: released.released,
  };
}

/**
 * 被排除的那一条安排原本服务的是哪一个维度（§9.1）。
 *
 * 排除表（0295）只记"这个目标暂不安排"，不记维度；而排期行里那一列还在。所以恢复时
 * 读**排在它后面的**最近一条（不管状态）——被排掉时那一行没被删，维度就在那里。
 * 读不到就交给调用方落默认档，而不是在这里猜。
 */
async function readHeldScheduleDimensionV2(
  tx: ApiTransaction,
  input: { workspaceId: string; userId: string; objectiveId: string },
): Promise<ReviewDimensionV2 | null> {
  const rows = await tx
    .select({ dimension: reviewSchedules.reviewDimension })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, input.workspaceId),
      eq(reviewSchedules.userId, input.userId),
      eq(reviewSchedules.subjectId, input.objectiveId),
    ))
    .orderBy(desc(reviewSchedules.updatedAt))
    .limit(1);
  const value = rows[0]?.dimension;
  return isReviewDimensionV2(value) ? value : null;
}
