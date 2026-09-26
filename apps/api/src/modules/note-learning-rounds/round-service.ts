/**
 * 轮次的读写服务（39d W4-5 第二刀；表与约束是 0282，转移判据是 `round-reducer.ts`）。
 *
 * 分工要说清楚，否则下一轮会在这里找本该在别处的东西：
 *  - **这一层不管"该不该开始一轮"**——那句由 W4-2 那侧的服务端主行动裁决（`action-resolver`），
 *    也不管本轮问题从哪来（W4-3，已改为依赖本项）。这一层只保证：**同一篇的未完成名额
 *    只有一个**、**每一次写都要带着它读过的那一版**、**终态之后写不进去**。
 *  - 三条判据里有两条**不是这里发明的**：名额由那条部分唯一索引挡（D1 §6.1），
 *    终态形状由 0282 的双向 CHECK 挡（§6.3/§3.3）。这里做的是把它们翻译成
 *    调用方认得出的码（`round_already_open` / `round_closed` / `stale_revision`），
 *    以及把它们放进同一个事务，中间不留"先查后写"的缝。
 *
 * CAS 的形状照 `companion-journey/journey-service.ts`：读那一行（带 `FOR UPDATE`）→
 * 比 `expectedRevision` → 写的时候 `WHERE revision = 读过的那一版` 再比一次 rowCount。
 * 两道都要，少一道就是 lost update：N#7-9 那条注释在 journey 侧写的就是这个。
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { DomainError } from "@ailearn/shared";
import {
  noteLearningRounds,
  noteLearningRoundPlanRevisions,
  type NoteLearningRoundRow,
} from "@ailearn/shared/db-schema/note-learning-rounds";
import {
  appendRoundPlanRevisionRequestV1Schema,
  roundPlanRevisionV1Schema,
  type RoundPlanRevisionV1,
} from "@ailearn/shared/note-learning-round-contracts";
import {
  applyRoundAction,
  RoundTransitionError,
  type RoundActionV1,
  type RoundOutcomeV1,
  type RoundPhaseV1,
} from "./round-reducer.ts";

export class RoundServiceError extends DomainError {
  constructor(code: string, message: string) {
    // statusCode 留给路由层按码决定（journey 那侧的 `stale_revision` 走 409，
    // 就是这个道理）；服务本身不猜 HTTP。
    super({ name: "RoundServiceError", code, message, statusCode: 500 });
  }
}

export type RoundScopeV1 = { workspaceId: string; userId: string };

export type RoundBudgetsV1 = {
  maxModelCalls: number;
  maxWallClockSeconds: number;
  maxTasks: number;
};

export type NoteLearningRoundV1 = {
  roundId: string;
  noteId: string;
  phase: RoundPhaseV1;
  outcome: RoundOutcomeV1 | null;
  drivingQuestion: string;
  drivingQuestionSource: "suggested" | "user_rewritten" | "user_authored";
  drivingQuestionRevision: number;
  /** 快照引用三件（D1 §6.4 / D3 §2）：轮次只引用，不内联正文。 */
  noteVersionId: string;
  sourceContentHash: string;
  evidenceSnapshotIds: string[];
  budgets: RoundBudgetsV1;
  revision: number;
  pausedAt: string | null;
  resumedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRoundInputV1 = {
  noteId: string;
  noteVersionId: string;
  sourceContentHash: string;
  evidenceSnapshotIds: string[];
  drivingQuestion: string;
  drivingQuestionSource: "suggested" | "user_rewritten" | "user_authored";
  budgets: RoundBudgetsV1;
};

