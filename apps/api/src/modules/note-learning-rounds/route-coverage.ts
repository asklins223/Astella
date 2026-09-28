/**
 * 跨轮聚合的**读侧**（39d W4-5 ③；PRD §4.4、§10.3、§16.23）。
 *
 * ## 归属点：为什么落在这里、而不落在别的模块
 *
 * §4.4 的原话：「整体路线进展按**适用目标**汇总多轮实际记录，不要求把它们保存在一个
 * 永不结束的大轮次里」。所以：
 *
 *  - **分母是目标（核心问题）**，不是轮次。轮次仍然是 `learning_runs` 的外层容器
 *    （`note_learning_rounds`，D1 §0），这里是把多轮摊平之后按同一个问题归并的那一层。
 *    **不新建第三套状态机**——下面每个字段都是从既有事实现算的投影，
 *    表上一列都没有加（§6.7）。
 *  - 它属于 `note-learning-rounds` 这个模块而不是 `learning-runs`，是因为**起点是笔记**：
 *    分母要回答「这一篇纳入过哪些核心问题」，而那个集合只有轮次这一族知道
 *    （`note_learning_round_targets` 是轮次 → 目标的绑定，`0292` 那张只追加的表）。
 *    `learning-runs` 那一侧看的是「一次作答」，答不出"这一篇整体走到哪"。
 *
 * ## 三发读完，三发都不返回正文
 *
 *  1. **纳入过哪些核心问题**：本篇全部轮次绑过的目标（`note_learning_round_targets`
 *     ⋈ `note_learning_rounds`）＋ 从未落成目标的**待核对单元**（从教学产物的
 *     `content.suspectClaims` 里读，形状过 `roundTeachingContentV1Schema`）。
 *     §4.4 要求待核对的问题**留在分母里**——它们今天没目标，但它们是"这一篇的核心
 *     问题里有一条我们还没能教"。
 *  2. **每个问题下真的发生过什么**：`learning_runs.origin->>'objectiveId'` 反查那一发，
 *     再取 `learning_artifacts.locked_at`（§14.1.1 的界）与 `learning_runs.result`。
 *  3. **每个目标的暴露账本**：`learning_exposures_v2`。
 *
 * ## 三条不能省的边界
 *
 *  - **可见性**：这一发按笔记判（`visibleNotesCondition`）。§10.3 末段「历史可追溯
 *    不绕过当前权限」与 `note-visibility-read-sites.test.ts` 的棘轮都指着这里。
 *  - **取数有上界**：三个集合各自 `LIMIT`，且**总数如实报**——宁可说"只看了最近
 *    200 个"也不给一个看起来完整的假分母（§4.1「不给出全篇覆盖百分比」的同一条纪律）。
 *  - **范围缩小的事实**来自**计划修订**（0283，D3 §5「每次调整记一条：理由、时间、
 *    变更前后」）：只认**步数变少**的那一次，且带上它的 `reason`。
 *    §4.4 末句要的「注明按调整后的范围完成」就是这一格；§4.4 头一句禁止的
 *    「悄悄缩小范围」由判据层守着——`questions` 永远是纳入过的全部。
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  noteLearningRoundPlanRevisions,
  noteLearningRounds,
} from "@ailearn/shared/db-schema/note-learning-rounds";
import { notes } from "@ailearn/shared/db-schema/note";
import { roundPlanV1Schema, roundTeachingContentV1Schema } from "@ailearn/shared/note-learning-round-contracts";
import {
  decideNoteRouteQuestionV1,
  noteRouteQuestionIdForConflictV1,
  noteRouteQuestionIdForObjectiveV1,
  summarizeNoteRouteCoverageV1,
  type NoteRouteAttemptFactsV1,
  type NoteRouteCoverageV1,
  type NoteRouteExposureFactsV1,
  type NoteRouteQuestionV1,
} from "@ailearn/shared/note-route-coverage-v2";
import { noteVisibleSqlText as noteVisibleSqlTextForRawSql, visibleNotesCondition } from "../note/visibility.ts";
import { RoundServiceError, type RoundScopeV1 } from "./round-service.ts";

/**
 * 三个集合各自的取数上界。**报数而不是静默截断**：`truncated` 为真时屏上要念出
 * 「只看了最近这些」，否则一个被截断的分母会被读成"这一篇就这些"。
 */
const ROUTE_OBJECTIVE_LIMIT_V1 = 200;
const ROUTE_ATTEMPT_LIMIT_V1 = 500;
const ROUTE_EXPOSURE_LIMIT_V1 = 500;

