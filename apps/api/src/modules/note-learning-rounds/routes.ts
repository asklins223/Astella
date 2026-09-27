/**
 * 轮次的 HTTP 入口（39d W4-5 第三刀；服务是 `round-service.ts`，合同是
 * `@ailearn/shared/note-learning-round-contracts`）。
 *
 *   POST  /v2/note-learning-rounds                        —— 开一轮（快照与预算都在服务端定）
 *   GET   /v2/notes/:noteId/learning-round                —— 这一篇此刻未完成的那一轮
 *   GET   /v2/notes/:noteId/learning-rounds               —— 这一篇的轮次记录（§10.3，读侧第一刀）
 *   PATCH /v2/note-learning-rounds/:roundId               —— 状态推进：pause / resume / close
 *   POST  /v2/note-learning-rounds/:roundId/driving-question —— 改写本轮问题
 *   POST  /v2/note-learning-rounds/:roundId/teaching      —— 生成一条教学产物（W4-6 刀一）
 *   GET   /v2/note-learning-rounds/:roundId/teaching      —— 读这一轮当前问题下的那条教学产物
 *   GET   /v2/note-learning-round-artifacts/:artifactId   —— 按 id 取整份动态产物 HTML（W4-6 刀五，不套信封）
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
import { sql } from "drizzle-orm";
import {
  currentApiWorkspaceTransaction,
  withWorkspaceTransaction,
  type ApiTransaction,
} from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import { getNoteWithVersion } from "../note/service.ts";
import type { NoteLearningRoundRow } from "@ailearn/shared/db-schema/note-learning-rounds";
import {
  advanceNoteLearningRoundRequestV1Schema,
  appendRoundPlanRevisionRequestV1Schema,
  createNoteLearningRoundRequestV1Schema,
  createRoundTeachingRequestV1Schema,
  noteLearningRoundHistoryQueryV1Schema,
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundV1Schema,
  noteLearningRoundViewV1Schema,
  noteRoundContentMovedV1,
  reopenNoteLearningRoundRequestV1Schema,
  reviseDrivingQuestionRequestV1Schema,
  roundGapHelpV1Schema,
  roundPracticeStartV1Schema,
  roundPlanViewV1Schema,
  roundTeachingArtifactRefV1Schema,
  roundTeachingViewV1Schema,
  type NoteLearningRoundV1Wire,
  type RoundPracticeStartV1,
  type RoundPracticeV1,
} from "@ailearn/shared/note-learning-round-contracts";
import {
  advanceRound,
  appendPlanRevision,
  countTeachings,
  createRound,
  createTeaching,
  findReusableTeaching,
  listRoundHistory,
  listPersonalRoundHistory,
  type RoundHistoryFactsV1,
  readRoundHistoryFactsV1,
  listPlanRevisions,
  readNoteCurrentSourceHashV1,
  reopenRoundWithCurrentContent,
  readOpenRound,
  readRound,
  readRoundArtifactHtml,
  readTeachingArtifactRef,
  reviseDrivingQuestion,
  RoundServiceError,
  type NoteLearningRoundV1,
  type RoundScopeV1,
} from "./round-service.ts";
import {
  loadTeachingSnapshotBlocks,
  runTeachingExplainV1,
  teachingFailureResponseV1,
} from "./teaching-explain.ts";
import type { TeachingExplainProviderV1 } from "./teaching-explain.ts";
import { llmTeachingExplainProvider, resolveTeachingModelConfig } from "./teaching-llm.ts";
import { buildRoundReadingPlan, suggestRoundQuestion } from "./learning-plan.ts";
import { requireAiConsent } from "../identity/ai-consent-gate.ts";
import { finishRoundModelAttempt, reserveRoundModelAttempt, type RoundModelAttempt } from "./model-attempt.ts";
import { listNoteRoundPractices } from "../learning-runs/run-service.ts";
import { readRoundGapHelpV1 } from "../learning-runs/gap-help-service.ts";
import { assembleObjectiveSurfaceV3, listObjectiveSurfacesV3 } from "../learning-objectives/surface-service.ts";
import { createRoundTargetGrounder, type RoundTargetGrounder } from "./target-grounding.ts";
import { persistRoundTarget, readRoundTargetId } from "./round-target.ts";
import { roundBudgetsV1 } from "./round-budgets.ts";
import { noteReflectionRoutes } from "./reflection-routes.ts";

const STATUS_BY_CODE: Record<string, 400 | 404 | 409 | 500 | 503> = {
  invalid_driving_question: 400,
  invalid_budget: 400,
  invalid_plan_revision: 400,
  invalid_snapshot: 400,
  invalid_teaching_content: 400,
  note_not_found: 404,
  round_not_found: 404,
  invalid_cursor: 400,
  round_already_open: 409,
  stale_revision: 409,
  round_closed: 409,
  round_budget_exhausted: 409,
  teaching_in_progress: 409,
  teaching_model_unconfigured: 503,
  invalid_transition: 409,
  outcome_required: 400,
  create_failed: 500,
};

/** 内部形状 → 线上形状：时间是 ISO 字符串，且整份要过合同（合同漂移当场红）。 */
/**
 * 轮次回信的那一层信封，**四个出口共用这一份**（开一轮／读这一轮／推进／改问题）。
 * `contentMoved` 由读侧现算：这一轮冻的是哪一版正文写在轮次行上，而"现在那一版是谁"
 * 只有这一刻读得到（D3 §5.1：时机就是"打开这一篇读那一轮"与"恢复那一发"）。
 */