const DRIVING_QUESTION_MAX = 500;
const SOURCES = ["suggested", "user_rewritten", "user_authored"] as const;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toContract(row: NoteLearningRoundRow): NoteLearningRoundV1 {
  return {
    roundId: row.id,
    noteId: row.noteId,
    phase: row.phase as RoundPhaseV1,
    outcome: row.outcome as RoundOutcomeV1 | null,
    drivingQuestion: row.drivingQuestion,
    drivingQuestionSource: row.drivingQuestionSource as NoteLearningRoundV1["drivingQuestionSource"],
    drivingQuestionRevision: row.drivingQuestionRevision,
    noteVersionId: row.noteVersionId,
    sourceContentHash: row.sourceContentHash,
    evidenceSnapshotIds: row.evidenceSnapshotIds,
    budgets: {
      maxModelCalls: row.maxModelCalls,
      maxWallClockSeconds: row.maxWallClockSeconds,
      maxTasks: row.maxTasks,
    },
    revision: row.revision,
    pausedAt: iso(row.pausedAt),
    resumedAt: iso(row.resumedAt),
    closedAt: iso(row.closedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertBudgets(budgets: RoundBudgetsV1): void {
  // 三项预算"缺一不可"是 D1 §3.2 的要求，0282 用"NOT NULL 且没有 DEFAULT"落地。
  // 这里再判一次负数与非整数，是为了让调用方拿到一个有名字的码，
  // 而不是库里那条 CHECK 的 23514 冒上来的 500。
  for (const [name, value] of [
    ["maxModelCalls", budgets?.maxModelCalls],
    ["maxWallClockSeconds", budgets?.maxWallClockSeconds],
    ["maxTasks", budgets?.maxTasks],
  ] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RoundServiceError("invalid_budget", `轮次预算的 ${name} 必须是非负整数（这一轮没有它就不该建出来）`);
    }
  }
}

/**
 * 认那条部分唯一索引的冲突。**必须走 `.cause`**：drizzle 把驱动的错误包了一层，
 * 顶层 `Error.code` 是 undefined（实测 2026-09-26：顶层 `name=Error code=undefined`，
 * `cause.name=PostgresError code=23505`，cause 的原句是
 * `duplicate key value violates unique constraint "nlr_ws_user_note_open_unique"`）。
 * 只判 23505 不够——主键也是 23505——所以索引名必须一起对上。
 */
export function isRoundOpenIndexViolation(err: unknown): boolean {
  let current = err as { code?: string; message?: string; cause?: unknown } | null;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.code === "23505" && String(current.message ?? "").includes(ROUND_OPEN_INDEX)) {
      return true;
    }
    current = current.cause as typeof current;
  }
  return false;
}

const ROUND_OPEN_INDEX = "nlr_ws_user_note_open_unique";

/** 归属三件套 + 那份快照引用都不在这里出现：它们**不可改写**（0282 的触发器），服务也不提供入口。 */
export async function createRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  input: CreateRoundInputV1,
  now: Date = new Date(),
): Promise<NoteLearningRoundV1> {
  const question = input.drivingQuestion.trim();
  if (question.length === 0 || question.length > DRIVING_QUESTION_MAX) {
    throw new RoundServiceError(
      "invalid_driving_question",
      `本轮问题必须是 1～${DRIVING_QUESTION_MAX} 字的一句话`,
    );
  }
  if (!SOURCES.includes(input.drivingQuestionSource)) {
    throw new RoundServiceError("invalid_driving_question", "本轮问题的来源不认识");
  }
  if (input.sourceContentHash.trim().length < 8 || input.sourceContentHash.length > 128) {
    // D3 §2：整篇那一层哈希是快照的必填一件，不是备注。少了它，"内容变没变"
    // 就只剩一个会跟着自动保存走的版本指针。
    // 但**长度不绑 64**：`note_versions.content_hash` 今天的主形状是 32 位 md5
    // （`note/content-hash.ts:25-28`，实测 dev 库 1045 条），判据要挡的是"没有哈希"，
    // 不是"不是 sha256"——写成 64 会把每一篇真实笔记挡在轮次外面。
    throw new RoundServiceError("invalid_snapshot", "本轮必须带上它实际用的那份正文哈希");
  }
  assertBudgets(input.budgets);

  // 先读那一条：调用方要的不是"失败"两个字，而是"哪一轮还开着"——PRD §3.2 给的出口
  // 是"先判断能否作为该轮的计划调整；要另开一轮就明确封存旧轮并新建"，没有 id 与
  // revision 那两个字段，UI 连「继续它」和「封存它」这两颗按钮都摆不出来。
  const existing = await readOpenRound(tx, scope, input.noteId);
  if (existing) {
    throw new RoundServiceError(
      "round_already_open",
      `这一篇已经有一轮没结束（round=${existing.roundId}，revision=${existing.revision}）`,
    );
  }

  try {
    const inserted = await tx.insert(noteLearningRounds).values({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      drivingQuestion: question,
      drivingQuestionSource: input.drivingQuestionSource,
      drivingQuestionRevision: 1,
      sourceContentHash: input.sourceContentHash,
      evidenceSnapshotIds: input.evidenceSnapshotIds,
      maxModelCalls: input.budgets.maxModelCalls,
      maxWallClockSeconds: input.budgets.maxWallClockSeconds,
      maxTasks: input.budgets.maxTasks,
      phase: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const row = inserted[0];
    if (!row) throw new RoundServiceError("create_failed", "这一轮没建出来");
    return toContract(row);
  } catch (err) {
    if (isRoundOpenIndexViolation(err)) {
      // 上面那次预读**不是**这道闸，只是把话说全；两个窗口同时点"开始"时，
      // 权威仍然是那条部分唯一索引（D1 §6.1）。这里不能再去读一遍：语句失败后
      // 这个事务已经中止了，任何后续查询只会报 current transaction is aborted。
      throw new RoundServiceError(
        "round_already_open",
        "这一篇已经有一轮没结束（与另一次开始撞在同一刻，按索引判的）",
      );
    }
    if (err instanceof RoundServiceError) throw err;
    throw err;
  }
}

/** 「继续学习」只恢复未终结轮次（§3.2）：这里就是那一档的读法。 */
export async function readOpenRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
): Promise<NoteLearningRoundV1 | null> {
  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.noteId, noteId),
      inArray(noteLearningRounds.phase, ["active", "paused"]),
    ))
    .orderBy(desc(noteLearningRounds.createdAt))
    .limit(1);
  return rows[0] ? toContract(rows[0]) : null;
}

