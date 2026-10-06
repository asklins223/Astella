/**
 * 持续回访授权的两个来源（39d W7-3 刀五；39 §9.1 第一段、行 1 与行 2）。
 *
 * §9.1 那张规则表里**行 1** 是这样写的：「暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该
 * 授权来源**；其他来源仍有效时**显示原因**」，而 §9.1 第一段先立了前提：「两种意图
 * 可以分别存在」、第三段又要求「**内部维护授权来源**…取消一项授权不误删另一项」。
 *
 * 在 `review_subscriptions_v2`（迁移 0303）之前，这三句话**没有可查的来源**：
 * `ReviewAuthorizationSourceV2` 只活在共享规则模块的**类型**里，全仓零写零读。所以
 * 这一格缺的不是判断——`applySourcePauseV2` 那份判断早就写好了——缺的是**记法**与
 * 那颗能拨的开关。
 *
 * 三个纪律写在这里而不是散进调用方：
 *  1. **暂停不是撤销**。行留在库里（`status='paused'`），所以屏上那颗开关在"关"的
 *     位置上，恢复也不必重新问一遍范围（§9.1「开启时用一句话说明这个持续范围」
 *     存在 `scope_note` 列上）。
 *  2. **停一个来源不许碰另一个**。`applySourcePauseV2` 交回 `stillCoveredBy`，调用方
 *     把它**念出来**——「偷偷联动」在这一份里的形状就是把 `card_review` 跟着摘掉。
 *  3. **排除仍然优先于一切授权来源**。这一份只管来源，停一个来源**不会**解除目标排除，
 *     恢复一个来源也**不会**暗中复活一个被排除的目标（那是 `ensurePendingReviewScheduleV2`
 *     与 §9.1 行 2 的职责，见 `review-authorization-rules-v2`）。
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { reviewSubscriptionsV2 } from "@astella/shared/db-schema/evidence";
import { notes } from "@astella/shared/db-schema/note";
import { learningCardsV2, learningObjectiveOriginsV2 } from "@astella/shared/db-schema/card-generation-v2";
import {
  applySourcePauseV2,
  decideSourceAuthorizationV2,
  type ReviewAuthorizationSourceV2,
  type ReviewSourceAuthorizationV2,
} from "@astella/shared/review-authorization-rules-v2";
// P1-16：请求体合同与 desktop-client 共用同一份 zod 定义（理由见下方注释）。
// 本文件自己只用类型，所以按 type-only 引；值 schema 走 `export ... from` 转发，
// 让既有调用方（`routes.ts`）的 import 不用改。
import type { ReviewSubscriptionCommandV2Wire as ReviewSubscriptionCommandV2 } from "@astella/shared/review-queue-v2-contracts";
export {
  reviewSubscriptionCommandV2Schema,
  type ReviewSubscriptionCommandV2Wire as ReviewSubscriptionCommandV2,
} from "@astella/shared/review-queue-v2-contracts";
import { visibleCardsCondition, visibleNotesCondition } from "../note/visibility.ts";
import type { ApiTransaction } from "../../db/client.ts";

type SubTx = ApiTransaction;

/**
 * 来源 ⇄ 主体类型的对应是**结构性的**，不是约定：
 * `note_subscription` 说的是"整篇笔记"（§9.1「笔记订阅覆盖此后在这篇笔记中…的核心
 * 目标」），`card_review` 说的是"那个提取目标"。两者的 `subject_id` 指向不同的表，
 * 所以把来源与主体类型配错**结构上就查不出这一行**——与其让它悄悄查不到，不如在
 * 执法点拒掉，并把词表与规则模块的枚举同源（两处各写一份词表就是迟早分叉）。
 */
export const REVIEW_SUBSCRIPTION_SUBJECT_TYPE = {
  note_subscription: "note",
  card_review: "objective",
} as const satisfies Record<ReviewAuthorizationSourceV2, "note" | "objective">;

export type ReviewSubscriptionSubjectType = (typeof REVIEW_SUBSCRIPTION_SUBJECT_TYPE)[ReviewAuthorizationSourceV2];