async function roundViewWire(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  round: NoteLearningRoundV1,
) {
  return noteLearningRoundViewV1Schema.parse({
    version: 1 as const,
    round: toWire(round),
    contentMoved: noteRoundContentMovedV1({
      frozenSourceContentHash: round.sourceContentHash,
      currentSourceContentHash: await readNoteCurrentSourceHashV1(tx, scope, round.noteId),
    }),
  });
}

function toWire(round: NoteLearningRoundV1): NoteLearningRoundV1Wire {
  return noteLearningRoundV1Schema.parse({ version: 1, ...round });
}

/**
 * 一条轮次行 → 记录那一行（两个级别共用这一份，W4-8 刀二）：两格事实的取法与
 * 「实际方式」的固定次序（讲过在前）只在这里说一次；本人那一级多带的两格由调用方补。
 */
function roundHistoryItemV1(
  row: NoteLearningRoundRow,
  facts: RoundHistoryFactsV1,
): Record<string, unknown> {
  return {
    roundId: row.id,
    phase: row.phase,
    outcome: row.outcome,
    drivingQuestion: row.drivingQuestion,
    drivingQuestionSource: row.drivingQuestionSource,
    drivingQuestionRevision: row.drivingQuestionRevision,
    // 「实际方式」的次序固定（讲过在前），由**有没有发生**决定，不随查询回来的次序变。
    actualModes: [
      ...(facts.explainedRoundIds.has(row.id) ? ["explained" as const] : []),
      ...(facts.practicedRoundIds.has(row.id) ? ["practiced" as const] : []),
    ],
    systemUncertain: facts.uncertainRoundIds.has(row.id),
    followUpSettledAt: facts.followUpSettledAtByRoundId.get(row.id) ?? null,
    startedAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
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

export async function noteLearningRoundRoutes(app: FastifyInstance, options: {
  /** Explicit offline transport for tests; production always resolves a real model. */
  teaching?: { provider: TeachingExplainProviderV1; modelId: string; external: boolean };
  targetGrounder?: RoundTargetGrounder;
} = {}) {
  const modelConfig = resolveTeachingModelConfig();
  const teaching = options.teaching ?? {
    provider: llmTeachingExplainProvider({ config: modelConfig }),
    modelId: modelConfig?.model ?? "unconfigured", external: true,
  };
  const targetGrounder = options.targetGrounder ?? createRoundTargetGrounder(modelConfig);
  app.addHook("preHandler", requireSession);
  noteReflectionRoutes(app);

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
        const blocks = await loadTeachingSnapshotBlocks(tx, scope.workspaceId, found.version.id);
        const question = parsed.data.drivingQuestion ?? suggestRoundQuestion(found.note.title, blocks);
        const round = await createRound(tx, scope, {
          noteId: parsed.data.noteId,
          noteVersionId: found.version.id,
          sourceContentHash: found.version.contentHash,
          // 空集是真的"这一轮还没有摘录依据"：依据是后面规划那一步产生的，
          // 不是在这一发里替客户端猜的。
          evidenceSnapshotIds: [],
          drivingQuestion: question,
          drivingQuestionSource: parsed.data.drivingQuestion ? parsed.data.drivingQuestionSource : "suggested",
          budgets: roundBudgetsV1(),
        });
        await appendPlanRevision(tx, scope, {
          roundId: round.roundId, expectedRevision: round.revision,
          plan: buildRoundReadingPlan(question, blocks), reason: "按本轮问题和已保存的正文安排最初阅读路线",
        });
        return (await readRound(tx, scope, round.roundId))!;
      });
      return reply.code(201).send(await withWorkspaceTransaction(scope, (tx) =>
        roundViewWire(tx, scope, created),
      ));
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
    const view = await withWorkspaceTransaction(scope, async (tx) => {
      const round = await readOpenRound(tx, scope, noteId);
      return round ? roundViewWire(tx, scope, round) : null;
    });
    if (!view) {
      // 这一格 404 不是"页面坏了"：这一篇没有未完成轮次是常态（第一次开始之前）。
      return reply.code(404).send({ error: "round_not_found", message: "这一篇现在没有未完成的轮次" });
    }
    return view;
  });

  app.get("/v2/notes/:noteId/learning-rounds", async (req, reply) => {
    const noteId = (req.params as { noteId?: string }).noteId ?? "";
    const parsedQuery = noteLearningRoundHistoryQueryV1Schema.safeParse(req.query ?? {});
    if (!z.string().uuid().safeParse(noteId).success || !parsedQuery.success) {
      return reply.code(400).send({ error: "invalid_request", message: "读这一篇的轮次记录需要的字段不对" });
    }
    const scope = scopeOf(req);
    let page;
    let facts;
    try {
      ({ page, facts } = await withWorkspaceTransaction(scope, async (tx) => {
        const history = await listRoundHistory(tx, scope, noteId, {
          limit: parsedQuery.data.limit,
          beforeRoundId: parsedQuery.data.before,
        });
        // 两格事实按**本页那几条**去数（同一份 RLS 上下文、同一发事务）：
        // 先分页再数，而不是先数再分页——后者会把"这一篇前 20 轮"变成"全篇扫一遍"。
        const historyFacts = await readRoundHistoryFactsV1(tx, history.rows.map((row) => row.id));
        return { page: history, facts: historyFacts };
      }));
    } catch (err) {
      // 游标来路不对是**调用方的错**（`invalid_cursor` → 400），不吞成空页：
      // 空页会被界面读成"我的记录少了"，而真实原因是给了一个不属于这一篇的指针。
      return replyRoundError(reply, err, "读这一篇的轮次记录没成功");
    }
    // 回信整份过一遍合同：漂移要红在这里，而不是红成客户端"某一格 undefined"。
    return noteLearningRoundHistoryPageV1Schema.parse({
      version: 1 as const,
      noteId,
      items: page.rows.map((row) => roundHistoryItemV1(row, facts)),
      hasMore: page.hasMore,
      // 游标就是本页最后那一条的 id（有"更早的"才给指针，两者不许分叉）。
      nextCursor: page.hasMore && page.rows.length > 0 ? page.rows[page.rows.length - 1].id : null,
      shownCount: page.shownCount,
      // 与游标无关的那个数：这一篇一共开过几轮（服务层用加游标前的条件算）。
      totalCount: page.totalCount,
    });
  });

  /**
   * 记录的第二级：本人（跨笔记）那一页（PRD §10.3；39d W4-8 刀二）。
   *
   * 路径取 `GET /v2/note-learning-rounds`——与"开一轮"同路径不同方法，而不是再造一个
   * 长得像 `/v2/learning-runs`（那是 run 族）的名字：那两个字符串在日志里差一个字母，
   * 在人的眼睛里不差。查询参数直接复用按笔记那一份合同（形状同一件事，不抄第二份）。
   */
  app.get("/v2/note-learning-rounds", async (req, reply) => {
    const parsedQuery = noteLearningRoundHistoryQueryV1Schema.safeParse(req.query ?? {});
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: "invalid_request", message: "读我的轮次记录需要的字段不对" });
    }
    const scope = scopeOf(req);
    let page;
    let facts;
    try {
      ({ page, facts } = await withWorkspaceTransaction(scope, async (tx) => {
        const history = await listPersonalRoundHistory(tx, scope, {
          limit: parsedQuery.data.limit,
          beforeRoundId: parsedQuery.data.before,
        });
        return {
          page: history,
          facts: await readRoundHistoryFactsV1(tx, history.rows.map((row) => row.round.id)),
        };
      }));
    } catch (err) {
      return replyRoundError(reply, err, "读我的轮次记录没成功");
    }
    return noteLearningRoundPersonalHistoryPageV1Schema.parse({
      version: 1 as const,
      items: page.rows.map((row) => ({
        ...roundHistoryItemV1(row.round, facts),
        noteId: row.noteId,
        noteTitle: row.noteTitle,
      })),
      hasMore: page.hasMore,
      nextCursor: page.hasMore && page.rows.length > 0 ? page.rows[page.rows.length - 1].round.id : null,
      shownCount: page.shownCount,
      totalCount: page.totalCount,
    });
  });

  app.patch("/v2/note-learning-rounds/:roundId", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = advanceNoteLearningRoundRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "推进轮次需要的字段不对" });
    }
    const scope = scopeOf(req);
    try {
      return await withWorkspaceTransaction(scope, async (tx) => roundViewWire(tx, scope, await
        advanceRound(tx, scope, { roundId, expectedRevision: parsed.data.expectedRevision, action: parsed.data.action })));
    } catch (err) {
      return replyRoundError(reply, err, "推进这一轮没成功", (tx, s) => readRound(tx, s, roundId));
    }
  });

  /**
   * 「按当前内容新开一轮」（PRD §4.3 后半件）。封存旧的那一条与新建这一条在**同一发事务**里，
   * 失败整体回滚——分开两次就会有一个窗口"旧轮已封存、新轮没建成"，用户看到的是那一轮没了。
   * 回信是新那一轮的信封：界面拿它的 `round` 换掉手上那一条，`contentMoved` 也随之回到 false。
   */
  app.post("/v2/note-learning-rounds/:roundId/reopen", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = reopenNoteLearningRoundRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "另起一轮需要的字段不对" });
    }
    const scope = scopeOf(req);
    try {
      return await withWorkspaceTransaction(scope, async (tx) => {
        const current = await readRound(tx, scope, roundId);
        if (!current) {
          throw new RoundServiceError("round_not_found", "这一轮读不到（不是你的，或已经没有了）");
        }
        const found = await getNoteWithVersion(tx, current.noteId, scope.workspaceId, scope.userId);
        if (!found) {
          throw new RoundServiceError("note_not_found", "这一篇笔记现在读不到（不存在、不可见或已被收起）");
        }
        const { reopened } = await reopenRoundWithCurrentContent(tx, scope, {
          roundId,
          expectedRevision: parsed.data.expectedRevision,
          noteVersionId: found.version.id,
          sourceContentHash: found.version.contentHash,
          budgets: roundBudgetsV1(),
        });
        const blocks = await loadTeachingSnapshotBlocks(tx, scope.workspaceId, reopened.noteVersionId);
        await appendPlanRevision(tx, scope, {
          roundId: reopened.roundId, expectedRevision: reopened.revision,
          plan: buildRoundReadingPlan(reopened.drivingQuestion, blocks), reason: "按当前已保存正文重新安排本轮阅读路线",
        });
        return roundViewWire(tx, scope, (await readRound(tx, scope, reopened.roundId))!);
      });
    } catch (err) {
      return replyRoundError(reply, err, "按当前内容另起一轮没成功", (tx, s) => readRound(tx, s, roundId));
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
      return await withWorkspaceTransaction(scope, async (tx) => {
        const current = await readRound(tx, scope, roundId);
        if (!current) throw new RoundServiceError("round_not_found", "这一轮现在读不到");
        if (!await getNoteWithVersion(tx, current.noteId, scope.workspaceId, scope.userId)) throw new RoundServiceError("note_not_found", "这篇笔记现在不可见");
        const revised = await reviseDrivingQuestion(tx, scope, {
          roundId,
          expectedRevision: parsed.data.expectedRevision,
          drivingQuestion: parsed.data.drivingQuestion,
          drivingQuestionSource: parsed.data.drivingQuestionSource,
        });
        const blocks = await loadTeachingSnapshotBlocks(tx, scope.workspaceId, revised.noteVersionId);
        await appendPlanRevision(tx, scope, {
          roundId, expectedRevision: revised.revision,
          plan: buildRoundReadingPlan(revised.drivingQuestion, blocks), reason: "本轮问题已改写，按原有正文快照重新安排阅读路线",
        });
        return roundViewWire(tx, scope, (await readRound(tx, scope, roundId))!);
      });
    } catch (err) {
      return replyRoundError(reply, err, "改写本轮问题没成功", (tx, s) => readRound(tx, s, roundId));
    }
  });

  app.get("/v2/note-learning-rounds/:roundId/plans", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    if (!z.string().uuid().safeParse(roundId).success) return reply.code(400).send({ error: "invalid_request" });
    const scope = scopeOf(req);
    try {
      return await withWorkspaceTransaction(scope, async (tx) => {
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮现在读不到");
        if (!await getNoteWithVersion(tx, round.noteId, scope.workspaceId, scope.userId)) throw new RoundServiceError("note_not_found", "这篇笔记现在不可见");
        return roundPlanViewV1Schema.parse({ version: 1, round: toWire(round), plans: await listPlanRevisions(tx, scope, roundId) });
      });
    } catch (err) { return replyRoundError(reply, err, "读这一轮计划没成功"); }
  });

  app.post("/v2/note-learning-rounds/:roundId/plans", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = appendRoundPlanRevisionRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const scope = scopeOf(req);
    try {
      return await withWorkspaceTransaction(scope, async (tx) => {
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮现在读不到");
        if (!await getNoteWithVersion(tx, round.noteId, scope.workspaceId, scope.userId)) throw new RoundServiceError("note_not_found", "这篇笔记现在不可见");
        await appendPlanRevision(tx, scope, { roundId, ...parsed.data });
        return roundPlanViewV1Schema.parse({ version: 1, round: toWire((await readRound(tx, scope, roundId))!), plans: await listPlanRevisions(tx, scope, roundId) });
      });
    } catch (err) { return replyRoundError(reply, err, "调整这一轮计划没成功", (tx, s) => readRound(tx, s, roundId)); }
  });

  /**
   * 生成一条教学产物（W4-6）。
   *
   * 三相与制卡漏斗同形（W3-2 第三刀那条纪律）：短事务只读冻结输入 → **事务外**跑内核任务
   * → 短事务只写。中间那一段拿不到 tx，"持锁等模型"在这条链上写不出来。
   *
   * 幂等：同快照、同问题版本的已有解释直接回（200），不重跑也不重付；真的生成了才是 201。
   */
  app.post("/v2/note-learning-rounds/:roundId/teaching", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = createRoundTeachingRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "生成这一条解释需要的字段不对" });
    }
    const scope = scopeOf(req);
    if (teaching.external) {
      await requireAiConsent(req, reply);
      if (reply.sent) return;
    }
    /** 相位 1 的产物：要么"已经有一条可复用的"，要么"冻结好了输入、等着生成"。 */
    type FrozenPhase1 = { round: NoteLearningRoundV1 } & (
      | { kind: "reused"; teaching: NonNullable<Awaited<ReturnType<typeof findReusableTeaching>>>;
          extras: Awaited<ReturnType<typeof buildRoundTeachingExtras>> }
      | { kind: "generate"; ordinal: number; input: Awaited<ReturnType<typeof buildFrozenTeachingInput>>; attempt: RoundModelAttempt }
    );
    let frozen: FrozenPhase1;
    try {
      frozen = await withWorkspaceTransaction(scope, async (tx): Promise<FrozenPhase1> => {
        await tx.execute(sql`SELECT id FROM note_learning_rounds WHERE id = ${roundId}
          AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} FOR UPDATE`);
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
        if (round.phase === "closed") {
          throw new RoundServiceError("round_closed", "这一轮已经收尾，终态只读：不再生成新的教学内容");
        }
        if (round.revision !== parsed.data.expectedRevision) {
          throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
        }
        if (!await getNoteWithVersion(tx, round.noteId, scope.workspaceId, scope.userId)) {
          throw new RoundServiceError("note_not_found", "这篇笔记现在不可见，不能继续生成内容");
        }
        // 「换一种解释」（`regenerate`）**跳过复用**：同一问题下再落一条（序号 +1），
        // 旧那条留着（§6「换解释才产生新版本」）。默认那一档仍然先看有没有可复用的。
        const reused = parsed.data.regenerate
          ? null
          : await findReusableTeaching(tx, scope, {
            roundId,
            kind: "explanation",
            drivingQuestionRevision: round.drivingQuestionRevision,
            snapshotHash: round.sourceContentHash,
          });
        if (reused) return { round, kind: "reused", teaching: reused,
          extras: await buildRoundTeachingExtras(tx, scope, round, reused.teachingId) };
        if (teaching.modelId === "unconfigured") {
          throw new RoundServiceError("teaching_model_unconfigured", "讲解模型尚未配置，已有内容保留；请先配置 AI 服务");
        }
        const used = await countTeachings(tx, scope, roundId);
        const attempt = await reserveRoundModelAttempt(tx, scope, round, teaching.modelId);
        return { round, kind: "generate", ordinal: used + 1, input: await buildFrozenTeachingInput(tx, scope, round), attempt };
      });
    } catch (err) {
      return replyRoundError(reply, err, "生成这一条解释没成功", (tx, s) => readRound(tx, s, roundId));
    }

    if (frozen.kind === "reused") {
      return reply.code(200).send(roundTeachingViewV1Schema.parse({
        version: 1 as const,
        round: toWire(frozen.round),
        teaching: frozen.teaching,
        ...frozen.extras,
      }));
    }

    // ── 相位 2：事务外生成（内核会自己核"当前有没有活动事务"，W3-2 那道闸门同样管这条链）──
    const generated = await runTeachingExplainV1({
      provider: teaching.provider,
      modelId: teaching.modelId,
      maxModelCalls: Math.min(2, frozen.attempt.maxCalls),
      maxDurationMs: Math.max(1, frozen.attempt.deadlineAt - Date.now()),
      attemptId: frozen.attempt.id,
      input: frozen.input,
      scope,
      round: {
        roundId: frozen.round.roundId,
        noteVersionId: frozen.round.noteVersionId,
        sourceContentHash: frozen.round.sourceContentHash,
      },
      ordinal: frozen.ordinal,
      currentActiveTransaction: currentApiWorkspaceTransaction,
      reportDevelopmentError: (message) => req.log.error({ scope: "note-round-teaching" }, message),
    });
    if (!generated.ok) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, generated.modelCalls, false));
      const mapped = teachingFailureResponseV1(generated);
      return reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
    }
    // Independently check the explanation as well as the optional private target.
    // Explicit offline fixtures without a grounder use their recorded teaching; production never skips this gate.
    const grounded = teaching.external || options.targetGrounder || generated.output.target ? await targetGrounder({
      target: generated.output.target ?? null, teaching: { explanation: generated.output.explanation, example: generated.output.example },
      input: frozen.input, maxCalls: frozen.attempt.maxCalls - generated.modelCalls,
      maxDurationMs: frozen.attempt.deadlineAt - Date.now(), scope,
      round: { roundId, noteVersionId: frozen.round.noteVersionId, sourceContentHash: frozen.round.sourceContentHash },
      attemptId: frozen.attempt.id, currentActiveTransaction: currentApiWorkspaceTransaction,
    }) : { approved: false, report: { teachingSupported: true, teachingReason: "explicit offline fixture", teachingSegments: [], objectiveSupported: false, units: [] }, modelCalls: 0 };
    const modelCalls = generated.modelCalls + grounded.modelCalls;
    if (!grounded.report?.teachingSupported) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      return reply.code(422).send({ error: "teaching_grounding_failed",
        message: "这次讲解的依据还没核对通过，暂时没有展示；可以重试或先继续读笔记" });
    }

    // ── 相位 3：短事务写（只追加；轮内序号在服务层算）──
    try {
      const written = await withWorkspaceTransaction(scope, async (tx) => {
        // Re-check access after the external call, before persisting protected text or targets.
        if (!await getNoteWithVersion(tx, frozen.round.noteId, scope.workspaceId, scope.userId)) {
          throw new RoundServiceError("note_not_found", "这篇笔记的访问权限已经变化，请重新打开");
        }
        await finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, true);
        const teaching = await createTeaching(
          tx,
          scope,
          {
            roundId,
            expectedRevision: parsed.data.expectedRevision,
            kind: "explanation",
            content: {
              explanation: generated.output.explanation,
              ...(generated.output.example ? { example: generated.output.example } : {}),
            },
            sourceBlockOrdinals: generated.output.sourceBlockOrdinals,
            snapshotHash: frozen.round.sourceContentHash,
            drivingQuestionRevision: frozen.round.drivingQuestionRevision,
            kernelTaskRef: generated.attemptRef,
            // 刀五：动态版本的输入就是这一条解释本身（＋相位 1 冻结的那版计划步骤）。
            artifact: {
              explanation: generated.output.explanation,
              ...(generated.output.example ? { example: generated.output.example } : {}),
              planSteps: frozen.input.planSteps,
            },
          },
          {
            // 产物失败不许让教学生成失败（D4 §6.2）：原因只留在服务端日志里。
            reportArtifactFailure: (message) => req.log.error({ scope: "note-round-artifact" }, message),
          },
        );
        if (grounded.approved && grounded.report && generated.output.target) {
          await persistRoundTarget(tx, scope, frozen.round, frozen.input, generated.output.target, grounded.report);
        }
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
        return { round, teaching, extras: await buildRoundTeachingExtras(tx, scope, round, teaching.teachingId) };
      });
      return reply.code(201).send(roundTeachingViewV1Schema.parse({
        version: 1 as const,
        round: toWire(written.round),
        teaching: written.teaching,
        ...written.extras,
      }));
    } catch (err) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      return replyRoundError(reply, err, "这一条解释生成了但没能存下来", (tx, s) => readRound(tx, s, roundId));
    }
  });

  /**
   * 读这一轮**当前问题版本**下的那条解释（W4-6 刀一）。
   *
   * 只回与当前问题版本、当前快照匹配的那一条：问题被改写之后，旧问题下的解释不再代表
   * 这一轮现在问的事——那种情况下诚实地说"还没有解释"（`teaching: null`），而不是把
   * 上一版问题的解释摆在这一版问题下面。
   */
  app.get("/v2/note-learning-rounds/:roundId/teaching", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    if (!z.string().uuid().safeParse(roundId).success) {
      return reply.code(400).send({ error: "invalid_request", message: "roundId 不是一个合法 id" });
    }
    const scope = scopeOf(req);
    let view;
    try {
      view = await withWorkspaceTransaction(scope, async (tx) => {
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
        if (!await getNoteWithVersion(tx, round.noteId, scope.workspaceId, scope.userId)) {
          throw new RoundServiceError("note_not_found", "这篇笔记现在不可见，不能继续展示讲解");
        }
        const teaching = await findReusableTeaching(tx, scope, {
          roundId,
          kind: "explanation",
          drivingQuestionRevision: round.drivingQuestionRevision,
          snapshotHash: round.sourceContentHash,
        });
        return { round, teaching, extras: await buildRoundTeachingExtras(tx, scope, round, teaching?.teachingId ?? null) };
      });
    } catch (err) {
      return replyRoundError(reply, err, "读这一条解释没成功");
    }
    return roundTeachingViewV1Schema.parse({
      version: 1 as const,
      round: toWire(view.round),
      teaching: view.teaching,
      ...view.extras,
    });
  });

  /**
   * 按 id 取整份动态产物 HTML（W4-6 刀五；表 0285）。
   *
   * **不套 JSON 信封**：消费方是桌面主进程，它要的是字节原样落盘
   * （`<userData>/artifacts/<id>.html`），包一层信封就得多一次拆封与一次转义。
   * 单屏渲染也不在这里做——产物是"整份拒绝"的（超配额在写入那一刻已经挡住），
   * 取到多少就交多少。
   *
   * 会话与 RLS 照旧：命中不了（不存在、别人的、或已被维护路径清掉）一律 404，
   * **不在响应里区分这三种**——"这个 id 存不存在"本身也是一条不该漏的读。
   */
  app.get("/v2/note-learning-round-artifacts/:artifactId", async (req, reply) => {
    const artifactId = (req.params as { artifactId?: string }).artifactId ?? "";
    if (!z.string().uuid().safeParse(artifactId).success) {
      return reply.code(400).send({ error: "invalid_request", message: "artifactId 不是一个合法 id" });
    }
    const scope = scopeOf(req);
    const html = await withWorkspaceTransaction(scope, (tx) => readRoundArtifactHtml(tx, scope, artifactId));
    if (html === null) {
      return reply.code(404).send({ error: "artifact_not_found", message: "这份动态产物现在读不到（不存在或不可见）" });
    }
    return reply.type("text/html; charset=utf-8").send(html);
  });
}