export async function readRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<NoteLearningRoundV1 | null> {
  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.id, roundId),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
    ))
    .limit(1);
  return rows[0] ? toContract(rows[0]) : null;
}

/**
 * 这一篇的轮次记录（PRD §10.3；读侧，见 `noteLearningRoundHistoryV1Schema` 头上那三条形状）。
 *
 * 排序按 `created_at` 新的在前，**再跟一列 `id` 兜底**：同一瞬间开出的两行（并发首点
 * 真有可能同毫秒）没有第二列就会翻来覆去地换顺序。
 * `hasMore` 靠多读一条算出来，不另发一次 `count(*)`——这一张表按篇筛完本来就只有几行，
 * 而一次多余的聚合在分页真做出来之后还会变成"总数与翻页游标两套口径"那种分叉。
 */
export type RoundHistoryPageV1 = {
  rows: NoteLearningRoundRow[];
  hasMore: boolean;
  /** 这一屏列了几轮——与 `hasMore`（本页之外还有没有）是两件事，分开报。 */
  shownCount: number;
};

export type RoundHistoryQueryV1 = { limit: number; beforeRoundId?: string };

export async function listRoundHistory(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
  query: RoundHistoryQueryV1,
): Promise<RoundHistoryPageV1> {
  // 那三格过滤里，**`userId` 那一格不是这道闸**：这张表是 FORCE RLS、策略就是
  // `(workspace_id, user_id)` 两列（0282），把 `eq(userId)` 摘掉，集测里"另一个人读这一篇"
  // 那条用例**照样绿**（09-26 变异验过）。留着它的理由是"读法要自己说清按什么筛"，
  // 而那条用例守的其实是"**带对了上下文**"——摘掉 `set_config` 时它会红（正向对照那一半）。
  // 别误以为它在守隔离：隔离由策略负责。
  const scoped = [
    eq(noteLearningRounds.workspaceId, scope.workspaceId),
    eq(noteLearningRounds.userId, scope.userId),
    eq(noteLearningRounds.noteId, noteId),
  ];
  if (query.beforeRoundId) {
    // 游标先在自己这一篇里解析：拿别人的 id 过来要**报错**，不是"安静地当没给"——
    // 后者会让那一页从最新一条重新开始，界面看着像"翻不动了"，而真实原因是给了个来路不对的指针。
    const cursorRows = await tx
      .select()
      .from(noteLearningRounds)
      .where(and(...scoped, eq(noteLearningRounds.id, query.beforeRoundId)))
      .limit(1);
    const cursor = cursorRows[0];
    if (!cursor) throw new RoundServiceError("invalid_cursor", "这个游标不在这一篇的记录里");
    // 键集分页（不是 offset）：`(时间, id)` 一起比，两列同值的行也不会跳过或重复。
    // **两侧都留在 SQL 里比**：上面那次 `cursor` 读回来的 `created_at` 已经是 JS `Date`
    // （毫秒精度），而 `created_at` 是微秒精度——拿它当界会既不算"更早"也不算"相等"，
    // 于是与游标同一瞬间的那一行被整页跳过（这条是被"两行同一时刻"那个夹具抓出来的）。
    scoped.push(sql`(${noteLearningRounds.createdAt}, ${noteLearningRounds.id}) < (
      SELECT cursor_row.created_at, cursor_row.id
      FROM note_learning_rounds cursor_row
      WHERE cursor_row.id = ${query.beforeRoundId}::uuid
    )`);
  }
  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(...scoped))
    .orderBy(desc(noteLearningRounds.createdAt), desc(noteLearningRounds.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return { rows: page, hasMore: rows.length > query.limit, shownCount: page.length };
}

/**
 * 状态推进：`active ⇄ paused → closed`。
 *
 * noop 不写库也不推进 revision（判据在 reducer 里）；`expectedRevision` 与实际不一致
 * 一律 `stale_revision` —— 这是 §16.39 那句"另一份草稿保留并提示冲突"在服务端的落点：
 * 第二个窗口拿旧的那一版来写，必须失败，而不是覆盖第一个窗口已经发生的事。
 */
export async function advanceRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  request: { roundId: string; expectedRevision: number; action: RoundActionV1 },
  now: Date = new Date(),
): Promise<NoteLearningRoundV1> {
  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.id, request.roundId),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
    ))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (!row) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
  if (row.revision !== request.expectedRevision) {
    throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  }

  let next;
  try {
    next = applyRoundAction(
      {
        phase: row.phase as RoundPhaseV1,
        outcome: row.outcome as RoundOutcomeV1 | null,
        pausedAt: row.pausedAt,
        resumedAt: row.resumedAt,
        closedAt: row.closedAt,
      },
      request.action,
      now,
    );
  } catch (err) {
    if (err instanceof RoundTransitionError) {
      throw new RoundServiceError(err.reason, err.message);
    }
    throw err;
  }
  if (!next.changed) return toContract(row);

  const updated = await tx.update(noteLearningRounds)
    .set({
      phase: next.state.phase,
      outcome: next.state.outcome,
      pausedAt: next.state.pausedAt,
      resumedAt: next.state.resumedAt,
      closedAt: next.state.closedAt,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(noteLearningRounds.id, row.id),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      // 第二道：写的时候再比一次读过的那一版（journey 侧 N#7-9 同一形状）。
      eq(noteLearningRounds.revision, row.revision),
    ))
    .returning();
  if (updated.length !== 1) throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  return toContract(updated[0]);
}