/** 订阅只能在**本人此刻看得见**的那篇笔记上成立；这一档要能被路由翻成 404。 */
export class ReviewSubscriptionNoteNotFoundV2 extends Error {
  constructor() {
    super("note_not_found");
  }
}

/**
 * 2026-09-29（P1-16）：这一份曾经在这里**重新定义**了一遍和
 * `packages/shared/src/contracts/review-queue-v2-contracts.ts:189` 同名同形状的 schema，
 * 连 `source` 枚举都是把 `reviewAuthorizationSourceV2Schema` 的值内联重抄了一次。
 *
 * 后果不是"重复"而是**契约分叉**：api 用这份校验请求体，desktop-client 用 shared
 * 那份校验同一份请求体（`desktop-gateway.ts:1828`、`desktop-ipc.ts:595`）。
 * 字段一旦漂移，客户端能过自己的校验、服务端回 400，而编译期什么都不会说。
 *
 * 现在只从 shared 引。改动是把服务端与客户端钉在同一份 zod 合同上，
 * 不是"简化"——本文件其余内容与判断逻辑一律未动。
 */

type SubRow = typeof reviewSubscriptionsV2.$inferSelect;

export interface ReviewSubscriptionV2View {
  readonly source: ReviewAuthorizationSourceV2;
  readonly subjectType: ReviewSubscriptionSubjectType;
  readonly subjectId: string;
  readonly status: "active" | "paused";
  readonly scopeNote: string;
  readonly createdAt: string;
  readonly pausedAt: string | null;
}

function toView(row: SubRow): ReviewSubscriptionV2View {
  return {
    source: row.source as ReviewAuthorizationSourceV2,
    subjectType: row.subjectType as ReviewSubscriptionSubjectType,
    subjectId: row.subjectId,
    status: row.status as "active" | "paused",
    scopeNote: row.scopeNote,
    createdAt: row.createdAt.toISOString(),
    pausedAt: row.pausedAt?.toISOString() ?? null,
  };
}

type ReviewScope = { workspaceId: string; userId: string };

/**
 * 某个主体此刻**有哪些活着**的来源。这正是 `applySourcePauseV2` 要的那份
 * `sources`——它此前只能由调用方自己编，而调用方手里没有这张表。
 *
 * ⚠️ 对 `note` 主体**只查得出笔记订阅自己**：卡片订阅的主体是**目标**，不是那篇笔记。
 * 要回答 §9.1 行 1 那句「暂停笔记复习时说明**已单独开启的卡片**是否继续」，必须另外
 * 走 `stillCoveredForNoteV2` 把这篇底下的目标一并看——只用这一个函数，屏上会在
 * "那张卡明明还开着"的时候显示成已停止。（第一版就是只用了它，集成档当场红在
 * `[] !== ['card_review']`；那条红是本刀量到的真缺口，不是夹具问题。）
 */
export async function liveSourcesForSubjectV2(
  tx: SubTx,
  input: ReviewScope & { subjectType: ReviewSubscriptionSubjectType; subjectId: string },
): Promise<ReviewAuthorizationSourceV2[]> {
  const rows = await tx
    .select({ source: reviewSubscriptionsV2.source })
    .from(reviewSubscriptionsV2)
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.subjectType, input.subjectType),
      eq(reviewSubscriptionsV2.subjectId, input.subjectId),
      eq(reviewSubscriptionsV2.status, "active"),
    ));
  return rows.map((row) => row.source as ReviewAuthorizationSourceV2);
}

/**
 * 停用一篇笔记的订阅之后，**这篇底下是否还有单独开启的卡片订阅**（§9.1 行 1）。
 *
 * 判据是 origin 血缘（`learning_objective_origins_v2` 的 note 档），不是"这篇的
 * 所有目标"：§9.1 说笔记订阅覆盖的是「此后在这篇笔记中**实际学过**、或经本人声明／
 * 首次回忆确认需要维护的核心目标」，而卡片订阅是**按目标**单独开的。一张与这篇
 * 毫无血缘关系的卡，不该因为她停了这一篇就被算成"还撑着"。
 */