export type NoteRouteCoverageFactsV1 = {
  coverage: NoteRouteCoverageV1;
  /** 三处取数里有任何一处撞了上界，就如实说是"只看了这么多"。 */
  truncated: { objectives: boolean; attempts: boolean; exposures: boolean };
};

type ObjectiveRow = { objectiveId: string; roundId: string; label: string };
type AttemptRow = {
  runId: string;
  roundId: string | null;
  objectiveId: string | null;
  outcome: string | null;
  lockedAt: Date | null;
  settledAt: Date | null;
};
type ExposureRow = { objectiveId: string; kind: string; exposedAt: Date | null };
type ConflictRow = { roundId: string; unitId: string; reason: string; label: string };

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 计划修订里**步数变少**的那一次（§4.4 末句「用户缩小范围时，结果注明按调整后的范围
 * 完成」的落点）。
 *
 * 两条判据，都写死而不是靠界面自觉：
 *  - **只认变少**：步数不变的修订（改措辞、调顺序）是同一份范围，不该改结论口径。
 *  - **只认用户发起的那一档**：计划修订的 `reason` 是必填的（D3 §5），而**变少**这件事
 *    没有别的来源——今天没有「用户缩小范围」这个独立命令，能作为它的证据的只有
 *    计划本身变小了。
 *
 * 取**最近**那一次变小：多轮多次调整时，屏上要念的是最后一次的范围口径。
 */
export async function readScopeAdjustmentV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
): Promise<{ at: string; reason: string } | null> {
  const rows = await tx
    .select({
      roundId: noteLearningRoundPlanRevisions.roundId,
      plan: noteLearningRoundPlanRevisions.plan,
      reason: noteLearningRoundPlanRevisions.reason,
      createdAt: noteLearningRoundPlanRevisions.createdAt,
      // 同一轮里 `planOrdinal` 递增；跨轮按时间比。
      ordinal: noteLearningRoundPlanRevisions.planOrdinal,
    })
    .from(noteLearningRoundPlanRevisions)
    .innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundPlanRevisions.roundId))
    // `visibleNotesCondition` 引用的是 `notes` 那一列，所以判据要用就得**先 join 它**——
    // 漏了这一句产出的不是"漏判"，而是一条引用了不在 FROM 里的表的语法错误。
    // 计划修订里带的是**用户自己写的理由**（D3 §5 必填），那是内容，所以按笔记判可见性。
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.noteId, noteId),
      visibleNotesCondition(scope.userId),
    ))
    .orderBy(desc(noteLearningRoundPlanRevisions.createdAt), desc(noteLearningRoundPlanRevisions.planOrdinal))
    .limit(200);

  // 查询是 `created_at DESC`（新的在前），所以**第一次见到的不是初始计划**——
  // 直接顺着读会把"最新的那一版"当成基准，于是任何一次缩小都比它小、每一次都判成缩小。
  // （第一版就是这么错的：集测里那次"只改措辞"的红就是它。）
  // 所以先把**每一轮**的所有版本收齐，再按 `planOrdinal` 升序（= 最初 → 现在）走一遍。
  const byRound = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byRound.get(row.roundId) ?? [];
    list.push(row);
    byRound.set(row.roundId, list);
  }
  let latest: { at: string; reason: string } | null = null;
  for (const list of byRound.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    const initial = roundPlanV1Schema.safeParse(list[0]?.plan);
    if (!initial.success) continue;
    for (const row of list.slice(1)) {
      const parsed = roundPlanV1Schema.safeParse(row.plan);
      if (!parsed.success) continue;
      if (parsed.data.steps.length < initial.data.steps.length) {
        const candidate = { at: isoOrNull(row.createdAt) ?? new Date(0).toISOString(), reason: row.reason };
        // 多轮多次缩小时取**最近**那一次（屏上要念的是最后一次的范围口径）。
        if (latest === null || candidate.at > latest.at) latest = candidate;
      }
    }
  }
  return latest;
}