/**
 * 改写本轮问题（§3.3「用户可以改写这一句话」）。
 *
 * 它是**状态之外**的一次写，但仍然走同一个 `revision` 计数器（D1 §6.3 明写"共用一个"）；
 * `drivingQuestionRevision` 只数这一句话改了几次。文字与来源都没变 ⇒ noop。
 */
export async function reviseDrivingQuestion(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  request: {
    roundId: string;
    expectedRevision: number;
    drivingQuestion: string;
    drivingQuestionSource: "suggested" | "user_rewritten" | "user_authored";
  },
  now: Date = new Date(),
): Promise<NoteLearningRoundV1> {
  const question = request.drivingQuestion.trim();
  if (question.length === 0 || question.length > DRIVING_QUESTION_MAX) {
    throw new RoundServiceError("invalid_driving_question", `本轮问题必须是 1～${DRIVING_QUESTION_MAX} 字的一句话`);
  }
  if (!SOURCES.includes(request.drivingQuestionSource)) {
    throw new RoundServiceError("invalid_driving_question", "本轮问题的来源不认识");
  }

  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.id, request.roundId),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
    ))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (!row) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
  if (row.phase === "closed") {
    throw new RoundServiceError("round_closed", "这一轮已经收尾，终态只读：不改写当时的本轮问题");
  }
  if (row.revision !== request.expectedRevision) {
    throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  }
  if (row.drivingQuestion === question && row.drivingQuestionSource === request.drivingQuestionSource) {
    return toContract(row);
  }

  const updated = await tx.update(noteLearningRounds)
    .set({
      drivingQuestion: question,
      drivingQuestionSource: request.drivingQuestionSource,
      drivingQuestionRevision: row.drivingQuestionRevision + 1,
      revision: row.revision + 1,
      updatedAt: now,
    })
    .where(and(
      eq(noteLearningRounds.id, row.id),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.revision, row.revision),
    ))
    .returning();
  if (updated.length !== 1) throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  return toContract(updated[0]);
}