export async function stillCoveredForNoteV2(
  tx: SubTx,
  input: ReviewScope & { noteId: string },
): Promise<ReviewAuthorizationSourceV2[]> {
  const rows = await tx
    .select({ source: reviewSubscriptionsV2.source })
    .from(reviewSubscriptionsV2)
    .innerJoin(
      learningObjectiveOriginsV2,
      and(
        eq(learningObjectiveOriginsV2.objectiveId, reviewSubscriptionsV2.subjectId),
        eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
        eq(learningObjectiveOriginsV2.originKind, "note"),
        eq(learningObjectiveOriginsV2.noteId, input.noteId),
      ),
    )
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.subjectType, "objective"),
      eq(reviewSubscriptionsV2.status, "active"),
    ));
  const sources: ReviewAuthorizationSourceV2[] = [];
  for (const row of rows) {
    const source = row.source as ReviewAuthorizationSourceV2;
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/**
 * 一发停用/开启之后，**这份安排还由谁撑着**。`note` 那一档要把卡片订阅算进来
 * （§9.1 行 1「暂停笔记复习时说明已单独开启的卡片是否继续」），`objective` 那一档
 * 只查自己——把两档混成一个函数，正是第一版把卡片那档漏掉的原因。
 */
async function stillCoveredAfterV2(
  tx: SubTx,
  input: ReviewScope & { source: ReviewAuthorizationSourceV2; subjectId: string },
): Promise<ReviewAuthorizationSourceV2[]> {
  const subjectType = REVIEW_SUBSCRIPTION_SUBJECT_TYPE[input.source];
  if (subjectType === "objective") {
    return liveSourcesForSubjectV2(tx, { ...input, subjectType, subjectId: input.subjectId });
  }
  const sources = await liveSourcesForSubjectV2(tx, { ...input, subjectType, subjectId: input.subjectId });
  for (const source of await stillCoveredForNoteV2(tx, {
    workspaceId: input.workspaceId, userId: input.userId, noteId: input.subjectId,
  })) {
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/**
 * 目标级的来源读侧。**一次查好 N 个**（列表一页 50 行就是 50 次往返的差别），
 * 交给 `surface-service` 装进目标详情与列表。
 *
 * 目标这一档只查 `objective` 主体（卡片订阅）。笔记订阅是**整篇**的，它覆盖哪些目标
 * 要按 §9.1「此后在这篇笔记中实际学过、或经本人声明／首次回忆确认需要维护的核心
 * 目标」来判——那需要 origin 血缘，**不是**"这篇底下所有目标都属于它"。
 * 所以目标那一格在这里**只报卡片订阅**，笔记订阅留给笔记那一屏（§9.1 行 1
 * 「暂停笔记复习时说明已单独开启的卡片是否继续」是笔记屏上的那句话）。
 */
export async function liveSourcesForObjectivesV2(
  tx: SubTx,
  input: ReviewScope & { objectiveIds: readonly string[] },
): Promise<Map<string, ReviewAuthorizationSourceV2[]>> {
  const byObjective = new Map<string, ReviewAuthorizationSourceV2[]>();
  if (input.objectiveIds.length === 0) return byObjective;
  const rows = await tx
    .select({ subjectId: reviewSubscriptionsV2.subjectId, source: reviewSubscriptionsV2.source })
    .from(reviewSubscriptionsV2)
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.subjectType, "objective"),
      inArray(reviewSubscriptionsV2.subjectId, [...input.objectiveIds]),
      eq(reviewSubscriptionsV2.status, "active"),
    ));
  for (const row of rows) {
    const list = byObjective.get(row.subjectId) ?? [];
    if (!list.includes(row.source as ReviewAuthorizationSourceV2)) {
      list.push(row.source as ReviewAuthorizationSourceV2);
    }
    byObjective.set(row.subjectId, list);
  }
  return byObjective;
}

