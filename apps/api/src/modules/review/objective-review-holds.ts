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
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { objectiveReviewHoldsV2, reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { notes } from "@ailearn/shared/db-schema/note";
import { visibleNotesCondition } from "../note/visibility.ts";

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