/**
 * 这一篇纳入过的核心问题（**分母**）。
 *
 * 两个来源合成一个集合，缺一不可：
 *  - **落成过目标的**：从 `note_learning_round_targets` 按轮次反查。这张表只追加
 *    （0292 的触发器），所以"纳入过"这件事**不会被后来的任何操作改小**——
 *    §4.4 头一句禁止的「让剩余内容从分母消失」在数据面就没有那条路。
 *  - **没落成目标的待核对单元**：从教学产物的 `content.suspectClaims` 读。
 *    §4.4 明写「待核对问题不能算已覆盖」，那它**必须在分母里**；而
 *    `persistRoundTarget` 拒收含疑点的单元（`round-target.ts:36-41`），所以它们
 *    永远不会出现在上一支里——只读目标就会把它们整个漏掉，
 *    而漏掉的后果正是"已走完这份核心路线"在一篇没走完的笔记上被说出来。
 */
async function readIncludedQuestionsV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
): Promise<{ objectives: ObjectiveRow[]; conflicts: ConflictRow[]; truncated: boolean }> {
  const objectiveRows = await tx.execute(sql`
    SELECT t.objective_id, t.round_id, COALESCE(rev.concept_label, rev.public_summary, '这条核心问题')
      AS label
    FROM public.note_learning_round_targets AS t
    JOIN public.note_learning_rounds AS r
      ON r.workspace_id = t.workspace_id AND r.user_id = t.user_id AND r.id = t.round_id
    JOIN public.notes AS n ON n.id = r.note_id
    LEFT JOIN public.learning_objective_revisions_v2 AS rev
      ON rev.workspace_id = t.workspace_id AND rev.objective_revision_id = t.objective_revision_id
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND r.note_id = ${noteId}::uuid AND n.deleted_at IS NULL
      ${visibleNotesConditionSql(scope.userId)}
    ORDER BY r.created_at ASC, t.round_id ASC
    LIMIT ${ROUTE_OBJECTIVE_LIMIT_V1 + 1}`);

  const teachingRows = await tx.execute(sql`
    SELECT te.round_id, te.content
    FROM public.note_learning_round_teachings AS te
    JOIN public.note_learning_rounds AS r
      ON r.workspace_id = te.workspace_id AND r.user_id = te.user_id AND r.id = te.round_id
    JOIN public.notes AS n ON n.id = r.note_id
    WHERE te.workspace_id = ${scope.workspaceId} AND te.user_id = ${scope.userId}
      AND r.note_id = ${noteId}::uuid AND n.deleted_at IS NULL
      ${visibleNotesConditionSql(scope.userId)}
    ORDER BY r.created_at ASC, te.ordinal ASC
    LIMIT ${ROUTE_OBJECTIVE_LIMIT_V1}`);

  const objectives: ObjectiveRow[] = objectiveRows.map((row) => ({
    objectiveId: String(row.objective_id),
    roundId: String(row.round_id),
    label: String(row.label ?? "").trim() || "这条核心问题",
  }));
  const truncated = objectives.length > ROUTE_OBJECTIVE_LIMIT_V1;
  if (truncated) objectives.length = ROUTE_OBJECTIVE_LIMIT_V1;

  // 待核对：只保留**至今没有**落成目标单元的那些。
  // `canonicalUnitIds` 的口径与 `suspect-claim-recheck.ts:65-76` 同一份：
  // 标准答案里已经有的单元说明那一块**已经教出去并被练过**了，不再是"待核对"。
  //
  // 这一发同样 join `notes` 并带判据：`canonical_answer` 是**从笔记正文生成的内容**
  // （§13.2 公共边界：题面与标准答案不进公共面），而"哪些单元已经落成目标"这件事
  // 撤权之后不该还读得出来——`note-visibility-read-sites.test.ts` 的 ROUND_INDIRECT
  // 那一族量过同一类破口（讲过的正文在失权后仍可读）。
  const settledUnitIds = new Set<string>();
  const revisionRows = await tx.execute(sql`
    SELECT rev.canonical_answer
    FROM public.note_learning_round_targets AS t
    JOIN public.note_learning_rounds AS r
      ON r.workspace_id = t.workspace_id AND r.user_id = t.user_id AND r.id = t.round_id
    JOIN public.notes AS n ON n.id = r.note_id
    JOIN public.learning_objective_revisions_v2 AS rev
      ON rev.workspace_id = t.workspace_id AND rev.objective_revision_id = t.objective_revision_id
    WHERE t.workspace_id = ${scope.workspaceId} AND t.user_id = ${scope.userId}
      AND r.note_id = ${noteId}::uuid AND n.deleted_at IS NULL
      ${visibleNotesConditionSql(scope.userId)}
    LIMIT ${ROUTE_OBJECTIVE_LIMIT_V1}`);
  for (const row of revisionRows) {
    for (const unitId of canonicalUnitIds(row.canonical_answer)) settledUnitIds.add(unitId);
  }

  const conflicts: ConflictRow[] = [];
  for (const row of teachingRows) {
    const parsed = roundTeachingContentV1Schema.safeParse(row.content);
    for (const claim of parsed.success ? parsed.data.suspectClaims ?? [] : []) {
      for (const unitId of claim.unitIds) {
        if (settledUnitIds.has(unitId)) continue;
        conflicts.push({
          roundId: String(row.round_id),
          unitId,
          reason: claim.reason,
          label: claim.sourceQuote ? `「${claim.sourceQuote.slice(0, 120)}」这一处` : `第 ${claim.sourceBlockOrdinal ?? "?"} 处`,
        });
      }
    }
  }
  return { objectives, conflicts, truncated };
}

