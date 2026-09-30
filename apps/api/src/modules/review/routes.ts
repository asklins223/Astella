import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { deferReviewSchedule } from "./review-defer-service.ts";
import { listSanitizedReviews, projectReviewQueueV2, ReviewQueueProjectionError } from "./service.ts";
import { reviewDeferRequestV2Schema } from "@ailearn/shared";
import {
  holdObjectiveFromReviewV2,
  holdObjectiveRequestV2Schema,
  ObjectiveHoldNoteNotFoundV2,
  resumeObjectiveAndScheduleV2,
  resumeObjectiveRequestV2Schema,
} from "./objective-review-holds.ts";
import { paginationQuerySchema } from "../../lib/pagination.ts";
import {
  SharedCardNotFoundV2,
  startSharedCardPersonalReviewV2,
} from "./shared-card-review-service.ts";
import { startSharedCardPersonalReviewV2Schema } from "@ailearn/shared/review-reminder-contracts";

import {
  acknowledgeOneTimeReminderV2,
  OneTimeReminderNoteNotFoundV2,
  requestOneTimeReminderV2,
} from "./one-time-reminder-service.ts";
import {
  activateReviewSubscriptionV2,
  listNoteSubscriptionsV2,
  pauseReviewSubscriptionV2,
  ReviewSubscriptionNoteNotFoundV2,
  reviewSubscriptionCommandV2Schema,
  type SubscriptionChangeV2,
} from "./review-subscriptions.ts";
import { scheduleStudiedNoteTargetsV2 } from "./note-subscription-schedule.ts";
import {
  recordRecallSourceRevealV2,
  RecallRevealError,
} from "./recall-reveal-service.ts";
import {
  acknowledgeOneTimeReminderResultV2Schema,
  acknowledgeOneTimeReminderV2Schema,
  requestOneTimeReminderResultV2Schema,
  requestOneTimeReminderV2Schema,
} from "@ailearn/shared/review-reminder-contracts";
import { buildSimpleErrorBody } from "../../lib/error-envelope.ts";

