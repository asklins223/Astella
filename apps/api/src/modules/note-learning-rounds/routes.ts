/**
 * 轮次的 HTTP 入口（39d W4-5 第三刀；服务是 `round-service.ts`，合同是
 * `@astella/shared/note-learning-round-contracts`）。
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
import type {
  NoteLearningRoundHistoryMaskedItemV1,
} from "@astella/shared/note-learning-round-contracts";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { currentApiWorkspaceTransaction, scopeOfSession, type ApiTransaction, withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import { getNoteWithVersion } from "../note/service.ts";
import type { NoteLearningRoundRow } from "@astella/shared/db-schema/note-learning-rounds";
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
  prepareRoundPracticeRequestV1Schema,
  reopenNoteLearningRoundRequestV1Schema,
  reviseDrivingQuestionRequestV1Schema,
  roundGapHelpV1Schema,
  roundArtifactFailureV1Schema,
  roundSuspectClaimV1Schema,
  roundPrerequisiteViewV1Schema,
  roundPracticeStartV1Schema,
  roundPlanViewV1Schema,
  roundTeachingArtifactRefV1Schema,
  roundTeachingViewV1Schema,
  type NoteLearningRoundV1Wire,
  type RoundTeachingV1,
  type RoundPracticeStartV1,
  type RoundPracticeV1,
  type RoundSuspectClaimV1,
} from "@astella/shared/note-learning-round-contracts";
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
} from "./round/round-service.ts";
import {
  loadTeachingSnapshotBlocks,
  runTeachingExplainV1,
  teachingFailureResponseV1,
} from "./teaching/teaching-explain.ts";
import type { TeachingExplainProviderV1 } from "./teaching/teaching-explain.ts";
import { createRoundRuntimeCollaborators } from "./runtime-collaborators.ts";
import {
  runDynamicArtifactV1,
  type DynamicArtifactProviderV1,
} from "@astella/shared/note-dynamic-artifact/round-artifact-model";
import { ARTIFACT_MIN_STEPS_V1, groundArtifactStepsV1, plainTextForGroundingV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-measure";
import { checkArtifactDocumentV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-doc";
import type { RoundArtifactSourceV1 } from "@astella/shared/note-dynamic-artifact/round-artifact";
import {
  buildDynamicArtifactHtmlV1,
  DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1,
} from "@astella/shared/note-dynamic-artifact/round-artifact-render";
import { buildRoundReadingPlan, suggestRoundQuestion } from "./learning-plan.ts";
import { requireAiConsent } from "../identity/ai-consent-gate.ts";
import { finishRoundModelAttempt, reserveRoundModelAttempt, type RoundModelAttempt } from "./model-attempt.ts";
import { listNoteRoundPractices } from "../learning-runs/run-service.ts";
import { learningObjectivesV2, learningObjectiveRevisionsV2 } from "@astella/shared/db-schema/card-generation-v2";
import { objectiveRubricV2Schema } from "@astella/shared/card-generation-v2-contracts";
import { decideRoundNextStep } from "./round/round-progression.ts";
import { readRoundGapHelpV1 } from "../learning-runs/gap-help/gap-help-service.ts";
import { readRoundPrerequisiteProposalV1 } from "./prerequisite-proposal.ts";
import { readLatestArtifactFailureV1 } from "./round/artifact-failure.ts";
import { readNoteRouteCoverageV1 } from "./round/route-coverage.ts";
import { noteRouteCoverageV1Schema } from "@astella/shared/note-route-coverage-v2";
import { assembleObjectiveSurfaceV3 } from "../learning-objectives/surface-service.ts";
import { readNoteChangeImpactsV1 } from "../learning-objectives/change-impact-service.ts";
import { selectGroundedApplicationScenario, selectGroundedRoundTarget, type RoundTargetGrounder } from "./target-grounding.ts";
import { persistRoundTarget, readRoundTargetId, recordRoundTeachingExposure } from "./round/round-target.ts";
import { scheduleStudiedNoteTargetsV2 } from "../review/note-subscription-schedule.ts";
import { visibleObjectivesCondition } from "../note/visibility.ts";
import { roundBudgetsV1 } from "./round/round-budgets.ts";
import { noteReflectionRoutes } from "./reflection-routes.ts";
import { readPersonalTeachingSources } from "./reflection-service.ts";
import { constrainTargetToSuspectRechecksV1, readSuspectClaimFollowUpV1 } from "./suspect-claim-recheck.ts";

const STATUS_BY_CODE: Record<string, 400 | 404 | 409 | 500 | 503> = {
  invalid_driving_question: 400,
  invalid_budget: 400,
  invalid_plan_revision: 400,
  invalid_snapshot: 400,
  invalid_teaching_content: 400,
  note_not_found: 404,
  reflection_source_not_found: 404,
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

function mergeSuspectWarningsV1(input: {
  readonly pending: readonly RoundSuspectClaimV1[];
  readonly newlyReported: readonly RoundSuspectClaimV1[];
  readonly resolvedUnitIds: ReadonlySet<string>;
}): RoundSuspectClaimV1[] {
  const byUnitId = new Map<string, RoundSuspectClaimV1>();
  for (const claim of input.pending) {
    for (const unitId of claim.unitIds) {
      if (input.resolvedUnitIds.has(unitId)) continue;
      byUnitId.set(unitId, roundSuspectClaimV1Schema.parse({ ...claim, unitIds: [unitId] }));
    }
  }
  // The latest independent report supersedes the carried warning for that same unit.
  for (const claim of input.newlyReported) {
    for (const unitId of claim.unitIds) byUnitId.set(unitId, roundSuspectClaimV1Schema.parse({ ...claim, unitIds: [unitId] }));
  }
  const grouped = new Map<string, RoundSuspectClaimV1>();
  for (const claim of byUnitId.values()) {
    const key = JSON.stringify([claim.sourceBlockOrdinal, claim.sourceQuote, claim.reason, claim.sourceChanged ?? false]);
    const prior = grouped.get(key);
    grouped.set(key, roundSuspectClaimV1Schema.parse({ ...claim,
      unitIds: [...new Set([...(prior?.unitIds ?? []), ...claim.unitIds])] }));
  }
  return [...grouped.values()].slice(0, 6);
}

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
  const targetId = await readRoundTargetId(tx, scope, round);
  const noteChangeImpact = targetId
    ? (await readNoteChangeImpactsV1(tx, scope, round.noteId, [targetId])).get(targetId) ?? null
    : null;
  return noteLearningRoundViewV1Schema.parse({
    version: 1 as const,
    round: toWire(round),
    contentMoved: noteRoundContentMovedV1({
      frozenSourceContentHash: round.sourceContentHash,
      currentSourceContentHash: await readNoteCurrentSourceHashV1(tx, scope, round.noteId),
    }),
    noteChangeImpact,
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
  return scopeOfSession(req.session);
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
  /** 动态演示的生成那一发（39d W4-1 尾）。与讲解共用同一个模型配置，但**独立**注入，
   *  这样离线用例可以把"讲解成、演示不成"这一种形状造出来（§6.2 要求说不同的话）。 */
  artifact?: { provider: DynamicArtifactProviderV1; modelId: string };
  targetGrounder?: RoundTargetGrounder;
} = {}) {
  // P1-3：三个 LLM 协作者的装配搬到 runtime-collaborators.ts。
  // 路由层不再知道"模型配置从哪读""未配置怎么编码""三者怎么配对"。
  // 注入参数形状不变——离线用例靠它造"讲解成、演示不成"这种形状。
  const collaborators = createRoundRuntimeCollaborators(options);
  const teaching = collaborators.teaching;
  const artifactGenerator = collaborators.artifact;
  const targetGrounder = collaborators.targetGrounder;
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
        // **失权那一支不读那两格事实**（§10.3）：「实际方式」要 join 教学表、
        // 「系统不确定项」要读判定行，两者都要读受保护内容才算得出来。读侧先收窄，
        // 不是读出来再遮蔽——所以这里**根本不去取**。
        if (history.contentMasked) return { page: history, facts: null };
        // 两格事实按**本页那几条**去数（同一份 RLS 上下文、同一发事务）：
        // 先分页再数，而不是先数再分页——后者会把"这一篇前 20 轮"变成"全篇扫一遍"。
        const historyFacts = await readRoundHistoryFactsV1(
          tx,
          (history.rows as NoteLearningRoundRow[]).map((row) => row.id),
        );
        return { page: history, facts: historyFacts };
      }));
    } catch (err) {
      // 游标来路不对是**调用方的错**（`invalid_cursor` → 400），不吞成空页：
      // 空页会被界面读成"我的记录少了"，而真实原因是给了一个不属于这一篇的指针。
      return replyRoundError(reply, err, "读这一篇的轮次记录没成功");
    }
    // 回信整份过一遍合同：漂移要红在这里，而不是红成客户端"某一格 undefined"。
    // 遮蔽那一支**直接交出遮蔽项**，不经过 `roundHistoryItemV1` ——那个映射要读
    // `drivingQuestion` 与 `actualModes`，在遮蔽状态下它们**不存在**，硬过一遍只会
    // 编出两格内容来（屏上就画出半个答案）。
    const lastRoundId = (): string | null => {
      if (!page.hasMore || page.rows.length === 0) return null;
      const last = page.rows[page.rows.length - 1]!;
      return "id" in last ? last.id : last.roundId;
    };
    return noteLearningRoundHistoryPageV1Schema.parse({
      version: 1 as const,
      noteId,
      items: page.contentMasked
        ? (page.rows as NoteLearningRoundHistoryMaskedItemV1[])
        : (page.rows as NoteLearningRoundRow[]).map((row) => roundHistoryItemV1(row, facts!)),
      hasMore: page.hasMore,
      // 游标就是本页最后那一条的 id（有"更早的"才给指针，两者不许分叉）。
      nextCursor: lastRoundId(),
      shownCount: page.shownCount,
      // 与游标无关的那个数：这一篇一共开过几轮（服务层用加游标前的条件算）。
      totalCount: page.totalCount,
      // §10.3：屏上据此说「这些记录只显示你有权看的那部分」而不是「记录不见了」。
      contentMasked: page.contentMasked,
    });
  });

  /**
   * 这一篇的**核心路线**：跨全部轮次、按核心问题归并（39d W4-5 ③；PRD §4.4）。
   *
   * 与上面那两条记录读法的分工，别混：
   *  - `GET /v2/notes/:id/learning-rounds` 是**按轮次**列时间线（§10.3 那一行一行）。
   *  - 这一条是**按核心问题**说"这一篇走到哪"（§4.4）：跨轮汇总，借助完成与仍需
   *    帮助另列，只有纳入的每个问题都实际学过才说"已走完这份核心路线"。
   *
   * **它不是一个"永远进行中的大轮次"**（§4.4 明写不要求），所以路径挂在 **noteId**
   * 下面而不是 `roundId`——挂到轮次上会让人以为"跨轮"是某一轮的属性。
   *
   * 回信整份过一遍合同，漂移红在这里而不是红成客户端某一格 undefined；
   * `truncated` 那一格必填：取数撞了上界就说截断，不给一个看起来完整的假分母。
   */
  app.get("/v2/notes/:noteId/learning-route", async (req, reply) => {
    const noteId = (req.params as { noteId?: string }).noteId ?? "";
    if (!z.string().uuid().safeParse(noteId).success) {
      return reply.code(400).send({ error: "invalid_request", message: "noteId 不是一个合法 id" });
    }
    const scope = scopeOf(req);
    let facts;
    try {
      facts = await withWorkspaceTransaction(scope, (tx) => readNoteRouteCoverageV1(tx, scope, noteId));
    } catch (err) {
      // 读不到这一篇是 404（`round_not_found`），与轮次那一族同一句真因：
      // 「这一篇还没有路线」与「这一篇你看不见」在屏上是两句不同的话（§13.4）。
      return replyRoundError(reply, err, "读这一篇的核心路线没成功");
    }
    return noteRouteCoverageV1Schema.parse(facts.coverage);
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
      return await withWorkspaceTransaction(scope, async (tx) => {
        const advanced = await advanceRound(tx, scope, {
          roundId, expectedRevision: parsed.data.expectedRevision, action: parsed.data.action,
        });
        if (parsed.data.action.kind === "close") {
          await scheduleStudiedNoteTargetsV2(tx, {
            ...scope, noteId: advanced.noteId, at: new Date(),
          });
        }
        return roundViewWire(tx, scope, advanced);
      });
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

  /** Prepare the current question's private target before showing any answer. */
  app.post("/v2/note-learning-rounds/:roundId/practice-preparation", async (req, reply) => {
    const roundId = (req.params as { roundId?: string }).roundId ?? "";
    const parsed = prepareRoundPracticeRequestV1Schema.safeParse(req.body ?? {});
    if (!z.string().uuid().safeParse(roundId).success || !parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "准备先试需要本轮的最新修订号" });
    }
    const scope = scopeOf(req);
    if (teaching.external) {
      await requireAiConsent(req, reply);
      if (reply.sent) return;
    }
    type Preparation = { round: NoteLearningRoundV1 } & (
      | { kind: "reused"; teaching: RoundTeachingV1 | null;
          extras: Awaited<ReturnType<typeof buildRoundTeachingExtras>> }
      | { kind: "generate"; input: Awaited<ReturnType<typeof buildFrozenTeachingInput>>;
          attempt: RoundModelAttempt; ordinal: number }
    );
    let frozen: Preparation;
    try {
      frozen = await withWorkspaceTransaction(scope, async (tx): Promise<Preparation> => {
        await tx.execute(sql`SELECT id FROM note_learning_rounds WHERE id = ${roundId}
          AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} FOR UPDATE`);
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
        if (round.phase !== "active") throw new RoundServiceError("invalid_transition", "先恢复这一轮，再准备尝试");
        if (round.revision !== parsed.data.expectedRevision) {
          throw new RoundServiceError("stale_revision", "这一轮的问题已经变化，请刷新后重试");
        }
        if (!await getNoteWithVersion(tx, round.noteId, scope.workspaceId, scope.userId)) {
          throw new RoundServiceError("note_not_found", "这篇笔记现在不可见，不能准备尝试");
        }
        const existingTarget = await readRoundTargetId(tx, scope, round);
        const existingTeaching = await findReusableTeaching(tx, scope, {
          roundId, kind: "explanation", drivingQuestionRevision: round.drivingQuestionRevision,
          snapshotHash: round.sourceContentHash,
        });
        if (existingTarget) return { round, kind: "reused", teaching: existingTeaching,
          extras: await buildRoundTeachingExtras(tx, scope, round, existingTeaching) };
        if (existingTeaching) {
          throw new RoundServiceError("invalid_teaching_content", "这次讲解尚无可靠练习目标，可继续阅读或调整本轮问题");
        }
        if (!teaching.ready) {
          throw new RoundServiceError("teaching_model_unconfigured", "讲解模型尚未配置，先试目标暂时无法准备");
        }
        const attempt = await reserveRoundModelAttempt(tx, scope, round, teaching.modelId);
        if (attempt.maxCalls < 2) throw new RoundServiceError("round_budget_exhausted", "剩余预算不足以生成并核对先试目标");
        return { round, kind: "generate", input: await buildFrozenTeachingInput(tx, scope, round),
          attempt, ordinal: await countTeachings(tx, scope, roundId) + 1 };
      });
    } catch (err) {
      return replyRoundError(reply, err, "准备先试没成功", (tx, s) => readRound(tx, s, roundId));
    }
    if (frozen.kind === "reused") return reply.code(200).send(roundTeachingViewV1Schema.parse({
      version: 1 as const, round: toWire(frozen.round), teaching: frozen.teaching, ...frozen.extras,
    }));

    const generated = await runTeachingExplainV1({
      provider: teaching.provider, modelId: teaching.modelId,
      maxModelCalls: Math.min(2, frozen.attempt.maxCalls),
      maxDurationMs: Math.max(1, frozen.attempt.deadlineAt - Date.now()),
      attemptId: frozen.attempt.id, input: frozen.input, scope,
      round: { roundId, noteVersionId: frozen.round.noteVersionId,
        sourceContentHash: frozen.round.sourceContentHash },
      ordinal: frozen.ordinal, currentActiveTransaction: currentApiWorkspaceTransaction,
      reportDevelopmentError: (message) => req.log.error({ scope: "note-round-practice-preparation" }, message),
    });
    if (!generated.ok) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, generated.modelCalls, false));
      const mapped = teachingFailureResponseV1(generated);
      return reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
    }
    const evidenceInput = { drivingQuestion: frozen.input.drivingQuestion,
      planSteps: frozen.input.planSteps, blocks: frozen.input.blocks };
    const proposal = constrainTargetToSuspectRechecksV1(
      generated.output.target ?? null, frozen.input.suspectRechecks ?? [],
    );
    let modelCalls = generated.modelCalls;
    if (!proposal) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      return reply.code(422).send({ error: "practice_target_unavailable",
        message: "这篇材料暂时提不出可靠的先试问题，可以直接看讲解或核对笔记" });
    }
    const grounded = await targetGrounder({
      target: proposal, applicationScenario: generated.output.applicationScenario,
      teaching: { explanation: generated.output.explanation,
        example: generated.output.example }, input: evidenceInput,
      maxCalls: frozen.attempt.maxCalls - modelCalls,
      maxDurationMs: frozen.attempt.deadlineAt - Date.now(), scope,
      round: { roundId, noteVersionId: frozen.round.noteVersionId,
        sourceContentHash: frozen.round.sourceContentHash },
      attemptId: frozen.attempt.id, currentActiveTransaction: currentApiWorkspaceTransaction,
    });
    modelCalls += grounded.modelCalls;
    const accepted = selectGroundedRoundTarget(proposal, grounded.report);
    if (!accepted) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      return reply.code(422).send({ error: "practice_target_unavailable",
        message: "先试问题的依据尚未核对通过，可以直接看讲解或核对笔记" });
    }
    try {
      const prepared = await withWorkspaceTransaction(scope, async (tx) => {
        if (!await getNoteWithVersion(tx, frozen.round.noteId, scope.workspaceId, scope.userId)) {
          throw new RoundServiceError("note_not_found", "这篇笔记的访问权限已经变化，请重新打开");
        }
        const current = await readRound(tx, scope, roundId);
        if (!current || current.phase !== "active" || current.revision !== parsed.data.expectedRevision
          || current.drivingQuestionRevision !== frozen.round.drivingQuestionRevision
          || current.sourceContentHash !== frozen.round.sourceContentHash) {
          throw new RoundServiceError("stale_revision", "本轮问题已经变化，请刷新后重试");
        }
        const teachingRow = await findReusableTeaching(tx, scope, {
          roundId, kind: "explanation", drivingQuestionRevision: current.drivingQuestionRevision,
          snapshotHash: current.sourceContentHash,
        });
        await finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, true);
        const applicationScenario = selectGroundedApplicationScenario(
          generated.output.applicationScenario, accepted.target, accepted.report, evidenceInput);
        const objectiveId = await persistRoundTarget(tx, scope, current, evidenceInput,
          accepted.target, accepted.report, applicationScenario);
        // A teaching request may have committed while the private preparation was
        // running. In that case the answer was already shown before this target
        // existed, so its exposure must be recorded against the new binding.
        if (teachingRow) await recordRoundTeachingExposure(tx, scope, current, objectiveId);
        return { round: current, teaching: teachingRow,
          extras: await buildRoundTeachingExtras(tx, scope, current, teachingRow) };
      });
      return reply.code(201).send(roundTeachingViewV1Schema.parse({
        version: 1 as const, round: toWire(prepared.round),
        teaching: prepared.teaching, ...prepared.extras,
      }));
    } catch (err) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      return replyRoundError(reply, err, "先试问题生成了但没能安全保存", (tx, s) => readRound(tx, s, roundId));
    }
  });

  /**
   * 生成一条教学产物：短事务冻结输入，事务外运行模型，短事务提交。
   * 同快照、同问题版本已有解释时直接复用。
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
        const personalSources = await readPersonalTeachingSources(
          tx, scope, round.noteId, parsed.data.personalReflectionIds,
        );
        // 「换一种解释」（`regenerate`）**跳过复用**：同一问题下再落一条（序号 +1），
        // 旧那条留着（§6「换解释才产生新版本」）。默认那一档仍然先看有没有可复用的。
        const reused = parsed.data.regenerate
          ? null
          : await findReusableTeaching(tx, scope, {
            roundId,
            kind: "explanation",
            drivingQuestionRevision: round.drivingQuestionRevision,
            snapshotHash: round.sourceContentHash,
            personalSources,
          });
        if (reused) return { round, kind: "reused", teaching: reused,
          extras: await buildRoundTeachingExtras(tx, scope, round, reused) };
        if (!teaching.ready) {
          throw new RoundServiceError("teaching_model_unconfigured", "讲解模型尚未配置，已有内容保留；请先配置 AI 服务");
        }
        const used = await countTeachings(tx, scope, roundId);
        const attempt = await reserveRoundModelAttempt(tx, scope, round, teaching.modelId);
        return { round, kind: "generate", ordinal: used + 1,
          input: await buildFrozenTeachingInput(tx, scope, round, personalSources, parsed.data.regenerate), attempt };
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
    const evidenceInput = {
      drivingQuestion: frozen.input.drivingQuestion,
      planSteps: frozen.input.planSteps,
      blocks: frozen.input.blocks,
    };
    const targetProposal = constrainTargetToSuspectRechecksV1(
      generated.output.target ?? null,
      frozen.input.suspectRechecks ?? [],
    );
    // Independently check the explanation as well as the optional private target.
    // Explicit offline fixtures without a grounder use their recorded teaching; production never skips this gate.
    const grounded = teaching.external || options.targetGrounder || targetProposal ? await targetGrounder({
      target: targetProposal, applicationScenario: generated.output.applicationScenario,
      teaching: { explanation: generated.output.explanation, example: generated.output.example },
      input: evidenceInput,
      maxCalls: frozen.attempt.maxCalls - generated.modelCalls,
      maxDurationMs: frozen.attempt.deadlineAt - Date.now(), scope,
      round: { roundId, noteVersionId: frozen.round.noteVersionId, sourceContentHash: frozen.round.sourceContentHash },
      attemptId: frozen.attempt.id, currentActiveTransaction: currentApiWorkspaceTransaction,
    }) : { approved: false, report: { teachingSupported: true, teachingReason: "explicit offline fixture", teachingSegments: [], objectiveSupported: false, units: [], suspectClaims: [] }, modelCalls: 0 };
    // 这一次发出去的模型调用总数（讲解 + 依据核对 + 动态演示）。**动态演示那一发也算**：
    // 轮内预算是这一轮共享的，把账记在别人的额度上会让 `reserveRoundModelAttempt`
    // 之后那一格永远显示"没花过"，而 §18.3 的试用统计正是按真调用数算的。
    let modelCalls = generated.modelCalls + grounded.modelCalls;
    if (!grounded.report?.teachingSupported) {
      await withWorkspaceTransaction(scope, (tx) => finishRoundModelAttempt(tx, scope, frozen.attempt, modelCalls, false));
      // 核查者**自己写的理由**要进留痕（§16.4）。这一条 422 在界面上只有一句「依据还
      // 没核对通过」；若日志里也只有那一句，事后既不知道是讲解的哪一句没有依据，也不知道
      // 该动提示词、该动材料，还是该换模型——三样对应的处置完全不同。
      req.log.error({ scope: "note-round-teaching", reason: grounded.report?.teachingReason ?? "no report" },
        `这次讲解的依据核对没过：${grounded.report?.teachingReason ?? "核查者没有给出理由"}`
        + (grounded.report
          ? `｜核不上的段：${grounded.report.teachingSegments.filter((seg) => !seg.supported)
            .map((seg) => `#${seg.ordinal} ${seg.reason}`).join(" ") || "（核查者说整体不成立，但没点名具体段）"}`
          : ""));
      // 界面上这一句要说清**下一步该做什么**。原来的"可以重试"是在教用户烧预算：
      // 真窗口实测（2026-09-28）连撞两堵墙都只给这一句，用户既不知道是内容没核对过，
      // 也不知道真正管用的是**换一个材料答得上来的问法**。核查者不能替界面断言"是问题
      // 问歪了"（它只知道自己核了哪几段），所以这里只说两件确定的事：没展示、以及换
      // 问法比空转一次有用。
      return reply.code(422).send({ error: "teaching_grounding_failed",
        message: "这次讲解里有几处说法，这篇笔记里没有依据，所以没有展示。换个问法（问笔记真的说过的理由或条件）多半就能过；也可以先继续读笔记。" });
    }
    const acceptedTarget = selectGroundedRoundTarget(targetProposal, grounded.report);
    const recheckIds = new Set((frozen.input.suspectRechecks ?? []).map((claim) => claim.unitId));
    const resolvedUnitIds = new Set((acceptedTarget?.target.units ?? [])
      .map((unit) => unit.unitId).filter((unitId) => recheckIds.has(unitId)));
    const suspectClaims = mergeSuspectWarningsV1({
      pending: frozen.input.pendingSuspectClaims ?? [],
      newlyReported: grounded.report?.suspectClaims ?? [],
      resolvedUnitIds,
    });

    // ── 相位 2.5：动态演示的生成与渲染，**仍在事务外**（39d W4-1 尾）──
    //
    // 为什么排在这一段而不是相位 1 或相位 3：它要**这一条刚生成出来的解释**对齐语气，
    // 而它自己是一次外部调用，落进相位 3 的短事务就是持行锁等模型（D5 §5.2）。
    //
    // 演示画的是**理解过程**，输入因此是**冻结正文的块**而不是切好的教学栏目：模型给
    // 每一步的「叫什么／发生了什么／依据哪一块的哪一句」，服务端逐条逐字核对，核得上
    // 的才是节点（39f DEMO-1）。所以这一步在发调用之前就算不出节点数——能不能上屏
    // 要等模型回话，而**要发这次调用**又得先知道有没有值得发的材料。
    //
    // 预算不够就**不发**这一次：那是"没请求过"，不是"请求了但失败"——§6.2 要求界面对
    // 这两句说不同话，所以这里不写失败留痕（`artifactGenerationFailure` 留空），教学行照
    // 常落、`artifact_id` 留空。
    // 确定性构建那一档（`kind: "material"`）要的形状与**动态**那一档不同：它是"把这一条
    // 已生成的讲解按静态分镜铺开"，所以还是解释 ＋ 例子 ＋ 计划步骤。两条路各自要什么，
    // 别混成一份输入。
    const artifactMaterial = {
      explanation: generated.output.explanation,
      ...(generated.output.example ? { example: generated.output.example } : {}),
      planSteps: frozen.input.planSteps,
    };
    const artifactBlocks = frozen.input.blocks;
    const artifactMaterialUsable = artifactBlocks.filter(
      (block) => block.type !== "heading" && plainTextForGroundingV1(block.text).length > 0,
    ).length;
    const artifactCallBudget = Math.max(0, frozen.attempt.maxCalls - modelCalls);
    const artifactRemainingMs = frozen.attempt.deadlineAt - Date.now();
    const generatorRef = `${DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1} (${artifactGenerator.modelId})`;
    let artifactSource: RoundArtifactSourceV1 | undefined;
    let artifactGenerationFailure: { reason: "model_failed" | "contract_rejected"; detail: string } | null = null;

    // 没配模型就直接走确定性构建，**不**发那一次调用：发一次注定失败的调用只会留下一条
    // `model_failed` 留痕，把"这个部署压根没配模型"说成"生成过一次且失败了"。
    const artifactModelReady = artifactGenerator.ready;
    if (artifactModelReady
      && artifactMaterialUsable >= ARTIFACT_MIN_STEPS_V1
      && artifactCallBudget >= 1
      && artifactRemainingMs > 0) {
      const demo = await runDynamicArtifactV1({
        provider: artifactGenerator.provider,
        modelId: artifactGenerator.modelId,
        // 至少 1 次、不超过剩下额度：内核按失败类别决定要不要用掉那一次重试。
        maxModelCalls: Math.min(2, artifactCallBudget),
        maxDurationMs: artifactRemainingMs,
        attemptId: frozen.attempt.id,
        input: {
          drivingQuestion: frozen.round.drivingQuestion,
          blocks: artifactBlocks,
          explanation: generated.output.explanation,
        },
        scope,
        source: {
          idempotencyKey: `round:${frozen.round.roundId}:artifact:${frozen.round.sourceContentHash}:${frozen.ordinal}`,
          leaseToken: `note-round:${frozen.round.roundId}`,
          noteVersionId: frozen.round.noteVersionId,
          sourceContentHash: frozen.round.sourceContentHash,
        },
        currentActiveTransaction: currentApiWorkspaceTransaction,
        reportDevelopmentError: (message) => req.log.error({ scope: "note-round-artifact" }, message),
      });
      modelCalls += demo.modelCalls;
      if (demo.ok) {
        // 核对在渲染之前、事务之外：核出来的是**服务端裁定**的引文集，模型的那份
        // 不再被改写（核不上的整条丢掉，不补齐）。剩下的不足两条就整份不上屏。
        const grounded = groundArtifactStepsV1({ steps: demo.doc.outline, blocks: artifactBlocks });
        if (!grounded.ok) {
          artifactGenerationFailure = { reason: "contract_rejected", detail: grounded.detail };
          req.log.error({ scope: "note-round-artifact" },
            `动态演示的依据核对没过：${grounded.detail}`);
        } else if (grounded.rejected.length > 0) {
          // 留痕但不拦路：核不上的那几条被丢了，剩下够走一遍就照常上屏。
          req.log.info({ scope: "note-round-artifact" },
            `动态演示有 ${grounded.rejected.length} 条依据核对不上，已丢弃：`
            + grounded.rejected.map((step) => `${step.ordinal}:${step.reason}`).join(" "));
        }
        if (grounded.ok) {
          // 第二道闸：AI 页面本身的安全性。准确原句已经由服务端在 frame 外作为出处纸签展示，
          // 不要求模型把引文重复塞进它自创的画面。
          const documentCheck = checkArtifactDocumentV1({ document: demo.doc.document });
          if (!documentCheck.ok) {
            const reason = documentCheck.verdict.violation?.reason ?? "unknown";
            artifactGenerationFailure = {
              reason: "contract_rejected",
              detail: `动态演示的页面没过安全闸（${reason}）：${documentCheck.verdict.violation?.evidence ?? ""}`,
            };
            req.log.error({ scope: "note-round-artifact" },
              `动态演示的页面没过安全闸（${reason}）：${documentCheck.verdict.violation?.evidence ?? ""}`);
          } else {
            const rendered = buildDynamicArtifactHtmlV1({
              doc: demo.doc,
              nodes: grounded.nodes,
              snapshotHash: frozen.round.sourceContentHash,
              generatorRef,
            });
            if (rendered.ok) {
              artifactSource = { kind: "rendered", html: rendered.html, generatorRef };
            } else {
              // 渲染器拒了（空／超配额）：走 build 档，由 createTeaching 那一侧补记。
              req.log.error({ scope: "note-round-artifact" },
                `动态演示没有渲染出来（${rendered.reason}）：${rendered.detail}`);
            }
          }
        }
      } else {
        // 生成失败**留痕**：回传给 createTeaching，在教学行落库之后补一行
        // `generate` 档。只进 req.log 的话进程一重启就没了，事后读不到（§16.4）。
        artifactGenerationFailure = { reason: demo.failure, detail: demo.detail };
        req.log.error({ scope: "note-round-artifact" },
          `动态演示没有生成（${demo.failure}）：${demo.detail}`);
      }
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
              ...(suspectClaims.length ? { suspectClaims } : {}),
            },
            sourceBlockOrdinals: generated.output.sourceBlockOrdinals,
            personalSources: frozen.input.personalSources ?? [],
            snapshotHash: frozen.round.sourceContentHash,
            drivingQuestionRevision: frozen.round.drivingQuestionRevision,
            kernelTaskRef: generated.attemptRef,
            // 刀五：动态版本的来源。三种形状，**三种说法**（§6.2／§18.3）：
            //   1. `rendered` —— 模型写讲解 ＋ 可信播放器执行 ＋ 服务端给的读数（§6.1）；
            //   2. `material` —— 这一次**没配模型**（压根没发过调用），退回确定性构建；
            //   3. 整格省略 —— 模型配了但这一发**没成**：产物不给，留 `generate` 档失败。
            //      这里**不**拿第 2 种去顶替第 3 种：那样"动画成功"这一项统计会把确定性
            //      产物算进去，而"哪一版生成器出的"正是 §6.3 要保存的东西。
            ...(artifactSource
              ? { artifact: artifactSource }
              : !artifactModelReady
                ? { artifact: { kind: "material" as const, input: artifactMaterial } }
                : {}),
            artifactGenerationFailure,
          },
          {
            // 产物失败不许让教学生成失败（D4 §6.2）：原因只留在服务端日志里。
            reportArtifactFailure: (message) => req.log.error({ scope: "note-round-artifact" }, message),
          },
        );
        const targetId = acceptedTarget
          ? await persistRoundTarget(tx, scope, frozen.round, evidenceInput, acceptedTarget.target,
              acceptedTarget.report, selectGroundedApplicationScenario(generated.output.applicationScenario,
                acceptedTarget.target, acceptedTarget.report, evidenceInput))
          : await readRoundTargetId(tx, scope, frozen.round);
        if (targetId) await recordRoundTeachingExposure(tx, scope, frozen.round, targetId);
        const round = await readRound(tx, scope, roundId);
        if (!round) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
        return { round, teaching, extras: await buildRoundTeachingExtras(tx, scope, round, teaching) };
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
        return { round, teaching, extras: await buildRoundTeachingExtras(tx, scope, round, teaching) };
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
 *  1. 目标必须是这一轮当前问题已核查的 target binding。笔记上旧的卡片目标
 *     即使仍 active，也不能在尚未准备先试时顶替这道问题。
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
  teaching: RoundTeachingV1 | null,
): Promise<{
  practices: RoundPracticeV1[];
  plans: Awaited<ReturnType<typeof listPlanRevisions>>;
  practiceStart: RoundPracticeStartV1 | null;
  nextStep: ReturnType<typeof decideRoundNextStep>;
  gapHelp: ReturnType<typeof roundGapHelpV1Schema.parse>;
  /** 「补一节前置」提案（W4-6 刀四·正面要求；§16.3）。停下来的四档里那一档靠它。 */
  prerequisite: ReturnType<typeof roundPrerequisiteViewV1Schema.parse>;
  /** 动态产物最近一次失败（§16.4）。与上面那个 `artifact` 分开：那个是状态，这个是事件。 */
  artifactFailure: ReturnType<typeof roundArtifactFailureV1Schema.parse> | null;
  artifact: ReturnType<typeof roundTeachingArtifactRefV1Schema.parse> | null;
}> {
  const observations = await listNoteRoundPractices(tx, scope, round.roundId);
  const practices: RoundPracticeV1[] = observations.map(({ runId, phase, outcome, startedAt }) => ({
    runId, phase, outcome, startedAt,
  }));
  const plans = await listPlanRevisions(tx, scope, round.roundId);
  // 动态版本那一格（刀五）：读的是这一条教学行的 artifact_id 指向的产物行；
  // 没有动态版本（还没生成 / 生成失败）就是 null——那不是失败（D4 §6.2）。
  const artifact = teaching ? await readTeachingArtifactRef(tx, scope, teaching.teachingId) : null;
  const targetId = await readRoundTargetId(tx, scope, round);
  const objective = targetId ? await assembleObjectiveSurfaceV3(tx, scope, targetId) : null;
  // 缺口帮助停止那一格（W4-6 刀四）：判据在 learning-runs 那一侧算（它才看得见
  // 帮助事件与结论），这里只把它读出来、过一遍合同。缺口身份不进线上合同（它由服务端
  // 自己用），所以这里显式挑三格。
  const gapHelp = await readRoundGapHelpV1(tx, scope, round.roundId, objective?.objectiveId ?? null);
  const gapHelpWire = roundGapHelpV1Schema.parse({
    stopped: gapHelp.stopped,
    consecutiveHelpCount: gapHelp.consecutiveHelpCount,
    threshold: gapHelp.threshold,
  });
  // 「补一节前置」那一格（W4-6 刀四·正面要求；§16.3 验收那句"说明新增学习量"）。
  // 缺口身份**直接沿用**上面那份 `gapHelp.gap` —— 同一条缺口身份只能有一个来源
  // （gap-help-service 头注第 3 条），这里再拼一次就会让"判的是哪条缺口"与"给哪条建议"分家。
  const prerequisiteWire = roundPrerequisiteViewV1Schema.parse(
    await readRoundPrerequisiteProposalV1(tx, scope, round.roundId, gapHelp.gap),
  );
  // 动态产物失败留痕的读侧（§16.4 验收第一句「动态交付失败记录保留」）。只取最近一次：
  // 界面要回答的是"这一版的动态讲解为什么没打开"（§6.2），那一句对应最后一次；全量留给
  // 历史与分析那一层，不进教学面。
  const artifactFailureRaw = await readLatestArtifactFailureV1(tx, scope, round.roundId);
  const artifactFailureWire = artifactFailureRaw
    ? roundArtifactFailureV1Schema.parse(artifactFailureRaw)
    : null;
  const action = objective?.primaryAction;
  const canStartPractice = round.phase === "active" && (action?.kind === "create_run" || action?.kind === "practice_only");
  // An older question can have a Run on the same objective. The current binding's
  // creation time fences observations to the current question before progression.
  const targetRows = targetId ? await tx.execute(sql`SELECT created_at, application_scenario FROM note_learning_round_targets
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND round_id = ${round.roundId} AND driving_question_revision = ${round.drivingQuestionRevision}`) : [];
  const targetBoundAt = targetRows[0]?.created_at
    ? new Date(String(targetRows[0].created_at)).getTime() : null;
  const currentObservations = observations.filter((practice) =>
    practice.objectiveId === objective?.objectiveId
    && (targetId ? targetBoundAt !== null && Number.isFinite(targetBoundAt)
      && Date.parse(practice.startedAt) >= targetBoundAt
      : round.drivingQuestionRevision === 1));
  const latestPractice = currentObservations.at(-1) ?? null;
  const revisionRows = objective ? await tx.select({ scoringRubric: learningObjectiveRevisionsV2.scoringRubric })
    .from(learningObjectivesV2)
    .innerJoin(learningObjectiveRevisionsV2, and(
      eq(learningObjectivesV2.workspaceId, learningObjectiveRevisionsV2.workspaceId),
      eq(learningObjectivesV2.currentObjectiveRevisionId, learningObjectiveRevisionsV2.objectiveRevisionId),
    ))
    .where(and(eq(learningObjectivesV2.workspaceId, scope.workspaceId),
      eq(learningObjectivesV2.objectiveId, objective.objectiveId),
      visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId)))
    .limit(1) : [];
  const rubric = objectiveRubricV2Schema.safeParse(revisionRows[0]?.scoringRubric);
  const nextStep = decideRoundNextStep({
    roundPhase: round.phase,
    hasTeaching: teaching !== null,
    hasTarget: objective !== undefined && objective !== null,
    canStartPractice,
    // Only an independently grounded, required apply criterion can support
    // an application task; the planner otherwise silently falls back to explain.
    transferSuitable: Boolean(targetRows[0]?.application_scenario) && rubric.success
      && rubric.data.units.some((unit) => unit.required && unit.facet === "apply"),
    gapHelpStopped: gapHelp.stopped && gapHelp.gap?.objectiveId === objective?.objectiveId,
    teachingCreatedAt: teaching?.createdAt ?? null,
    latestPractice,
  });
  if (!objective || !canStartPractice || !action || (action.kind !== "create_run" && action.kind !== "practice_only")) {
    return { practices, plans, artifact, practiceStart: null, nextStep, gapHelp: gapHelpWire, prerequisite: prerequisiteWire, artifactFailure: artifactFailureWire };
  }
  const objectiveId = objective.objectiveId;
  return {
    practices,
    plans,
    artifact,
    nextStep,
    gapHelp: gapHelpWire,
    prerequisite: prerequisiteWire,
    artifactFailure: artifactFailureWire,
    practiceStart: roundPracticeStartV1Schema.parse({
      objectiveId,
      start: {
        ...action.start,
        ...(nextStep.kind === "apply" ? { goal: "transfer" as const } : {}),
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
  personalSources: Awaited<ReturnType<typeof readPersonalTeachingSources>> = [],
  includePracticeObservation = false,
) {
  const [blocks, plans] = await Promise.all([
    loadTeachingSnapshotBlocks(tx, scope.workspaceId, round.noteVersionId),
    listPlanRevisions(tx, scope, round.roundId),
  ]);
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : null;
  const suspectFollowUp = await readSuspectClaimFollowUpV1(tx, scope, round, blocks);
  let practiceObservation: {
    outcome: "partial" | "needs_repair" | "declared_unable" | "practice_completed";
    gapFacets: Array<"recall" | "paraphrase" | "explain" | "example" | "apply" | "boundary" | "procedure" | "relate" | "repair">;
  } | null = null;
  if (includePracticeObservation) {
    const targetId = await readRoundTargetId(tx, scope, round);
    if (targetId) {
      const binding = await tx.execute(sql`SELECT created_at FROM note_learning_round_targets
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND round_id = ${round.roundId} AND driving_question_revision = ${round.drivingQuestionRevision}`);
      const boundAt = binding[0]?.created_at ? new Date(String(binding[0].created_at)).getTime() : NaN;
      const observations = await listNoteRoundPractices(tx, scope, round.roundId);
      const latest = observations.filter((practice) => practice.objectiveId === targetId
        && Date.parse(practice.startedAt) >= boundAt).at(-1);
      if (latest?.outcome && ["partial", "needs_repair", "declared_unable", "practice_completed"].includes(latest.outcome)
        && (latest.outcome !== "practice_completed" || latest.gapFacets.length > 0)) {
        practiceObservation = { outcome: latest.outcome as NonNullable<typeof practiceObservation>["outcome"],
          gapFacets: latest.gapFacets };
      }
    }
  }
  return {
    drivingQuestion: round.drivingQuestion,
    planSteps: latestPlan ? latestPlan.plan.steps.map((step) => step.text) : [],
    blocks,
    personalSources,
    suspectRechecks: suspectFollowUp.recheckTargets,
    pendingSuspectClaims: suspectFollowUp.pendingClaims,
    ...(practiceObservation ? { practiceObservation } : {}),
  };
}
