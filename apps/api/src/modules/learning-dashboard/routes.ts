/**
 * Plan 23 W3-06：Dashboard route + ETag。
 * GET /v2/learning-dashboard —— private 缓存语义（user-scoped personal state）；
 * Cache-Control 用 `private, no-cache`：仍强制每次与服务器协商（发条件请求），
 * 但允许 If-None-Match → 304 复用；no-store 会禁用条件请求，使 ETag 形同虚设。
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { scopeOfSession, withWorkspaceTransaction } from "../../db/client.ts";
import { buildLearningDashboardV2 } from "./service.ts";
import { actOnHomeSuggestionV2, actOnTodayBatchV2, readHomeSuggestionV2, readTodayBatchV2 } from "./home-suggestion-service.ts";
import {
  homeSuggestionActionCommandV2Schema,
  todayBatchOptionCommandV2Schema,
} from "@astella/shared/review-queue-v2-contracts";

export async function learningDashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/learning-dashboard", async (req, reply) => {
    const ctx = scopeOfSession(req.session);
    const dashboard = await withWorkspaceTransaction(ctx, (tx) =>
      buildLearningDashboardV2(tx, ctx),
    );
    const etag = '"' + dashboard.dashboardRevision + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    // no-cache（而非 no-store）：每次协商，但 304 可达；dashboardRevision
    // 只哈希稳定内容（见 service.ts），内容不变时返回 304。
    reply.header("cache-control", "private, no-cache");
    return dashboard;
  });

  // ─── 首页「只推一件」（39d W7-4 刀六；39 §12.1）──────────────────────────
  //
  // 两条路由只差一个动作，而**分开写就是两处会分叉**（其中一处很可能忘了把"今天已
  // 略过的那几项"喂回判据）——所以读侧与动作走**同一个服务函数**，动作那一发顺带
  // 交回下一件：屏上按一下「换一个」要立刻看到另一件，而不是"空一下再刷"。
  //
  // `timeZone` **由客户端带上来**而不是服务端猜：§12.1 那句「用户略过后**本次**不
  // 反复推荐同一项」的「本次」按**她的日历日**算（0306），而按 UTC 算会在她的午夜前后
  // 切错一次——那一次恰好是"她刚做完今天"的时候。
  app.get("/v2/home/suggestion", async (req, reply) => {
    const query = req.query as { timeZone?: string };
    const timeZone = (query.timeZone ?? "UTC").trim();
    const suggestion = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => readHomeSuggestionV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
        timeZone,
      }),
    );
    return reply.code(200).header("Cache-Control", "private, no-store").send(suggestion);
  });

  // 今日复习那一批的读侧（39d W7-4 刀十四）。走的是刀一/二/三那一套，所以**这一批
  // 与首页那一件是同一批**。
  app.get("/v2/home/today-batch", async (req, reply) => {
    const query = req.query as { timeZone?: string };
    const batch = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => readTodayBatchV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
        timeZone: (query.timeZone ?? "UTC").trim(),
      }),
    );
    return reply.code(200).header("Cache-Control", "private, no-store").send(batch);
  });

  // 今日复习那三个动作（39d W7-4 刀十二；§12 表「今日复习」行）。**三档走同一发**：
  // 分成三个入口就是三处会分叉，而其中一处很可能忘了把 `remaining` 原样带回判据。
  app.post("/v2/home/today-batch/option", async (req, reply) => {
    const body = todayBatchOptionCommandV2Schema.parse(req.body);
    const result = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => actOnTodayBatchV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
        timeZone: body.timeZone,
        action: body.action,
        reduceBy: body.reduceBy,
      }),
    );
    return reply.code(200).header("Cache-Control", "private, no-store").send(result);
  });

  app.post("/v2/home/suggestion/action", async (req, reply) => {
    const body = homeSuggestionActionCommandV2Schema.parse(req.body);
    const result = await withWorkspaceTransaction(
      scopeOfSession(req.session),
      (tx) => actOnHomeSuggestionV2(tx, { ...scopeOfSession(req.session),
userId: req.session.userId,
        timeZone: body.timeZone,
        itemKey: body.itemKey,
        action: body.action,
      }),
    );
    return reply.code(200).header("Cache-Control", "private, no-store").send(result);
  });
}
