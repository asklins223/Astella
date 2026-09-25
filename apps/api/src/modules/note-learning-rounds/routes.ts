/**
 * 轮次的 HTTP 入口（39d W4-5 第三刀；服务是 `round-service.ts`，合同是
 * `@ailearn/shared/note-learning-round-contracts`）。
 *
 *   POST  /v2/note-learning-rounds                        —— 开一轮（快照与预算都在服务端定）
 *   GET   /v2/notes/:noteId/learning-round                —— 这一篇此刻未完成的那一轮
 *   PATCH /v2/note-learning-rounds/:roundId               —— 状态推进：pause / resume / close
 *   POST  /v2/note-learning-rounds/:roundId/driving-question —— 改写本轮问题
 *
 * 三件事是这一层的职责，不是服务层的：
 *  1. **那一份"实际用 which 正文"由服务端定**（PRD §3.4）。`getNoteWithVersion` 里带着
 *     `visibleNotesCondition` 与"未软删"两道判据，所以"能开一轮"的前提是"这一版正文
 *     现在真的看得见"；客户端传上来的版本 id 一律不用——那等于让一个可能显示着旧屏的
 *     进程决定"按哪一版学习"。摘录集合这里给空集是真的**还没有摘录**（依据是后面
 *     规划那一步产生的），不是"忘了填"。
 *  2. **冲突要把话说全**：`round_already_open` 与 `stale_revision` 都回 409 **并带上那一条
 *     现在的样子**。§3.2 给的出口是「继续它」或「明确封存它」，而 §16.39 要的是"另一份
 *     草稿保留并提示冲突"——两边都只有一句"失败了"就都走不下去。带的那一份是**新开一个
 *     事务**读的：撞索引之后的那个事务已经中止，在里面补读只会得到
 *     `current transaction is aborted`（这条在 09-26 的第二刀里真踩过一次）。
 *  3. **码到 HTTP 状态的映射只写一份**（`STATUS_BY_CODE`）。路由里到处 `reply.code(409)`
 *     迟早会有第二处对同一个码给不同的数。
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import { getNoteWithVersion } from "../note/service.ts";
import {
  advanceNoteLearningRoundRequestV1Schema,
  createNoteLearningRoundRequestV1Schema,
  noteLearningRoundV1Schema,
  reviseDrivingQuestionRequestV1Schema,
  type NoteLearningRoundV1Wire,
} from "@ailearn/shared/note-learning-round-contracts";
import {
  advanceRound,
  createRound,
  readOpenRound,
  readRound,
  reviseDrivingQuestion,
  RoundServiceError,
  type NoteLearningRoundV1,
  type RoundScopeV1,
} from "./round-service.ts";
import { roundBudgetsV1 } from "./round-budgets.ts";

const STATUS_BY_CODE: Record<string, 400 | 404 | 409 | 500> = {
  invalid_driving_question: 400,
  invalid_budget: 400,
  invalid_snapshot: 400,
  note_not_found: 404,
  round_not_found: 404,
  round_already_open: 409,
  stale_revision: 409,
  round_closed: 409,
  invalid_transition: 409,
  outcome_required: 400,
  create_failed: 500,
};

/** 内部形状 → 线上形状：时间是 ISO 字符串，且整份要过合同（合同漂移当场红）。 */
function toWire(round: NoteLearningRoundV1): NoteLearningRoundV1Wire {
  return noteLearningRoundV1Schema.parse({ version: 1, ...round });
}

function scopeOf(req: { session: { workspaceId: string; userId: string } }): RoundScopeV1 {
  return { workspaceId: req.session.workspaceId, userId: req.session.userId };
}

/**
 * 把服务层的码翻译成 HTTP。`withCurrentRound` 那一支是给 409 用的：
 * 再开一个事务把那一条**现在**的样子读出来一起回。
 */
async function replyRoundError(
  reply: FastifyReply,
  err: unknown,
  fallbackMessage: string,
  readCurrent?: (tx: ApiTransaction, scope: RoundScopeV1) => Promise<NoteLearningRoundV1 | null>,
): Promise<FastifyReply> {
  const known = err instanceof RoundServiceError;
  const code = known ? err.code : "unexpected_round_error";
  const message = known ? err.message : fallbackMessage;
  const status = STATUS_BY_CODE[code] ?? 500;
  const body: Record<string, unknown> = { error: code, message };
  if (readCurrent) {
    const scope = { workspaceId: String(reply.request.session?.workspaceId ?? ""), userId: String(reply.request.session?.userId ?? "") };
    const current = await readCurrentInNewTransaction(scope, readCurrent);
    if (current) body.round = toWire(current);
  }
  return reply.code(status).send(body);
}

