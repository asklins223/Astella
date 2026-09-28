/**
 * Member 对**已有共享卡**开启**本人的**个人复习（39d W5-6 刀四；PRD §14.4、§16.20、§9.1）。
 *
 * ## 这一格为什么零实现就是缺口
 *
 * §14.4 逐字写着「Member 可以学、练、收藏本人学习记录，以及对已有共享卡片开启个人
 * 复习」，§16.20 把「对已有共享卡开启个人复习」单列为一条验收。而今天唯一能排期的入口是
 * `activation-service.ts:553` 那个 `startReviewScheduling`——它挂在**作者保存并激活**候选
 * 的那一发上，排的是**作者本人**的安排。读者侧没有任何入口。
 *
 * 那个入口的注释**已经把这一格预留出来了**（原文）：「`created: false` 那一档要等到有
 * 别的路径先给同一个目标排上队（W7-3 持续授权／**W7-8 手动安排**）才会活」。本文件就是
 * 那个「W7-8 手动安排」的第一格，所以：
 *  - **间隔形状一律照它那一档**（`discreteV2FirstDueAt` ＋ `DISCRETE_V2_FIRST_INTERVAL_DAYS`
 *    ＋ `DISCRETE_V2_POLICY_VERSION`），不在这里再写一份天数，也不调
 *    `calculateDiscreteV2Schedule`（那要一个 outcome，而「读者开启自己的复习」不是一次观察）；
 *  - **不裸 insert**，走 `ensurePendingReviewScheduleV2`（0287 那把部分唯一索引会把它变成
 *    一次 23505，而且绕过边界就绕过了目标级「暂不安排」的执法）。
 *
 * ## 三条不变量
 *
 *  1. **本人可见、且这张卡确实来自一篇共享笔记**。判据用现成的
 *     `visibleObjectivesCondition`（经卡 → 笔记 → 分享范围），**不在这里重写一份**。
 *     另加一条 `note_version_id IS NOT NULL`：「共享卡」的定义就是"在一篇共享笔记里的卡"，
 *     没有笔记来源的卡（0274 之后 `noteVersionId` 可空）不属于这一格。
 *  2. **排的是读者本人的安排**。`review_schedules` 的键里带 `user_id`（0287 注释第 3 条），
 *     所以「作者的订阅」与「读者的订阅」天然是两条，互不清掉。
 *  3. **`reason_code` 与作者那一档分开**。它是审计列：写成和 `activation_authorized` 同一个
 *     值，事后分不清「作者给自己排的」与「读者给自己排的」，而 §9.2 三种事实分开要能从这一列
 *     读出来。
 *
 * ## 刻意不做的那一半：「停掉个人复习」
 *
 * §9.1 规则表把它归**行 1**（暂停/移除订阅 → **仅停用该授权来源**，其他来源仍有效），
 * 而 `holdObjectiveFromReviewV2` 做的是**行 2**（排除目标 → 优先于笔记与卡片的一切授权）。
 * 拿排除来实现"停个人复习"会**过头**：读者若同时订了笔记订阅，一句"停掉这张卡的复习"
 * 会把笔记那份也停掉——那句话他没说过。所以这一刀只做「开启」；「停」归 W7-3 规则表行 1
 * 的完整实现（按 `reason_code` 精确撤下这一条来源，不碰排除表）。
 */