/** 笔记那一屏：她订阅了哪几篇（连暂停的也列出来——开关要能拨回"开"）。 */
export async function listNoteSubscriptionsV2(
  tx: SubTx,
  input: ReviewScope,
): Promise<ReviewSubscriptionV2View[]> {
  const rows = await tx
    .select()
    .from(reviewSubscriptionsV2)
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.subjectType, "note"),
    ))
    .orderBy(reviewSubscriptionsV2.createdAt);
  return rows.map(toView);
}

async function assertNoteVisible(
  tx: SubTx,
  input: ReviewScope & { noteId: string },
): Promise<void> {
  const rows = await tx.select({ id: notes.id }).from(notes).where(and(
    eq(notes.id, input.noteId),
    eq(notes.workspaceId, input.workspaceId),
    visibleNotesCondition(input.userId),
  )).limit(1);
  if (!rows[0]) throw new ReviewSubscriptionNoteNotFoundV2();
}

export interface SubscriptionChangeV2 {
  readonly subscription: ReviewSubscriptionV2View;
  /** 这次是真的开了/停了，还是本来就在那一档（连点两下不该长出两份）。 */
  readonly changed: boolean;
  /**
   * §9.1 行 1「其他来源仍有效时**显示原因**」——停掉一个来源之后，**还有谁在撑着**
   * 同一个主体。非空就是"仍在安排"，空就是"这一份不再被安排"。
   *
   * 停用之后仍要算这一格，而不是停之前那一格：`applySourcePauseV2` 的入参是
   * **停之前**的来源列表，输出是**停之后**剩下的。少了这一步，屏上会在还有卡片
   * 订阅时显示"已停止安排"——那正是 §9.1 禁止的"偷偷联动"的另一种说法。
   */
  readonly stillCoveredBy: readonly ReviewAuthorizationSourceV2[];
}

/** 开启（或重新开启）一个来源。 */
export async function activateReviewSubscriptionV2(
  tx: SubTx,
  input: ReviewScope & ReviewSubscriptionCommandV2 & { at?: Date },
): Promise<SubscriptionChangeV2> {
  const at = input.at ?? new Date();
  const subjectType = REVIEW_SUBSCRIPTION_SUBJECT_TYPE[input.source];
  if (subjectType === "note") {
    await assertNoteVisible(tx, { ...input, noteId: input.subjectId });
  }
  // 恢复一份暂停的：改 status，不插第二条，于是 created_at 与 scope_note 留着
  // （"她什么时候授权的、范围是什么"不该因为暂停过一轮就丢）。
  const resumed = await tx
    .update(reviewSubscriptionsV2)
    .set({ status: "active", pausedAt: null, pauseReason: null, updatedAt: at })
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.source, input.source),
      eq(reviewSubscriptionsV2.subjectType, subjectType),
      eq(reviewSubscriptionsV2.subjectId, input.subjectId),
      eq(reviewSubscriptionsV2.status, "paused"),
    ))
    .returning();
  if (resumed[0]) {
    const sources = await stillCoveredAfterV2(tx, { ...input, subjectId: input.subjectId });
    return { subscription: toView(resumed[0]), changed: true, stillCoveredBy: sources };
  }
  const inserted = await tx.insert(reviewSubscriptionsV2).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    source: input.source,
    subjectType,
    subjectId: input.subjectId,
    // 没有一句话说明范围的订阅**不受理**：§9.1「开启时用一句话说明这个持续范围」。
    // 写成默认空串会让屏上"这份安排还由谁撑着"永远念不出范围。
    scopeNote: input.scopeNote ?? `持续回访${subjectType === "note" ? "这篇笔记" : "这个目标"}里已学过或已确认需要维护的内容。`,
    status: "active",
  }).onConflictDoNothing({
    target: [
      reviewSubscriptionsV2.workspaceId,
      reviewSubscriptionsV2.userId,
      reviewSubscriptionsV2.source,
      reviewSubscriptionsV2.subjectType,
      reviewSubscriptionsV2.subjectId,
    ],
    where: eq(reviewSubscriptionsV2.status, "active"),
  }).returning();
  if (inserted[0]) {
    const sources = await stillCoveredAfterV2(tx, { ...input, subjectId: input.subjectId });
    return { subscription: toView(inserted[0]), changed: true, stillCoveredBy: sources };
  }
  // 撞了那把部分唯一索引 ⇒ 已经有一份活着的；交回它，不报"我开的"。
  const existing = await tx.select().from(reviewSubscriptionsV2).where(and(
    eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
    eq(reviewSubscriptionsV2.userId, input.userId),
    eq(reviewSubscriptionsV2.source, input.source),
    eq(reviewSubscriptionsV2.subjectType, subjectType),
    eq(reviewSubscriptionsV2.subjectId, input.subjectId),
    eq(reviewSubscriptionsV2.status, "active"),
  )).limit(1);
  if (!existing[0]) {
    // 挡住 insert、回读又是空 ⇒ 两次调用之间有人停了它。让这一发失败，
    // 比交回一句"已开启"而库里没有活行要诚实。
    throw new Error("review subscription 写入被挡但读不到活行：并发停用，请重试这一发");
  }
  const sources = await stillCoveredAfterV2(tx, { ...input, subjectId: input.subjectId });
  return { subscription: toView(existing[0]), changed: false, stillCoveredBy: sources };
}