/**
 * 标准答案里出现过的单元 id。
 *
 * **两种形状都收**，因为库里真的两种都有（实测 2026-09-27，dev 与一次性库）：
 *  - `{ kind: "text", unit: { unitId, text } }` —— 夹具与激活链写进来的主形状；
 *  - `{ items: [{ unitId, … }, …] }` —— `round-target.ts:67` 落的那一档
 *    （`persistRoundTarget` 写的 `canonicalAnswer = { kind: "bullets", items }`）。
 *
 * 为什么两种都要收：漏掉任何一种的后果是**把已经教出去的单元当成"待核对"**，
 * 于是分母里多出一条永远覆盖不掉的假缺口，而 §4.4 的门槛正是被它挡住的。
 *
 * 解析失败返回空数组（fail open 到"没有已落地的单元"）：那与
 * `suspect-claim-recheck.ts:65-76` 同一口径，宁可多列一条也不悄悄吞掉一条。
 */
function canonicalUnitIds(value: unknown): string[] {
  const read = (input: unknown): string[] => {
    if (!input || typeof input !== "object") return [];
    const record = input as { items?: unknown; unit?: unknown; unitId?: unknown };
    const fromItems = Array.isArray(record.items)
      ? record.items.flatMap((item) => read(item))
      : [];
    const unit = record.unit && typeof record.unit === "object" ? record.unit : undefined;
    const own = typeof record.unitId === "string" ? [record.unitId] : [];
    const fromUnit = unit ? read(unit) : [];
    return [...own, ...fromUnit, ...fromItems];
  };
  try {
    return read(typeof value === "string" ? JSON.parse(value) as unknown : value);
  } catch { return []; }
}

/** §14.1.1 的界：每一发里**最早**那个锁定回答的时刻。 */
async function readAttemptsV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  objectiveIds: readonly string[],
): Promise<{ rows: AttemptRow[]; truncated: boolean }> {
  if (objectiveIds.length === 0) return { rows: [], truncated: false };
  const rows = await tx.execute(sql`
    SELECT r.id AS run_id, r.origin ->> 'roundId' AS round_id,
           r.origin ->> 'objectiveId' AS objective_id,
           r.result ->> 'outcome' AS outcome,
           r.result ->> 'settledAt' AS settled_at,
           (SELECT min(a.locked_at) FROM public.learning_artifacts AS a
             WHERE a.run_id = r.id AND a.locked_at IS NOT NULL) AS locked_at
    FROM public.learning_runs AS r
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      -- jsonb 的 ->> 取出来是 **text**，与 uuid 比会报 42883（operator does not
      -- exist: text = uuid，实测）。所以左边显式转 uuid，右边保持 uuid。
      AND (r.origin ->> 'objectiveId')::uuid IN (${sql.join(objectiveIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY r.created_at DESC
    LIMIT ${ROUTE_ATTEMPT_LIMIT_V1 + 1}`);
  const truncated = rows.length > ROUTE_ATTEMPT_LIMIT_V1;
  return {
    truncated,
    rows: rows.slice(0, ROUTE_ATTEMPT_LIMIT_V1).map((row) => ({
      runId: String(row.run_id),
      roundId: row.round_id === null ? null : String(row.round_id),
      objectiveId: row.objective_id === null ? null : String(row.objective_id),
      outcome: row.outcome === null ? null : String(row.outcome),
      lockedAt: row.locked_at === null ? null : new Date(String(row.locked_at)),
      settledAt: row.settled_at === null ? null : new Date(String(row.settled_at)),
    })),
  };
}