async function readCurrentInNewTransaction(
  scope: RoundScopeV1,
  readCurrent: (tx: ApiTransaction, scope: RoundScopeV1) => Promise<NoteLearningRoundV1 | null>,
): Promise<NoteLearningRoundV1 | null> {
  if (!scope.workspaceId || !scope.userId) return null;
  try {
    return await withWorkspaceTransaction(scope, (tx) => readCurrent(tx, scope));
  } catch {
    // 带上"现在那一版"是好事，不是必需事：读不到就只回码与那句话，
    // 不许把原本的 409 变成另一个 500。
    return null;
  }
}

export async function noteLearningRoundRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.post("/v2/note-learning-rounds", async (req, reply) => {
    const parsed = createNoteLearningRoundRequestV1Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "开一轮需要的字段不对" });
    }
    const scope = scopeOf(req);
    try {
      const created = await withWorkspaceTransaction(scope, async (tx) => {
        const found = await getNoteWithVersion(tx, parsed.data.noteId, scope.workspaceId, scope.userId);
        if (!found) {
          throw new RoundServiceError("note_not_found", "这一篇笔记现在读不到（不存在、不可见或已被收起）");
        }
        return createRound(tx, scope, {
          noteId: parsed.data.noteId,
          noteVersionId: found.version.id,
          sourceContentHash: found.version.contentHash,
          // 空集是真的"这一轮还没有摘录依据"：依据是后面规划那一步产生的，
          // 不是在这一发里替客户端猜的。
          evidenceSnapshotIds: [],
          drivingQuestion: parsed.data.drivingQuestion,
          drivingQuestionSource: parsed.data.drivingQuestionSource,
          budgets: roundBudgetsV1(),
        });
      });
      return reply.code(201).send({ version: 1 as const, round: toWire(created) });
    } catch (err) {
      return replyRoundError(reply, err, "开这一轮没成功", (tx, s) => readOpenRound(tx, s, parsed.data.noteId));
    }
  });

  app.get("/v2/notes/:noteId/learning-round", async (req, reply) => {
    const noteId = (req.params as { noteId?: string }).noteId ?? "";
    if (!z.string().uuid().safeParse(noteId).success) {
      return reply.code(400).send({ error: "invalid_request", message: "noteId 不是一个合法 id" });
    }
    const scope = scopeOf(req);
    const round = await withWorkspaceTransaction(scope, (tx) => readOpenRound(tx, scope, noteId));
    if (!round) {
      // 这一格 404 不是"页面坏了"：这一篇没有未完成轮次是常态（第一次开始之前）。
      return reply.code(404).send({ error: "round_not_found", message: "这一篇现在没有未完成的轮次" });
    }
    return { version: 1 as const, round: toWire(round) };
  });

  app.patch("/v2/note-learning-rounds/:roundId", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = advanceNoteLearningRoundRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "推进轮次需要的字段不对" });
    }
    const scope = scopeOf(req);
    try {
      const updated = await withWorkspaceTransaction(scope, (tx) =>
        advanceRound(tx, scope, { roundId, expectedRevision: parsed.data.expectedRevision, action: parsed.data.action }),
      );
      return { version: 1 as const, round: toWire(updated) };
    } catch (err) {
      return replyRoundError(reply, err, "推进这一轮没成功", (tx, s) => readRound(tx, s, roundId));
    }
  });

  app.post("/v2/note-learning-rounds/:roundId/driving-question", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = reviseDrivingQuestionRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "改写本轮问题需要的字段不对" });
    }
    const scope = scopeOf(req);
    try {
      const updated = await withWorkspaceTransaction(scope, (tx) =>
        reviseDrivingQuestion(tx, scope, {
          roundId,
          expectedRevision: parsed.data.expectedRevision,
          drivingQuestion: parsed.data.drivingQuestion,
          drivingQuestionSource: parsed.data.drivingQuestionSource,
        }),
      );
      return { version: 1 as const, round: toWire(updated) };
    } catch (err) {
      return replyRoundError(reply, err, "改写本轮问题没成功", (tx, s) => readRound(tx, s, roundId));
    }
  });
}