/**
 * 教学面额外那几格（W4-6 刀三＋刀五）：这一轮**练过哪几道**、「练一道」那一发的**起点**，
 * 以及**这一条教学的动态版本引用**（刀五：只带引用，HTML 由主进程按 id 另取）。
 *
 * `teachingId` 是"这一屏上摆的是哪一条教学产物"：`null`（还没生成过教学产物）⇒
 * `artifact` 也是 `null`。**不做 phase 限制**：轮次关闭后历史回放要能取到同一份产物。
 *
 * 起点由服务端签发，规则三条：
 *  1. 目标必须是这一篇的 active 目标（与笔记页那颗主要动作同一条查询：
 *     `listObjectiveSurfacesV3` 的 `noteId` 收窄），没有 ⇒ `practiceStart = null`
 *     ——无目标的轮次不出现「练一道」（练习只在目标存在时开 run）。
 *  2. 目标此刻的主行动必须是"开一场新的"（`create_run` / `practice_only`）：
 *     `resume_run` 意味着这个目标已有一场开着（再开一场会同时两场进行中），
 *     `create_review_run` 是**日程锚定**的复习（把它改锚到这一轮等于把一次到期复习
 *     悄悄变成轮次练习）——两类都如实回 null，不在这一层替它们折算。
 *  3. `goal` / `requestedTimeBudgetSeconds` / `responsePreference` **原样取自那一发
 *     主行动的 `start`**，只有锚点换成这一轮（`note_round`）。这三个值只在
 *     `action-resolver` 里签发一次，客户端与这里都不另写。
 */