async function readExposuresV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  objectiveIds: readonly string[],
): Promise<{ rows: ExposureRow[]; truncated: boolean }> {
  if (objectiveIds.length === 0) return { rows: [], truncated: false };
  const rows = await tx.execute(sql`
    SELECT objective_id, exposure_kind, exposed_at
    FROM public.learning_exposures_v2
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND ${inListSqlV1(sql`objective_id`, objectiveIds)}
    ORDER BY exposed_at DESC
    LIMIT ${ROUTE_EXPOSURE_LIMIT_V1 + 1}`);
  const truncated = rows.length > ROUTE_EXPOSURE_LIMIT_V1;
  return {
    truncated,
    rows: rows.slice(0, ROUTE_EXPOSURE_LIMIT_V1).map((row) => ({
      objectiveId: String(row.objective_id),
      kind: String(row.exposure_kind),
      exposedAt: row.exposed_at === null ? null : new Date(String(row.exposed_at)),
    })),
  };
}


/**
 * `col IN (...)` 的**参数化**拼法。
 *
 * 为什么不用 `= ANY(${array}::uuid[])`：postgres.js 会把数组参数包成 `(...)`，
 * 于是模板里出现 `ANY(($1)::uuid[])`——多一层括号在某些版本上直接语法错。
 * 而写成 `sql.raw(\`ARRAY[$1,$2]\`)` 又得手工数参数位置（这一发里
 * `$1/$2` 已经被 workspace/user 占了），改一处 WHERE 就会错位——那正是
 * 39d claims §8.1 说的"坐标会腐烂"。
 *
 * `sql.join(..., sql`, `)` + 每个值**各自**作为参数传下去，位置由驱动算，
 * 不依赖这一发里前面有几个占位符。
 *
 * **左边那一列的类型由调用方负责**：`origin->>'objectiveId'` 出来是 `text`，
 * 拿它直接与 `uuid` 比会报 42883（实测），所以那一处要显式 `(...)::uuid`。
 */
function inListSqlV1(column: SQL, values: readonly string[]): SQL | null {
  if (values.length === 0) return null;
  return sql`${column} IN (${sql.join(values.map((value) => sql`${value}::uuid`), sql`, `)})`;
}

/**
 * 可见性判据的**手写 SQL 片段**版本。
 *
 * 这三发是 `tx.execute(sql\`…\`)` 裸 SQL（要一次 join 出跨四张表的形状，drizzle 的
 * 逐表拼装在这里反而更长），而 `visibleNotesCondition` 返回的是 drizzle 的 `SQL`
 * 对象——它不能插进模板字面量。所以这里用同一份规则的**文本**入口
 * `noteVisibleSqlText`（`note/visibility.ts:56` 转发到 shared 的唯一实现），
 * 判据本身仍然只有一份，棘轮也认这个 token。
 */
function visibleNotesConditionSql(userId: string): SQL {
  // `viewerExpr` 是**一段 SQL 表达式**而不是值，所以传的是 `` `'${userId}'::uuid` ``
  // 这种带引号的形式——与仓库里既有的裸 SQL 读点同一写法
  // （`memory-star-map.ts:76` 用列名，`workspace-collab-postgres.integration.ts:673`
  // 用字面量）。这里的 userId 来自会话（`scopeOf(req)`），不是请求体里的自由文本。
  return sql`AND (${sql.raw(noteVisibleSqlTextForRawSql("n", `'${userId}'::uuid`))})`;
}

/**
 * 跨轮聚合的读侧入口。
 *
 * **它只读不写**（§6.7：轮次不存聚合结论）：这一发里没有任何 insert/update，
 * 判据按源码形状钉住（`note-route-coverage-read-only.test.ts`）。理由不只是洁癖——
 * §4.4 要的是「可以随时重算、随时改口径」，而一个被写进表里的"已走完"会变成
 * 第二个事实源，笔记再改一次它不会自己跟上。
 */