/**
 * 追加一版计划（39d W4-5 第三刀；D3 §5「追加式修订：每次调整记一条：理由、时间、
 * 变更前后，不是覆盖写」）。
 *
 * 三条与 pause/resume/改写同一纪律的判据：
 *  - 轮次必须**开着**（active/paused）：closed 之后终态只读，计划不再变化；
 *  - `expectedRevision` 必填且 CAS：计划修订随写随推进轮次那个**共用**计数器
 *    （D1 §6.3），两个窗口的后到者必须失败而不是覆盖；
 *  - `reason` 必填：没有理由的计划修订不落库（schema 层再挡一次）。
 *
 * `planOrdinal` 是"第几版计划"（1 起，轮内唯一）；`roundRevision` 记写入时共用
 * 计数器的值——pause/resume 不产生计划行，所以这一列不连续，状态变化与计划
 * 变化因此可区分。表本身只追加（0283 触发器 + 无 UPDATE/DELETE 权限）。
 */
export async function appendPlanRevision(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  request: { roundId: string; expectedRevision: number; plan: unknown; reason: string },
  now: Date = new Date(),
): Promise<RoundPlanRevisionV1> {
  // 只校验"这一版计划"本身；roundId 是定位参数，不属于请求 schema 的字段。
  const parsed = appendRoundPlanRevisionRequestV1Schema.safeParse({
    expectedRevision: request.expectedRevision,
    plan: request.plan,
    reason: request.reason,
  });
  if (!parsed.success) {
    throw new RoundServiceError("invalid_plan_revision", `这一版计划不合法：${parsed.error.issues[0]?.message ?? "形状不对"}`);
  }
  const { plan, reason } = parsed.data;

  const rows = await tx
    .select()
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.id, request.roundId),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
    ))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (!row) throw new RoundServiceError("round_not_found", "这一轮不存在（或对当前这个人不可见）");
  if (row.phase === "closed") {
    throw new RoundServiceError("round_closed", "这一轮已经收尾，终态只读：计划不再变化");
  }
  if (row.revision !== request.expectedRevision) {
    throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  }

  const ordinalRows = await tx
    .select({ maxOrdinal: sql<number | null>`max(${noteLearningRoundPlanRevisions.planOrdinal})` })
    .from(noteLearningRoundPlanRevisions)
    .where(eq(noteLearningRoundPlanRevisions.roundId, row.id));
  const nextOrdinal = Number(ordinalRows[0]?.maxOrdinal ?? 0) + 1;
  const nextRoundRevision = row.revision + 1;

  const inserted = await tx.insert(noteLearningRoundPlanRevisions).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    roundId: row.id,
    planOrdinal: nextOrdinal,
    roundRevision: nextRoundRevision,
    plan: plan as unknown as Record<string, unknown>,
    reason,
    createdAt: now,
  }).returning();
  const planRow = inserted[0];
  if (!planRow) throw new RoundServiceError("create_failed", "这一版计划没落下来");

  // 计划修订推进共用计数器（D1 §6.3）；写时再比一次读过的那一版。
  const updated = await tx.update(noteLearningRounds)
    .set({ revision: nextRoundRevision, updatedAt: now })
    .where(and(
      eq(noteLearningRounds.id, row.id),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.revision, row.revision),
    ))
    .returning();
  if (updated.length !== 1) throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");

  return roundPlanRevisionV1Schema.parse({
    version: 1,
    planOrdinal: planRow.planOrdinal,
    roundRevision: planRow.roundRevision,
    plan,
    reason,
    recordedAt: planRow.createdAt.toISOString(),
  });
}

/**
 * 这一轮的计划走过哪几版（D3 §5「历史记录实际走过的内容」）。按 `planOrdinal`
 * 升序读，就是「最初 → 现在」；变更前后由相邻两行给出，不另存一份。
 * 没有任何计划行 ⇒ 空数组（那一轮只有一句话，还没有计划——不是错误）。
 */
export async function listPlanRevisions(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<RoundPlanRevisionV1[]> {
  const rows = await tx
    .select()
    .from(noteLearningRoundPlanRevisions)
    .where(and(
      eq(noteLearningRoundPlanRevisions.roundId, roundId),
      eq(noteLearningRoundPlanRevisions.workspaceId, scope.workspaceId),
      eq(noteLearningRoundPlanRevisions.userId, scope.userId),
    ))
    .orderBy(noteLearningRoundPlanRevisions.planOrdinal);
  return rows.map((row) => roundPlanRevisionV1Schema.parse({
    version: 1,
    planOrdinal: row.planOrdinal,
    roundRevision: row.roundRevision,
    plan: row.plan,
    reason: row.reason,
    recordedAt: row.createdAt.toISOString(),
  }));
}