async function buildRoundTeachingExtras(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  round: NoteLearningRoundV1,
  teachingId: string | null,
): Promise<{
  practices: RoundPracticeV1[];
  plans: Awaited<ReturnType<typeof listPlanRevisions>>;
  practiceStart: RoundPracticeStartV1 | null;
  gapHelp: ReturnType<typeof roundGapHelpV1Schema.parse>;
  artifact: ReturnType<typeof roundTeachingArtifactRefV1Schema.parse> | null;
}> {
  const practices = await listNoteRoundPractices(tx, scope, round.roundId);
  const plans = await listPlanRevisions(tx, scope, round.roundId);
  // 动态版本那一格（刀五）：读的是这一条教学行的 artifact_id 指向的产物行；
  // 没有动态版本（还没生成 / 生成失败）就是 null——那不是失败（D4 §6.2）。
  const artifact = teachingId ? await readTeachingArtifactRef(tx, scope, teachingId) : null;
  // 缺口帮助停止那一格（W4-6 刀四）：判据在 learning-runs 那一侧算（它才看得见
  // 帮助事件与结论），这里只把它读出来、过一遍合同。缺口身份不进线上合同（它由服务端
  // 自己用），所以这里显式挑三格。
  const gapHelp = await readRoundGapHelpV1(tx, scope, round.roundId);
  const gapHelpWire = roundGapHelpV1Schema.parse({
    stopped: gapHelp.stopped,
    consecutiveHelpCount: gapHelp.consecutiveHelpCount,
    threshold: gapHelp.threshold,
  });
  const targetId = await readRoundTargetId(tx, scope, round);
  const targetSurface = targetId ? await assembleObjectiveSurfaceV3(tx, scope, targetId) : null;
  // Once teaching has proposed the current question's target, an unrelated old
  // note objective cannot replace a rejected or missing proposal.
  const objective = targetSurface ?? (teachingId ? null : (await listObjectiveSurfacesV3(tx, scope, {
    lifecycle: "active", noteId: round.noteId, limit: 1,
  })).items[0]);
  if (!objective) return { practices, plans, artifact, practiceStart: null, gapHelp: gapHelpWire };
  const action = objective.primaryAction;
  if (action.kind !== "create_run" && action.kind !== "practice_only") {
    return { practices, plans, artifact, practiceStart: null, gapHelp: gapHelpWire };
  }
  const objectiveId = objective.objectiveId;
  return {
    practices,
    plans,
    artifact,
    gapHelp: gapHelpWire,
    practiceStart: roundPracticeStartV1Schema.parse({
      objectiveId,
      start: {
        ...action.start,
        originV2: { kind: "note_round", roundId: round.roundId, noteId: round.noteId, objectiveId },
      },
    }),
  };
}

/**
 * 冻结生成用的输入（只在相位 1 的短事务里读）：本轮问题 ＋ 最新计划（0283）＋
 * **快照指向的那一版**正文块。读的是快照那一版而不是"现在这一版"——D3 §5：
 * 内容变了就不复用旧产物，"这次解释按哪一版做的"由快照哈希回答。
 */
async function buildFrozenTeachingInput(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  round: NoteLearningRoundV1,
) {
  const [blocks, plans] = await Promise.all([
    loadTeachingSnapshotBlocks(tx, scope.workspaceId, round.noteVersionId),
    listPlanRevisions(tx, scope, round.roundId),
  ]);
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : null;
  return {
    drivingQuestion: round.drivingQuestion,
    planSteps: latestPlan ? latestPlan.plan.steps.map((step) => step.text) : [],
    blocks,
  };
}