export async function reviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // Member V2 queue: the desktop client consumes only the strict sanitized
  // identity/startability projection. 分页沿用 R-019 的 (nextReviewAt, id)
  // 复合 cursor：到期队列会在两次翻页之间被复习完成或延后改变长度，offset
  // 翻页会因此静默漏项。
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/v2/reviews/queue",
    async (req, reply) => {
      const parsedQuery = paginationQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return reply.code(400).send({ error: "validation", message: "分页参数非法" });
      }
      const { cursor, limit } = parsedQuery.data;
      try {
        const sanitized = await withWorkspaceTransaction(
          scopeOfSession(req.session),
          (tx) => listSanitizedReviews(req.session.workspaceId, {
            status: "pending",
            limit: limit ?? 50,
            ...(cursor ? { cursor } : {}),
          }, req.session.userId, tx),
        );
        const queue = projectReviewQueueV2(sanitized);
        return reply.header("Cache-Control", "private, no-store").send(queue);
      } catch (error) {
        if (error instanceof ReviewQueueProjectionError) {
          return reply.code(error.statusCode).send(buildSimpleErrorBody(error));
        }
        throw error;
      }
    },
  );

  // 方案 16 §18.1：展示层延后——只写 user_deferred_until，到期队列在延后期内
  // 不再返回这张卡；official nextReviewAt 与 schedule 均不变。
  app.post("/v2/reviews/defer", async (req, reply) => {
    const parsed = reviewDeferRequestV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "延后请求参数非法" });
    }
    const outcome = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => deferReviewSchedule(
        tx,
        scopeOfSession(req.session),
        {
          scheduleId: parsed.data.scheduleId,
          scheduleGeneration: parsed.data.scheduleGeneration,
          deferredUntil: new Date(parsed.data.deferredUntil),
          reasonCode: parsed.data.reasonCode,
        },
      ),
    );
    if (outcome.status === "not_found") {
      return reply.code(404).send({ error: "not_found", message: "复习排期不存在" });
    }
    if (outcome.status === "stale") {
      return reply.code(409).send({ error: "conflict", message: "这张卡的状态已变化，请刷新队列" });
    }
    return reply.header("Cache-Control", "private, no-store").send({
      version: 2 as const,
      scheduleId: outcome.scheduleId,
      scheduleGeneration: outcome.generation,
      userDeferredUntil: outcome.userDeferredUntil,
      officialNextReviewAt: outcome.officialNextReviewAt,
    });
  });

  // ─── W7-3：目标级「暂不安排」（39 §9.1 行 2、行 3）───────────────────────
  //
  // 两条而不是合并成一条"切换"：设与解在规则表里是两件事——设的时候连带撤下已经排着的
  // 那一条待办，解的时候只恢复这一个目标（§9.1 明写"只有用户选择'恢复此目标并开启'
  // 才解除排除；不能暗中复活"）。合并会让"她到底点了什么"在审计里读不出来。
  app.post("/v2/reviews/objectives/hold", async (req, reply) => {
    const parsed = holdObjectiveRequestV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "参数非法" });
    }
    try {
      return await withWorkspaceTransaction(
        scopeOfSession(req.session),
        async (tx) => {
          const held = await holdObjectiveFromReviewV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
            ...parsed.data,
          });
          return reply.code(200).header("Cache-Control", "private, no-store").send({
            objectiveId: held.hold.objectiveId,
            noteId: held.hold.noteId,
            // `created` 与 `dismissedPendingSchedules` 一起回：界面上那句
            // "已经不再安排这个目标"之后要不要补"顺手撤了 N 条待办"，看的是这两个数。
            alreadyHeld: !held.created,
            dismissedPendingSchedules: held.dismissedPendingSchedules,
          });
        },
      );
    } catch (error) {
      if (error instanceof ObjectiveHoldNoteNotFoundV2) {
        return reply.code(404).send({ error: "note_not_found", message: "这篇笔记不在你的书房里" });
      }
      throw error;
    }
  });

  // §9.1 规则表行 3 的组合动作：「恢复此目标并开启」。
  //
  // 2026-09-27 改掉的行为：这一发原来**只**解除排除（`releaseObjectiveHoldV2`），而解除
  // 撤下去的那些排期是 `dismissed`（终态），所以用户点完"恢复"之后那个目标再也不回到
  // 队列——而界面上那颗按钮承诺的是"恢复**并开启**"。解除与排期现在在同一个事务里，
  // 排期走唯一调度边界，不裸 insert。
  app.post("/v2/reviews/objectives/resume", async (req, reply) => {
    const parsed = resumeObjectiveRequestV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "参数非法" });
    }
    const scope = scopeOfSession(req.session);
    try {
      const outcome = await withWorkspaceTransaction(
        scope,
        (tx) => resumeObjectiveAndScheduleV2(tx, {
          ...scope,
          noteId: parsed.data.noteId,
          objectiveId: parsed.data.objectiveId,
          releaseReason: parsed.data.releaseReason,
        }),
      );
      if (outcome.status === "still_held") {
        return reply.code(409).send({
          error: "objective_held",
          message: "这个目标仍在暂不安排中，这次没有开启。",
        });
      }
      return reply.code(200).header("Cache-Control", "private, no-store").send({
        version: 2 as const,
        objectiveId: outcome.objectiveId,
        // `released: false` 如实回：本来就没在排除中不等于"已恢复"，但**排上**了仍要说排上。
        released: outcome.released,
        // 三种说法分开：新建 / 沿用已有的那一格 / 排不动。第三种不是 200。
        scheduled: outcome.status === "resumed_and_scheduled"
          ? "created"
          : "reused_existing",
        scheduleId: outcome.scheduleId,
        nextReviewAt: outcome.nextReviewAt,
      });
    } catch (error) {
      if (error instanceof ObjectiveHoldNoteNotFoundV2) {
        return reply.code(404).send({ error: "note_not_found", message: "这篇笔记不在你的书房里" });
      }
      throw error;
    }
  });

  // ─── W5-4 刀一：「仅提醒这一次」（39 §9.1 末段、§16.24）────────────────────
  //
  // 两条而不是"建一条 / 关一条"合在一个 toggle 里：立的那一条在"这个目标已经被持续
  // 安排"时会交回库里那条 sustained（`created: false`），而关的那一条**只**接受一次性
  // 提醒（持续安排要走订阅的停订/暂停那一行）。合成一颗开关的界面会把这两句规则表
  // 折叠成一次点击，而折叠掉的那部分正是 §9.1 逐行写死的东西。

  /**
   * 「先看笔记」（39d W5-4；PRD §7.1、§16.24）。
   *
   * **它是一次暴露记账，不是导航**：界面点完那颗按钮仍然可以自己跳去笔记页，
   * 而这一发保证"读过正文"这件事落进了 `learning_exposures_v2`——§7.1
   * 「系统随后如实按本次暴露条件处理」里的"随后"就是这一发。
   *
   * 路径挂在 `/v2/reviews/` 下（而不是 learning-runs）：**等待态这一段还没有 run**
   * （题目还在生成），而这一发必须在那时候就成立。
   */
  app.post("/v2/reviews/recall-source-reveal", async (req, reply) => {
    const session = (req as { session?: { workspaceId: string; userId: string } }).session;
    if (!session) return reply.code(401).send({ error: "unauthorized", message: "请先登录" });
    try {
      const result = await withWorkspaceTransaction(
        scopeOfSession(session),
        (tx) => recordRecallSourceRevealV2(
          tx,
          scopeOfSession(session),
          req.body,
        ),
      );
      return reply.code(200).header("Cache-Control", "no-store").send(result);
    } catch (error) {
      if (error instanceof RecallRevealError) {
        return reply.code(error.statusCode).send(buildSimpleErrorBody(error));
      }
      throw error;
    }
  });

  app.post("/v2/reviews/reminders/one-time", async (req, reply) => {
    const parsed = requestOneTimeReminderV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "单次提醒参数非法" });
    }
    const scope = scopeOfSession(req.session);
    try {
      const outcome = await withWorkspaceTransaction(scope, (tx) => requestOneTimeReminderV2(
        tx,
        scope,
        {
          noteId: parsed.data.noteId,
          objectiveId: parsed.data.objectiveId,
          dueAt: new Date(parsed.data.dueAt),
        },
      ));
      if (outcome.status === "held") {
        // 409 而不是 200：这一发没有排上，而"没有排上"要用另一句话对用户说。
        return reply.code(409).send({ error: "objective_held", message: "这个目标已设为暂不安排，没有再排提醒。" });
      }
      return reply.code(201).header("Cache-Control", "private, no-store")
        .send(requestOneTimeReminderResultV2Schema.parse({
          version: 2,
          scheduleId: outcome.scheduleId,
          dueAt: outcome.dueAt,
          reminderKind: outcome.reminderKind,
          created: outcome.created,
          held: false,
        }));
    } catch (error) {
      if (error instanceof OneTimeReminderNoteNotFoundV2) {
        return reply.code(404).send({ error: "note_not_found", message: "这篇笔记不在你的书房里" });
      }
      throw error;
    }
  });

  app.post("/v2/reviews/reminders/acknowledge", async (req, reply) => {
    const parsed = acknowledgeOneTimeReminderV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "处理提醒的参数非法" });
    }
    const scope = scopeOfSession(req.session);
    const outcome = await withWorkspaceTransaction(scope, (tx) => acknowledgeOneTimeReminderV2(
      tx,
      scope,
      { scheduleId: parsed.data.scheduleId, scheduleGeneration: parsed.data.scheduleGeneration },
    ));
    // 先收成功那一档，再谈拒绝——写成四个早退会让 `status` 的收窄读起来像「剩下的肯定是
    // 成功」，而实际成功档本身就是两个字面量的并集，四个 if 之后 TS 收不干净。
    if (outcome.status === "ok" || outcome.status === "already_acknowledged") {
      return reply.header("Cache-Control", "private, no-store")
        .send(acknowledgeOneTimeReminderResultV2Schema.parse({
          version: 2,
          scheduleId: outcome.scheduleId,
          scheduleGeneration: outcome.generation,
          dueAt: outcome.dueAt,
          alreadyAcknowledged: outcome.status === "already_acknowledged",
        }));
    }
    if (outcome.status === "not_found") {
      return reply.code(404).send({ error: "not_found", message: "这条提醒不存在" });
    }
    if (outcome.status === "not_one_time") {
      // 400 而不是 409：它不是「冲突了」，是**这一发命令用错了地方**——用户想要的是
      // 停掉持续订阅，那有自己的入口和自己的回执（§9.1 规则表第一行）。
      return reply.code(400).send({
        error: "not_one_time",
        message: "这个目标在持续安排复习；要停掉它请用暂停或取消订阅。",
      });
    }
    // stale 与 not_pending 都是「这一发按你手上的那一代已经做不到了」，提示刷新而不是报错。
    return reply.code(409).send({ error: "conflict", message: "这条提醒的状态已变化，请刷新后再试" });
  });

  // ─── W5-6 刀四：Member 对已有共享卡开启**本人**的个人复习（§14.4、§16.20）──────────
  //
  // 只做「开启」不做「停」：§9.1 规则表把「暂停/移除订阅」归**行 1**（仅停用该授权来源），
  // 而排除那一档是**行 2**（优先于笔记与卡片的一切授权）。拿排除来实现"停个人复习"会
  // 过头——读者若同时订了笔记订阅，一句"停掉这张卡的复习"会把笔记那份也停掉。
  // 「停」归 W7-3 规则表行 1 的完整实现。
  app.post("/v2/reviews/shared-cards/start-personal-review", async (req, reply) => {
    const parsed = startSharedCardPersonalReviewV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "参数非法" });
    }
    const scope = scopeOfSession(req.session);
    try {
      const outcome = await withWorkspaceTransaction(scope, (tx) => startSharedCardPersonalReviewV2(
        tx,
        scope,
        { cardId: parsed.data.cardId },
      ));
      if (outcome.status === "held") {
        // 409：这一发没有排上，而「没有排上」要用另一句话对用户说（§9.1 行 2）。
        return reply.code(409).send({
          error: "objective_held",
          message: "你把这个目标设为暂不安排了，所以没有新排提醒。",
        });
      }
      return reply.code(outcome.status === "started" ? 201 : 200)
        .header("Cache-Control", "private, no-store")
        .send({
          version: 2 as const,
          cardId: outcome.cardId,
          objectiveId: outcome.objectiveId,
          noteId: outcome.noteId,
          // 两种说法分开：新建／沿用已有的那一格。合成一个布尔，界面会把两件不同的事
          // 念成同一句（与「仅提醒这一次」那一档同一个理由）。
          scheduled: outcome.status === "started" ? "created" : "reused_existing",
          scheduleId: outcome.scheduleId,
          nextReviewAt: outcome.nextReviewAt,
        });
    } catch (error) {
      if (error instanceof SharedCardNotFoundV2) {
        return reply.code(404).send({ error: "card_not_found", message: "这张学习卡不在你的书房里" });
      }
      throw error;
    }
  });

  // ─── W7-3 刀五：订阅来源分别开停（39 §9.1 第一段与规则表行 1）────────────
  //
  // **两条而不是一颗 toggle**：§9.1 明写"两种意图可以分别存在"，规则表行 1
  // 写的是「暂停/移除笔记订阅或卡片订阅 ⇒ **仅停用该授权来源**」。合成一颗开关
  // 会把"停哪一个"这个用户在按之前必须能选的东西变成系统的默认——那正是"偷偷
  // 联动"，只是换了个更隐蔽的形状。
  //
  // `stillCoveredBy` 是这一格存在的理由（§9.1 行 1「其他来源仍有效时**显示原因**」）：
  // 停掉笔记订阅而那张卡还单独开着时，屏上必须说"仍由卡片复习继续安排"，而不是
  // 显示成已停。两个字段都回，是因为"这次没改动"（连点两下）与"停掉了但别人还
  // 撑着"是两件不同的事，合成一个布尔会被念成同一句。
  const subscriptionBody = (change: SubscriptionChangeV2) => ({
    source: change.subscription.source,
    subjectType: change.subscription.subjectType,
    subjectId: change.subscription.subjectId,
    status: change.subscription.status,
    scopeNote: change.subscription.scopeNote,
    createdAt: change.subscription.createdAt,
    pausedAt: change.subscription.pausedAt,
    changed: change.changed,
    stillCoveredBy: change.stillCoveredBy,
  });

  app.post("/v2/reviews/subscriptions/activate", async (req, reply) => {
    const parsed = reviewSubscriptionCommandV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "参数非法" });
    }
    try {
      const change = await withWorkspaceTransaction(
        scopeOfSession(req.session),
        async (tx) => {
          const change = await activateReviewSubscriptionV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
            ...parsed.data,
          });
          if (parsed.data.source === "note_subscription") {
            await scheduleStudiedNoteTargetsV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
              noteId: parsed.data.subjectId,
              at: new Date(),
            });
          }
          return change;
        },
      );
      return reply.code(200).header("Cache-Control", "private, no-store").send(subscriptionBody(change));
    } catch (error) {
      if (error instanceof ReviewSubscriptionNoteNotFoundV2) {
        return reply.code(404).send({ error: "note_not_found", message: "这篇笔记不在你的书房里" });
      }
      throw error;
    }
  });

  app.post("/v2/reviews/subscriptions/pause", async (req, reply) => {
    const parsed = reviewSubscriptionCommandV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "参数非法" });
    }
    try {
      const change = await withWorkspaceTransaction(
        scopeOfSession(req.session),
        (tx) => pauseReviewSubscriptionV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
          ...parsed.data,
        }),
      );
      return reply.code(200).header("Cache-Control", "private, no-store").send(subscriptionBody(change));
    } catch (error) {
      if (error instanceof ReviewSubscriptionNoteNotFoundV2) {
        return reply.code(404).send({ error: "note_not_found", message: "这篇笔记不在你的书房里" });
      }
      throw error;
    }
  });

  // 笔记那一屏的读侧：她订阅了哪几篇，**连暂停的也列出来**——开关要能拨回"开"，
  // 只列活着的那一批就等于"停过的那篇从此找不到"。
  app.get("/v2/reviews/subscriptions/notes", async (req, reply) => {
    const items = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => listNoteSubscriptionsV2(tx, scopeOfSession(req.session)),
    );
    return reply.code(200).header("Cache-Control", "private, no-store").send({ version: 2, items });
  });
}