/**
 * 停用一个来源。**只停这一个**（§9.1 行 1）。
 *
 * 注意这一发**不碰** `review_schedules`、**不碰** `objective_review_holds_v2`：
 * 排期怎么跟着走是调度边界（`ensurePendingReviewScheduleV2`）的职责，而排除是
 * §9.1 行 2 那一格。把这三件事在一条命令里一起做，就是"取消一项授权误删另一项"。
 */
export async function pauseReviewSubscriptionV2(
  tx: SubTx,
  input: ReviewScope & ReviewSubscriptionCommandV2 & { at?: Date },
): Promise<SubscriptionChangeV2> {
  const at = input.at ?? new Date();
  const subjectType = REVIEW_SUBSCRIPTION_SUBJECT_TYPE[input.source];
  if (subjectType === "note") {
    await assertNoteVisible(tx, { ...input, noteId: input.subjectId });
  }
  const before = await liveSourcesForSubjectV2(tx, { ...input, subjectType, subjectId: input.subjectId });
  const paused = await tx
    .update(reviewSubscriptionsV2)
    .set({ status: "paused", pausedAt: at, pauseReason: input.reasonCode ?? "user_paused_source", updatedAt: at })
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.source, input.source),
      eq(reviewSubscriptionsV2.subjectType, subjectType),
      eq(reviewSubscriptionsV2.subjectId, input.subjectId),
      eq(reviewSubscriptionsV2.status, "active"),
    ))
    .returning();
  if (!paused[0]) {
    // 本来就是停的：交回那一份并说"这次没有改动"，而不是报"刚刚停好了"。
    const existing = await tx.select().from(reviewSubscriptionsV2).where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      eq(reviewSubscriptionsV2.source, input.source),
      eq(reviewSubscriptionsV2.subjectType, subjectType),
      eq(reviewSubscriptionsV2.subjectId, input.subjectId),
      eq(reviewSubscriptionsV2.status, "paused"),
    )).limit(1);
    if (!existing[0]) throw new Error("review subscription 停用没有命中行：可能从未开启过");
    return {
      subscription: toView(existing[0]),
      changed: false,
      // 走 `stillCoveredAfterV2` 而不是拿 `before` 减一下：那一支已经是"现在还剩谁"，
      // 规则表行 1 要的正是这个读数，不是停之前那一列的算术。
      stillCoveredBy: await stillCoveredAfterV2(tx, { ...input, subjectId: input.subjectId }),
    };
  }
  // `before` 仍然要算：它是 `applySourcePauseV2` 唯一的入参，而那一格是"同一个主体上
  // 别的来源"——**它管不到别的主体的来源**。§9.1 行 1 要的那句「暂停笔记复习时说明
  // **已单独开启的卡片**是否继续」跨到了另一个主体（卡片订阅挂在目标上），所以最终
  // 交回的是两者的并集：规则表判同一主体，`stillCoveredForNoteV2` 判跨主体。
  applySourcePauseV2({ sources: before, pausedSource: input.source });
  return {
    subscription: toView(paused[0]),
    changed: true,
    stillCoveredBy: await stillCoveredAfterV2(tx, { ...input, subjectId: input.subjectId }),
  };
}