import { REVIEW_DIMENSION_VALUES_V2 } from "@ailearn/shared/review-dimension-v2";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  DISCRETE_V2_FIRST_INTERVAL_DAYS,
  DISCRETE_V2_POLICY_VERSION,
  discreteV2FirstDueAt,
} from "@ailearn/shared";
import { learningCardsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { noteVersions } from "@ailearn/shared/db-schema/note";
import type { ApiTransaction } from "../../db/client.ts";
import { visibleObjectivesCondition } from "../note/visibility.ts";
import { ensurePendingReviewScheduleV2 } from "./review-schedule-boundary.ts";

export type RoundScopeV1 = { workspaceId: string; userId: string };

/**
 * 排期 `reason_code` 的这一档。与作者的 `activation_authorized` **必须不同**（不变量 ③）；
 * `review_schedules.reason_code` 没有 CHECK，取值自由，但它是一条审计线，也是将来 W7-3
 * 行 1「按来源精确停订」要用来认出"哪一条是个人复习建的"的依据。
 */
export const SHARED_CARD_PERSONAL_REVIEW_REASON = "shared_card_personal_review";

/** 读不到那张卡（不存在／不是 active／没有笔记来源／对本人不可见）——四合一，翻成同一个 404。 */
export class SharedCardNotFoundV2 extends Error {
  constructor() {
    super("card_not_found");
  }
}

export type StartSharedCardPersonalReviewOutcomeV1 =
  /** 排上了新的。 */
  | { readonly status: "started"; readonly cardId: string; readonly objectiveId: string; readonly noteId: string; readonly scheduleId: string; readonly nextReviewAt: string }
  /** 本人已经有一份（笔记订阅或上一次点过）⇒ 沿用它，报**库里那条**的实际日期。 */
  | { readonly status: "already_scheduled"; readonly cardId: string; readonly objectiveId: string; readonly noteId: string; readonly scheduleId: string; readonly nextReviewAt: string }
  /** 本人把这个目标设成了「暂不安排」⇒ 库里什么都没写（§9.1 行 2）。 */
  | { readonly status: "held"; readonly cardId: string; readonly objectiveId: string };

/**
 * 读者开启**自己**的个人复习。
 *
 * 权限与生命周期在一句里判完：卡要在本空间、`lifecycle = 'active'`、**有笔记来源**，
 * 且它的目标**对本人可见**（`visibleObjectivesCondition`）。最后那半句是这一格与作者那一档
 * 最大的差别——作者对自己的东西天然可见，读者要真的能看见这张卡才谈得上「开启」。
 *
 * 可见性落在 **WHERE 里**而不是查出来再判：§10.3 的权限纪律要求读侧**先收窄**，
 * "读出来再遮蔽"那种写法在加字段时会漏。
 */
export async function startSharedCardPersonalReviewV2(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  input: { cardId: string; at?: Date },
): Promise<StartSharedCardPersonalReviewOutcomeV1> {
  const at = input.at ?? new Date();
  const cards = await tx
    .select({
      cardId: learningCardsV2.cardId,
      objectiveId: learningCardsV2.objectiveId,
      noteVersionId: learningCardsV2.noteVersionId,
    })
    .from(learningCardsV2)
    .innerJoin(noteVersions, eq(noteVersions.id, learningCardsV2.noteVersionId))
    .where(and(
      eq(learningCardsV2.workspaceId, scope.workspaceId),
      eq(learningCardsV2.cardId, input.cardId),
      eq(learningCardsV2.lifecycle, "active"),
      // 「共享卡」＝在一篇笔记里的卡。没有来源的卡不归这一格（0274 之后它可空）。
      isNotNull(learningCardsV2.noteVersionId),
      visibleObjectivesCondition(scope.userId, learningCardsV2.objectiveId),
    ))
    .limit(1);
  const card = cards[0];
  if (!card) throw new SharedCardNotFoundV2();

  const ensured = await ensurePendingReviewScheduleV2(tx, {
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    // 排期的主体是**目标**不是卡：D2 §3.1 实测存量 32 行里 `subject_id` 命中 objective 26、
    // 命中 card 4 —— 主体那一列的语义是「可确认的目标 id」。写成 cardId 会让读者这一条与
    // 作者那一条撞不上唯一索引，于是同一份记忆需求被排成两条。
    subjectId: card.objectiveId,
      // §9.1 事实提取与综合应用分别观察。只读成员对已有共享卡开启个人复习，维护的同样是那个提取目标。
      reviewDimension: REVIEW_DIMENSION_VALUES_V2[0],
    // 刻意**没有** reviewDimension：0287 那把唯一键带着维度，而读侧有 21 处还不认识它
    //（`review-schedule-single-writer.test.ts` 的读侧台账逐条登记）。那枚触发器要求第一个
    // 传维度的人先处理读侧——本刀的第一版正是踩了它才改成这样（2026-09-27）。维度是 W7-5 的杠杆。
    // 「开启复习」是持续安排；与「仅提醒这一次」共用这一格唯一键（0297 头注第 1 条）。
    reminderKind: "sustained",
    // 首档形状照 `activation-service.ts` 那一档，一个字都不改（文件头「不做什么」第 1 条）。
    nextReviewAt: discreteV2FirstDueAt(at),
    intervalDays: DISCRETE_V2_FIRST_INTERVAL_DAYS,
    generation: 1,
    policyVersion: DISCRETE_V2_POLICY_VERSION,
    reasonCode: SHARED_CARD_PERSONAL_REVIEW_REASON,
    at,
  });

  if (ensured.held || ensured.scheduleId === null || ensured.nextReviewAt === null) {
    // 边界把「不许排」与「已经排着了」分成两个读数；这里只把前一档往上传。
    if (ensured.held) {
      return { status: "held", cardId: card.cardId, objectiveId: card.objectiveId };
    }
    throw new Error("唯一调度边界说它复用了既有安排，却没有交回 id 与到期时间");
  }
  if (card.noteVersionId === null) throw new SharedCardNotFoundV2();
  return {
    status: ensured.created ? "started" : "already_scheduled",
    cardId: card.cardId,
    objectiveId: card.objectiveId,
    noteId: await resolveNoteIdForVersion(tx, scope.workspaceId, card.noteVersionId),
    scheduleId: ensured.scheduleId,
    nextReviewAt: ensured.nextReviewAt.toISOString(),
  };
}

/** 从卡的 `note_version_id` 取它那篇笔记（回执里要告诉界面"这条挂在哪"，§16.20 要能找回）。 */
async function resolveNoteIdForVersion(
  tx: ApiTransaction,
  workspaceId: string,
  versionId: string,
): Promise<string> {
  const rows = await tx
    .select({ noteId: noteVersions.noteId })
    .from(noteVersions)
    .where(and(eq(noteVersions.id, versionId), eq(noteVersions.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new SharedCardNotFoundV2();
  return row.noteId;
}