export async function readNoteRouteCoverageV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
): Promise<NoteRouteCoverageFactsV1> {
  // 笔记本身先验一次：读不到就报 `round_not_found`，与轮次那一族同一句真因。
  // 不先验的话下面那些 join 各自带判据会回空，而"这一篇还没有路线"与
  // "这一篇你看不见"在屏上是两句完全不同的话（§13.4）。
  const noteRows = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  if (!noteRows[0]) throw new RoundServiceError("round_not_found", "这一篇笔记读不到");

  const included = await readIncludedQuestionsV1(tx, scope, noteId);
  const objectiveIds = [...new Set(included.objectives.map((row) => row.objectiveId))];
  const [attempts, exposures, scopeAdjustment] = await Promise.all([
    readAttemptsV1(tx, scope, objectiveIds),
    readExposuresV1(tx, scope, objectiveIds),
    readScopeAdjustmentV1(tx, scope, noteId),
  ]);

  const attemptsByObjective = new Map<string, NoteRouteAttemptFactsV1[]>();
  const roundIdsByObjective = new Map<string, Set<string>>();
  for (const row of included.objectives) {
    if (!roundIdsByObjective.has(row.objectiveId)) roundIdsByObjective.set(row.objectiveId, new Set());
    roundIdsByObjective.get(row.objectiveId)!.add(row.roundId);
  }
  // **作答必须锚在这一篇的轮次上**。同一个目标可以在别的笔记的轮次里被练过
  // （例如从复习队列进去），而 §16.39 要的正是「那一篇的进度不是这一篇的进度」。
  // 判据用 `roundIdsByObjective`——它装的是**本篇**绑过这个目标的轮次。
  // 锚在别处（或压根没有轮次）的那些发在这里被丢掉，而不是被算成"这一篇练过"。
  for (const row of attempts.rows) {
    if (row.objectiveId === null) continue;
    if (row.roundId === null || !roundIdsByObjective.get(row.objectiveId)?.has(row.roundId)) continue;
    const facts: NoteRouteAttemptFactsV1 = {
      runId: row.runId,
      outcome: (row.outcome ?? null) as NoteRouteAttemptFactsV1["outcome"],
      lockedAt: isoOrNull(row.lockedAt),
      settledAt: isoOrNull(row.settledAt),
    };
    if (!attemptsByObjective.has(row.objectiveId)) attemptsByObjective.set(row.objectiveId, []);
    attemptsByObjective.get(row.objectiveId)!.push(facts);
  }

  const exposuresByObjective = new Map<string, NoteRouteExposureFactsV1[]>();
  for (const row of exposures.rows) {
    const at = isoOrNull(row.exposedAt);
    if (at === null) continue;
    if (!exposuresByObjective.has(row.objectiveId)) exposuresByObjective.set(row.objectiveId, []);
    exposuresByObjective.get(row.objectiveId)!.push({ kind: row.kind as NoteRouteExposureFactsV1["kind"], exposedAt: at });
  }

  // **按目标归并，不按行归并**：`included.objectives` 一行是 (轮次, 目标) 一对，
  // 同一个目标被两轮走过就有两行。直接 map 会把它算成**两个核心问题**——那正是
  // §16.17「路线重新组织」的验收要挡的（复用身份却不另建一套）。所以这里按
  // `objectiveId` 收成一条，label 取**第一次**出现的那一句（§4.2：同一目标复用
  // 身份，显示名不因此分叉）。
  const labelByObjective = new Map<string, string>();
  for (const row of included.objectives) {
    if (!labelByObjective.has(row.objectiveId)) labelByObjective.set(row.objectiveId, row.label);
  }
  const questions: NoteRouteQuestionV1[] = [...labelByObjective.entries()].map(([objectiveId, label]) =>
    decideNoteRouteQuestionV1({
      questionId: noteRouteQuestionIdForObjectiveV1(objectiveId),
      kind: "objective",
      label,
      roundIds: [...(roundIdsByObjective.get(objectiveId) ?? [])],
      attempts: attemptsByObjective.get(objectiveId) ?? [],
      exposures: exposuresByObjective.get(objectiveId) ?? [],
    }));
  for (const row of included.conflicts) {
    questions.push(decideNoteRouteQuestionV1({
      questionId: noteRouteQuestionIdForConflictV1(row.unitId),
      kind: "material_conflict",
      label: row.label,
      roundIds: [row.roundId],
      attempts: [],
      exposures: [],
      conflictReason: row.reason,
    }));
  }

  return {
    coverage: summarizeNoteRouteCoverageV1({
      noteId,
      questions,
      scopeAdjustedAt: scopeAdjustment?.at ?? null,
      scopeAdjustmentReason: scopeAdjustment?.reason ?? null,
    }),
    truncated: {
      objectives: included.truncated,
      attempts: attempts.truncated,
      exposures: exposures.truncated,
    },
  };
}

export type {
  AttemptRow as NoteRouteAttemptRowV1,
  ConflictRow as NoteRouteConflictRowV1,
  ObjectiveRow as NoteRouteObjectiveRowV1,
};