/**
 * W7-8 刀三：这颗目标此刻**由谁撑着**（39 §9.1 规则表行 1）。
 *
 * ## 为什么要跨两张表
 *
 * 判据（`decideSourceAuthorizationV2`）要知道两件事：
 *  1. 这颗目标**自己**的卡片订阅档位（`subject_type='objective'`）；
 *  2. 这颗目标**那些来源笔记**的订阅档位（`subject_type='note'`）——因为 §9.1 行 1
 *     说的是"停一个来源不误删另一个"，而"另一个"常常是笔记订阅。
 *
 * ## `never_authorized` 这一档为什么也在这一发里
 *
 * §9.1「创建卡、读过笔记或结束一轮都**不默认授权**未来提醒」。一颗目标可以完全没被
 * 授权过——那一档与"她开了又停了"后果不同（前者要**问**，后者是照办），所以判据分
 * 三档而这一份把三档的输入都收齐。
 */
export async function sourceAuthorizationForObjectiveV2(
  tx: SubTx,
  input: ReviewScope & { objectiveId: string },
): Promise<{
  authorization: ReviewSourceAuthorizationV2;
  activeSources: number;
  pausedSources: number;
}> {
  // 这颗目标自己落在哪些来源笔记上（note 档血缘）。
  const originRows = await tx
    .selectDistinct({ noteId: learningObjectiveOriginsV2.noteId })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, input.workspaceId),
      eq(learningObjectiveOriginsV2.objectiveId, input.objectiveId),
      eq(learningObjectiveOriginsV2.originKind, "note"),
    ));
  const noteIds = originRows.map((row) => row.noteId).filter((id): id is string => Boolean(id));

  const rows = await tx
    .select({ source: reviewSubscriptionsV2.source, subjectType: reviewSubscriptionsV2.subjectType, subjectId: reviewSubscriptionsV2.subjectId, status: reviewSubscriptionsV2.status })
    .from(reviewSubscriptionsV2)
    .where(and(
      eq(reviewSubscriptionsV2.workspaceId, input.workspaceId),
      eq(reviewSubscriptionsV2.userId, input.userId),
      or(
        and(
          eq(reviewSubscriptionsV2.subjectType, "objective"),
          eq(reviewSubscriptionsV2.subjectId, input.objectiveId),
        ),
        noteIds.length > 0
          ? and(
            eq(reviewSubscriptionsV2.subjectType, "note"),
            inArray(reviewSubscriptionsV2.subjectId, noteIds),
          )
          : undefined,
      ),
    ));

  const cardRow = rows.find((row) => row.subjectType === "objective" && row.source === "card_review");
  const activeCard = (await tx.select({ id: learningCardsV2.cardId })
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, input.workspaceId),
      eq(learningCardsV2.objectiveId, input.objectiveId),
      eq(learningCardsV2.lifecycle, "active"),
      visibleCardsCondition(input.userId, learningCardsV2.noteVersionId),
    )).limit(1))[0];
  const noteSubscriptions = rows
    .filter((row) => row.subjectType === "note")
    .map((row) => row.status as "active" | "paused");

  return decideSourceAuthorizationV2({
    cardReview: activeCard && cardRow ? (cardRow.status as "active" | "paused") : null,
    noteSubscriptions,
    // 仅实际存在活卡时，历史上的「保存并开启」才可视为卡片授权。无卡目标不能
    // 凭同一个 objectiveId 被误判成已获卡片授权；它必须由笔记订阅明确覆盖。
    cardActivationIsIntent: Boolean(activeCard),
  });
}
