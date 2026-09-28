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
import {
  ROUND_HISTORY_MASKED_QUESTION_V1,
  type NoteLearningRoundHistoryMaskedItemV1,
} from "@ailearn/shared/note-learning-round-contracts";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiTransaction } from "../../db/client.ts";
import { DomainError } from "@ailearn/shared";
import {
  noteLearningRoundArtifacts,
  noteLearningRounds,
  noteLearningRoundPlanRevisions,
  noteLearningRoundTeachings,
  type NoteLearningRoundRow,
  type NoteLearningRoundTeachingRow,
} from "@ailearn/shared/db-schema/note-learning-rounds";
import { learningRunEvents, learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import { noteVersions, notes } from "@ailearn/shared/db-schema/note";
import { visibleNotesCondition } from "../note/visibility.ts";
import {
  appendRoundPlanRevisionRequestV1Schema,
  roundPlanRevisionV1Schema,
  roundTeachingArtifactRefV1Schema,
  roundTeachingContentV1Schema,
  roundTeachingV1Schema,
  type RoundPlanRevisionV1,
  type RoundTeachingArtifactRefV1,
  type RoundTeachingKindV1,
  type RoundTeachingV1,
} from "@ailearn/shared/note-learning-round-contracts";
import { noteReflectionTeachingSnapshotV1Schema, type NoteReflectionTeachingSnapshotV1 } from "@ailearn/shared/note-learning-reflection-contracts";
import {
  applyRoundAction,
  RoundTransitionError,
  type RoundActionV1,
  type RoundOutcomeV1,
  type RoundPhaseV1,
} from "./round-reducer.ts";
import {
  artifactCharLengthV1,
  buildDeterministicArtifactHtmlV1,
  ROUND_ARTIFACT_KIND_V1,
  ROUND_ARTIFACT_MAX_CHARS_V1,
  type RoundArtifactSourceV1,
} from "./round-artifact.ts";
import { recordArtifactFailureV1, type ArtifactFailureReasonV1, type ArtifactFailureStageV1 } from "./artifact-failure.ts";

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
/**
 * 「按当前内容新开一轮」那一发（PRD §4.3 的后半件，D1 §3 那行
 * `active/paused → closed(superseded) + 新轮 active`）。
 *
 * 两件事**必须在同一发事务里**：D1 §2 写的是"旧轮必须先落到终态，新轮才建得出来"，
 * 而这条由那条"每人每篇一条未完成轮次"的唯一索引兜着——分开两次调用就会有一个窗口
 * 旧轮已封存、新轮没建成（用户看到的是"我那一轮没了"）。任何一步失败整体回滚，
 * 旧轮还停在原处、revision 也没动。
 *
 * 新轮沿用**同一个本轮问题**与它的来源：这一发换的是**正文那一版**，不是问题；
 * 想同时换问题是另一发（`driving-question` 那一发改的是新开出来的那一条）。
 */
export async function reopenRoundWithCurrentContent(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  input: {
    roundId: string;
    expectedRevision: number;
    noteVersionId: string;
    sourceContentHash: string;
    /** 预算由调用方签发（与 `createRound` 同一形状：服务层不自己拿那份常量）。 */
    budgets: RoundBudgetsV1;
  },
  now: Date = new Date(),
): Promise<{ superseded: NoteLearningRoundV1; reopened: NoteLearningRoundV1 }> {
  const superseded = await advanceRound(tx, scope, {
    roundId: input.roundId,
    expectedRevision: input.expectedRevision,
    action: { kind: "close", outcome: "superseded" },
  }, now);
  const reopened = await createRound(tx, scope, {
    noteId: superseded.noteId,
    noteVersionId: input.noteVersionId,
    sourceContentHash: input.sourceContentHash,
    evidenceSnapshotIds: [],
    drivingQuestion: superseded.drivingQuestion,
    drivingQuestionSource: superseded.drivingQuestionSource,
    budgets: input.budgets,
  }, now);
  return { superseded, reopened };
}

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
/**
 * 这一篇**现在已保存的那一版**正文哈希（`note_versions.content_hash`）。
 * 读不到（这篇不可见、或没有当前版本指针）时回 null——调用方据此**不报消息**，
 * 与 `checkSourceOutdated` 同一个方向（D3 §3.3）。
 * 只取那一列，不顺手把块读出来：这一发在每次打开轮次时都要跑。
 */
export async function readNoteCurrentSourceHashV1(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  noteId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ contentHash: noteVersions.contentHash })
    .from(notes)
    .innerJoin(noteVersions, eq(noteVersions.id, notes.currentVersionId))
    .where(and(
      eq(notes.id, noteId),
      eq(notes.workspaceId, scope.workspaceId),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  return row?.contentHash ?? null;
}


export async function readOpenRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
): Promise<NoteLearningRoundV1 | null> {
  // 39d W5-6 刀一（§16.13「失权后不能靠旧快照继续学习」）：这一级返回的是**本轮问题**，
  // 那是那篇笔记的内容。以前这里只按 (workspace, user) 过滤，于是作者把共享撤回之后，
  // 那一轮仍能被读出来并继续——冻结快照成了绕过权限的通道。
  // 判据取房子里那一份 `visibleNotesCondition`，不另写规则。
  const rows = await tx
    .select({ round: noteLearningRounds })
    .from(noteLearningRounds)
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.noteId, noteId),
      inArray(noteLearningRounds.phase, ["active", "paused"]),
      visibleNotesCondition(scope.userId),
    ))
    .orderBy(desc(noteLearningRounds.createdAt))
    .limit(1);
  return rows[0] ? toContract(rows[0].round) : null;
}

export async function readRound(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<NoteLearningRoundV1 | null> {
  // 同 `readOpenRound`：这一级返回整份轮次（含驱动问题与冻结快照的引用），
  // 所以要跟着来源笔记判。回收站**不**挡——那是可逆动作（理由见 `listPersonalRoundHistory`）。
  const rows = await tx
    .select({ round: noteLearningRounds })
    .from(noteLearningRounds)
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRounds.id, roundId),
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  return rows[0] ? toContract(rows[0].round) : null;
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
  /**
   * 两种形状，由 `contentMasked` 区分（§10.3）：
   *  - `false` ＝ 完整行（`rows` 是 `NoteLearningRoundRow[]`）；
   *  - `true`  ＝ 失权后仍允许展示的元数据（`rows` 是遮蔽项，**没有内容**）。
   *
   * 不用一个可选字段把两种行混在一张数组里：那样调用方会写出一个"能编过的"读取，
   * 而它在失权那一支上读到的是 `undefined` 的题面——**屏上会画出半个答案**。
   */
  rows: NoteLearningRoundRow[] | NoteLearningRoundHistoryMaskedItemV1[];
  hasMore: boolean;
  /** 这一屏列了几轮——与 `hasMore`（本页之外还有没有）是两件事，分开报。 */
  shownCount: number;
  /** 与游标无关：这一篇一共开过几轮（用加游标前的条件算）。 */
  totalCount: number;
  /**
   * `true` ＝ 这一次读的是**失权后仍允许展示的元数据**（§10.3 末段），不是内容。
   * 必填、不给 `.optional()`：缺这一格会被读成「历史读全了」。
   */
  contentMasked: boolean;
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
  // 39d W5-6 刀二（§16.13）：这一级返回整页轮次（含**驱动问题**），是笔记内容。
  // 它此前只按 (workspace, user, noteId) 筛，而路由 `GET /notes/:noteId/rounds`
  // 也不先验笔记——于是作者撤回共享之后，那一页历史连同每一轮的问法照样端得出去。
  //
  // 判据**在三发里各写一遍**，不塞进上面那个 `scoped` 数组、也不包一层本地 helper：
  // 那条棘轮按「读点就近 ±12 行里有没有 `visibleNotesCondition` 这个字面量」判，
  // 共享数组让另外两发旁边看不到那句话（被报成漏写），包一层 `gate()` 更是把
  // 字面量藏进函数体里、连第一发也一起瞎。写三份既过了棘轮，也让每一发自说自明。
  // 回收站不挡（可逆动作，理由同 `listPersonalRoundHistory`）。
  const baseScoped = [...scoped];
  if (query.beforeRoundId) {
    // 游标先在自己这一篇里解析：拿别人的 id 过来要**报错**，不是"安静地当没给"——
    // 后者会让那一页从最新一条重新开始，界面看着像"翻不动了"，而真实原因是给了个来路不对的指针。
    const cursorRows = await tx
      .select()
      .from(noteLearningRounds)
      .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
      .where(and(...scoped, eq(noteLearningRounds.id, query.beforeRoundId), visibleNotesCondition(scope.userId)))
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
    .select({ round: noteLearningRounds })
    .from(noteLearningRounds)
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(...scoped, visibleNotesCondition(scope.userId)))
    .orderBy(desc(noteLearningRounds.createdAt), desc(noteLearningRounds.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit).map((row) => row.round);
  // 总数用**加游标之前**的那份条件算：它答的是"这一篇一共开过几轮"，
  // 与翻到第几页无关。（写成 `scoped` 就变成"剩下还有几轮"，那是另一个问题，
  // 而且第二页会报出一个比上一页小的"总数"——合同那条 refine 会拦住，但拦不住
  // 一个恰好只在第一页被看的错。）
  const totalRows = await tx
    .select({ total: sql`count(*)::int` })
    .from(noteLearningRounds)
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(...baseScoped, visibleNotesCondition(scope.userId)));
  const visibleTotal = Number(totalRows[0]?.total ?? 0);
  // 可见范围内确实没有 ⇒ 走下面那条遮蔽分支（先判权限，别拿 0 当"没有轮次"）。
  if (visibleTotal === 0) {
    const masked = await readMaskedRoundHistoryV2(tx, scope, noteId, query);
    if (masked) return masked;
  }
  return {
    rows: page,
    hasMore: rows.length > query.limit,
    shownCount: page.length,
    totalCount: visibleTotal,
    contentMasked: false,
  };
}

/**
 * 失权之后仍允许展示的那一份（§10.3 末段）。
 *
 * **读的时候就把可见性判据摘掉**，而不是"读出来再遮蔽"——后者要求先把受保护内容
 * 读进进程再丢掉，而那一读本身就越过了权限边界（读侧先收窄，不是读出来再遮蔽，
 * 与 W5-6 刀四同一条纪律）。
 *
 * 返回 `null` ＝ 那一篇**本来就没有**轮次，那不是失权：屏上要说的是「这一篇还没有
 * 过轮次」，而说成「这些记录涉及你已无权查看的内容」是在**凭空指控**用户发生过什么。
 * 判据用 `totalCount`：不带可见性判据的总数为 0 ⇒ 真的没有。
 */
async function readMaskedRoundHistoryV2(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  noteId: string,
  query: RoundHistoryQueryV1,
): Promise<{
  rows: NoteLearningRoundHistoryMaskedItemV1[];
  hasMore: boolean;
  shownCount: number;
  totalCount: number;
  contentMasked: true;
} | null> {
  const total = await tx
    .select({ total: sql`count(*)::int` })
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.noteId, noteId),
    ));
  const totalCount = Number(total[0]?.total ?? 0);
  if (totalCount === 0) return null;

  const rows = await tx
    .select({
      roundId: noteLearningRounds.id,
      phase: noteLearningRounds.phase,
      outcome: noteLearningRounds.outcome,
      startedAt: noteLearningRounds.createdAt,
      closedAt: noteLearningRounds.closedAt,
    })
    .from(noteLearningRounds)
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      eq(noteLearningRounds.noteId, noteId),
      ...(query.beforeRoundId
        ? [sql`(${noteLearningRounds.createdAt}, ${noteLearningRounds.id}) < (${query.beforeRoundId}::uuid, ${query.beforeRoundId}::uuid)`]
        : []),
    ))
    .orderBy(desc(noteLearningRounds.createdAt), desc(noteLearningRounds.id))
    .limit(query.limit + 1);

  return {
    rows: rows.slice(0, query.limit).map((row) => ({
      ...row,
      drivingQuestion: ROUND_HISTORY_MASKED_QUESTION_V1,
      contentMasked: true as const,
      // 遮蔽：它反映看过哪几道题，说出来等于复述结构。
      actualModes: [] as unknown as [],
      // 这两格**不读库**：它们要么要 join 教学/run 两张表（要读受保护内容才能算），
      // 要么在遮蔽状态下没有可诚实报的值。§10.3 允许留下的那一组里没有它们。
      systemUncertain: false,
      followUpSettledAt: null,
      startedAt: row.startedAt.toISOString(),
      phase: row.phase as NoteLearningRoundHistoryMaskedItemV1["phase"],
      outcome: row.outcome as NoteLearningRoundHistoryMaskedItemV1["outcome"],
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    })),
    hasMore: rows.length > query.limit,
    shownCount: Math.min(rows.length, query.limit),
    totalCount,
    contentMasked: true,
  };
}

/**
 * 记录那一行「实际方式」与「系统不确定项」两格的事实来源（PRD §10.3；39d W4-8 刀一）。
 *
 * 三条判据都是**发生过什么**，不是计划或配额，而且各只有一处来源：
 *  - `explained` = 这一轮有教学产物行（0284 只追加，讲过一次就永远算讲过；
 *    动态版生成失败不留 artifact 行，也不改变"讲过"这件事——D4 §6.2 那条分离）；
 *  - `practiced` = 有以这一轮为锚的 run（`origin ->> 'roundId'`，锚点由 `routes.ts:533` 签发）。
 *    **被中途放弃的也算发生过**：那一格答的是"这一轮练过没有"，不是"练出了什么"，
 *    后者是 `outcome` 与 `systemUncertain` 的活；
 *  - `systemUncertain` = 这一轮的某一笔判定是 `not_assessable`（我们判不了）。
 *    与 §3.2 那条同一口径：`not_assessable` 不是她的缺口，`declared_unable`（她明说不会）
 *    更不是——把后者算进这一格，等于把"她承认不会"报成"系统不确定"。
 *
 * 两次读都是**本页那几个 id 的 IN**，不是全表扫：一页最多 20 条（`ROUND_HISTORY_MAX_LIMIT_V1`），
 * 教学侧走 0284 的 `(round_id, ordinal)`，run 侧走的是与 `round-activity-sweep.ts:225`
 * 同一支 jsonb 读法（那张表今天很小，且已经按 (workspace,user) 收窄；哪天要加表达式索引，
 * 加在这里这一支上，不要在界面侧另数一遍）。
 */
export type RoundHistoryFactsV1 = {
  explainedRoundIds: ReadonlySet<string>;
  practicedRoundIds: ReadonlySet<string>;
  uncertainRoundIds: ReadonlySet<string>;
  /** §10.3 的「后续确认」：本轮收尾**之后**才落下来的结算时刻（一轮最多一个，取最晚那笔）。 */
  followUpSettledAtByRoundId: ReadonlyMap<string, string>;
};

export async function readRoundHistoryFactsV1(
  tx: ApiTransaction,
  roundIds: readonly string[],
): Promise<RoundHistoryFactsV1> {
  if (roundIds.length === 0) {
    return {
      explainedRoundIds: new Set(),
      practicedRoundIds: new Set(),
      uncertainRoundIds: new Set(),
      followUpSettledAtByRoundId: new Map(),
    };
  }
  const taughtRows = await tx
    .selectDistinct({ roundId: noteLearningRoundTeachings.roundId })
    .from(noteLearningRoundTeachings)
    .where(inArray(noteLearningRoundTeachings.roundId, [...roundIds]));
  const runRows = await tx
    .select({
      roundId: sql<string>`${learningRuns.origin} ->> 'roundId'`,
      outcome: sql<string | null>`${learningRuns.result} ->> 'outcome'`,
    })
    .from(learningRuns)
    .where(and(
      sql`${learningRuns.origin} ->> 'kind' = 'note_round'`,
      inArray(sql`${learningRuns.origin} ->> 'roundId'`, [...roundIds]),
    ));
  /**
   * 「后续确认」那一格（§10.3：迟到判定以**带时间**的补充记录展示）。只认
   * `learning_commit.completed` 那一笔——它是结算真落库的时刻；
   * `learning_assessment.completed` 只是"判完了"，可能根本没走到结算，认它会把
   * "判了但没挂上"说成"后来确认过"。与本轮 `closed_at` 比，严格大于才算"后来"。
   * 收尾之后被显式放弃的那一场不写这笔事件，所以也不会假报。
   */
  const followUpRows = await tx
    .select({
      roundId: noteLearningRounds.id,
      settledAt: sql<Date>`max(${learningRunEvents.occurredAt})`,
    })
    .from(noteLearningRounds)
    .innerJoin(learningRuns, sql`${learningRuns.origin} ->> 'roundId' = ${noteLearningRounds.id}::text`)
    .innerJoin(learningRunEvents, eq(learningRunEvents.runId, learningRuns.id))
    .where(and(
      inArray(noteLearningRounds.id, [...roundIds]),
      isNotNull(noteLearningRounds.closedAt),
      eq(learningRunEvents.eventType, "learning_commit.completed"),
      gt(learningRunEvents.occurredAt, noteLearningRounds.closedAt),
    ))
    .groupBy(noteLearningRounds.id);
  const followUpSettledAtByRoundId = new Map<string, string>(
    followUpRows
      .filter((row) => row.settledAt !== null)
      // `max()` 走的是裸 sql 片段，drizzle 不替它做类型映射：驱动可能给回 Date，
      // 也可能给回 ISO 文本（与连接池/解析设置有关）。两种都收，但都归一成合同那一份
      // 带偏移的 ISO——不能把"拿到的形状"直接端进回信。
      .map((row) => {
        const value = row.settledAt as Date | string;
        return [row.roundId, value instanceof Date ? value.toISOString() : new Date(value).toISOString()];
      }),
  );
  const explainedRoundIds = new Set(taughtRows.map((row) => row.roundId));
  const practicedRoundIds = new Set<string>();
  const uncertainRoundIds = new Set<string>();
  for (const row of runRows) {
    practicedRoundIds.add(row.roundId);
    if (row.outcome === "not_assessable") uncertainRoundIds.add(row.roundId);
  }
  return { explainedRoundIds, practicedRoundIds, uncertainRoundIds, followUpSettledAtByRoundId };
}

/**
 * §10.3 的第二级：本人（跨笔记）那一页（39d W4-8 刀二）。
 *
 * 与 `listRoundHistory` 同一套分页规矩（键集 `(created_at, id)`、总数用加游标**之前**
 * 的条件算、多取一行只回答"还有没有更早的"），差别只有两处，且都不是省事出来的：
 *  1. 不带走 `noteId` 那一格，改成**内连笔记**并只留"此刻读得到的那一篇"
 *     （软删的不列）。§10.3 末段那档"失去权限后只保留非内容元数据"要的是 D6 的
 *     权限投影（W5-6 名下）——在这里现造一个"遮蔽"谓词就是第二个权限来源，
 *     比少列几行更糟，所以这一版是整行不出现，欠的那一档写在台账里。
 *  2. 每一行带回 `noteId` 与 `noteTitle`：这一级没有"眼前这篇"的上下文，
 *     只有问题句子的那一行读不出是谁家的哪一篇。
 *
 * 总数与列表吃**同一份谓词**（都带那次内连）：不共用就会报出一个"列不出来的数"，
 * 合同里那条 `totalCount >= shownCount` 拦不住它（它只挡反方向）。
 */
export type RoundPersonalHistoryRowV1 = {
  round: NoteLearningRoundRow;
  noteId: string;
  noteTitle: string;
};

export type RoundPersonalHistoryPageV1 = {
  rows: RoundPersonalHistoryRowV1[];
  hasMore: boolean;
  shownCount: number;
  totalCount: number;
};

export async function listPersonalRoundHistory(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  query: RoundHistoryQueryV1,
): Promise<RoundPersonalHistoryPageV1> {
  if (query.beforeRoundId) {
    // 游标按"我自己的轮次"解析（不带那次内连）：位置由 `(created_at,id)` 定，
    // 指到一篇收进回收站的轮次仍然是一个合法位置；指到**别人的**轮次才要报错。
    const cursorRows = await tx
      .select({ id: noteLearningRounds.id })
      .from(noteLearningRounds)
      .where(and(
        eq(noteLearningRounds.workspaceId, scope.workspaceId),
        eq(noteLearningRounds.userId, scope.userId),
        eq(noteLearningRounds.id, query.beforeRoundId),
      ))
      .limit(1);
    if (!cursorRows[0]) throw new RoundServiceError("invalid_cursor", "这个游标不在我的轮次记录里");
  }
  const sameJoin = eq(notes.id, noteLearningRounds.noteId);
  const rows = await tx
    .select({
      round: noteLearningRounds,
      noteId: notes.id,
      noteTitle: notes.title,
    })
    .from(noteLearningRounds)
    .innerJoin(notes, sameJoin)
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      // 房子里那一份可见性判据（`visibleNotesCondition`），不是这里另写的规则：
      // 这一级会把别人的篇名与我那句问题一起端出去，那篇后来被收回私有就不该再出现。
      // 回收站**不**挡：那是可逆动作，为一篇收起的笔记藏掉一段真实历史等于把
      // "删除中"读成"没发生过"（§10.3 说的是权限，不是回收站）。
      // 静态守卫 `note-visibility-read-sites.test.ts` 要求判据**就近**在每个笔记读点上，
      // 所以下面那一发总数也各自带一次，而不是隔着几十行共用一个数组。
      visibleNotesCondition(scope.userId),
      ...(query.beforeRoundId ? [sql`(${noteLearningRounds.createdAt}, ${noteLearningRounds.id}) < (
        SELECT cursor_row.created_at, cursor_row.id
        FROM note_learning_rounds cursor_row
        WHERE cursor_row.id = ${query.beforeRoundId}::uuid
      )`] : []),
    ))
    .orderBy(desc(noteLearningRounds.createdAt), desc(noteLearningRounds.id))
    .limit(query.limit + 1);
  // 总数用**没带游标**的那一份条件：它答的是"我读得到的这些里一共几轮"，与翻到第几页无关。
  // （试过用 `count(*) over ()` 在同一发里带出来——那会把游标也算进去，第二页报出
  // "剩下还有几轮"，正是这一格要拦的形状；窗口计数与"与游标无关"不能同时成立。）
  const totalRows = await tx
    .select({ total: sql`count(*)::int` })
    .from(noteLearningRounds)
    .innerJoin(notes, sameJoin)
    .where(and(
      eq(noteLearningRounds.workspaceId, scope.workspaceId),
      eq(noteLearningRounds.userId, scope.userId),
      visibleNotesCondition(scope.userId),
    ));
  const page = rows.slice(0, query.limit);
  return {
    rows: page.map((row) => ({ round: row.round, noteId: row.noteId, noteTitle: row.noteTitle })),
    hasMore: rows.length > query.limit,
    shownCount: page.length,
    totalCount: Number(totalRows[0]?.total ?? 0),
  };
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

// ─── 轮次里的教学产物（39d W4-6 刀一；表 0284）────────────────────────────

function toTeachingContract(row: NoteLearningRoundTeachingRow): RoundTeachingV1 {
  return roundTeachingV1Schema.parse({
    version: 1,
    teachingId: row.id,
    roundId: row.roundId,
    ordinal: row.ordinal,
    kind: row.kind,
    content: row.content,
    sourceBlockOrdinals: row.sourceBlockOrdinals,
    personalSources: row.personalSourceSnapshots,
    createdAt: row.createdAt.toISOString(),
  });
}

/** 这一轮的教学产物（按 `ordinal` 升序 = 生成顺序）。空数组是真的"还没生成过"。 */
export async function listTeachings(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<RoundTeachingV1[]> {
  // 39d W5-6 刀一（§16.13）：这一级返回**讲解正文**，以前只按 (workspace, user) 过滤。
  // 这条是扩展棘轮时才发现的——第一刀我按"哪些读点返回笔记内容"手工点了一遍，
  // 漏了它；是 ratchet 把整族摆出来之后才量到的，所以那一族守卫不是摆设。
  const rows = await tx
    .select({ teaching: noteLearningRoundTeachings })
    .from(noteLearningRoundTeachings)
    .innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundTeachings.roundId))
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRoundTeachings.roundId, roundId),
      eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId),
      eq(noteLearningRoundTeachings.userId, scope.userId),
      visibleNotesCondition(scope.userId),
    ))
    .orderBy(noteLearningRoundTeachings.ordinal);
  return rows.map((row) => toTeachingContract(row.teaching));
}

/**
 * 能不能直接复用已有的那一条（W4-6 刀一那条"同快照重复请求返回同一条，不重付"）。
 *
 * 判据是三件全同：轮次、本轮问题版本、快照哈希（外加 `kind`）。**不靠**库里一条唯一索引：
 * §16.3 的「换解释」将来要在同一个问题下落第二条（见 0284 的注释），唯一索引会把那个
 * 产品选择挡在门外；这里读**最近一条**匹配行——只追加的表里同键只可能是重复请求造成的，
 * 而重复请求本来就该拿到同一条。
 */
export async function findReusableTeaching(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  key: {
    roundId: string;
    kind: RoundTeachingKindV1;
    drivingQuestionRevision: number;
    snapshotHash: string;
    personalSources?: NoteReflectionTeachingSnapshotV1[];
  },
): Promise<RoundTeachingV1 | null> {
  // 39d W5-6 刀一（§16.13）：讲解**正文**经 round 间接取自那篇笔记，所以要经
  // round → notes 带上可见性判据。这条读点以前只按 (workspace, user) 过滤，
  // 共享撤回之后仍能复用缓存讲解。回收站不挡，理由同 `readOpenRound`。
  const rows = await tx
    .select({ teaching: noteLearningRoundTeachings })
    .from(noteLearningRoundTeachings)
    .innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundTeachings.roundId))
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRoundTeachings.roundId, key.roundId),
      eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId),
      eq(noteLearningRoundTeachings.userId, scope.userId),
      eq(noteLearningRoundTeachings.kind, key.kind),
      eq(noteLearningRoundTeachings.drivingQuestionRevision, key.drivingQuestionRevision),
      eq(noteLearningRoundTeachings.snapshotHash, key.snapshotHash),
      visibleNotesCondition(scope.userId),
    ))
    .orderBy(desc(noteLearningRoundTeachings.ordinal));
  // POST passes the learner's explicit selection (including []), which is part of
  // the idempotency key. GET omits it and should read the latest teaching for
  // this question/snapshot regardless of whether that teaching used private context.
  const expected = key.personalSources;
  const match = rows.find(({ teaching }) => {
    const actual = z.array(noteReflectionTeachingSnapshotV1Schema).max(3).safeParse(teaching.personalSourceSnapshots);
    return actual.success && (expected === undefined || JSON.stringify(actual.data) === JSON.stringify(expected));
  });
  return match ? toTeachingContract(match.teaching) : null;
}

/**
 * 这一轮已经生成过几条教学产物——预算判据要的那个数。
 *
 * 今天"一次生成 = 一条产物"：确定性 provider 不花模型调用，接真模型那一刀之后
 * 一次生成可能含自动重试（`maxAutoRetries`），那时候这个数不再等于"真实调用次数"，
 * 要按内核回执把重试加进来（登记在 W4-6 的状态格里）。
 */
export async function countTeachings(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  roundId: string,
): Promise<number> {
  const rows = await tx
    .select({ total: sql<number | null>`count(*)` })
    .from(noteLearningRoundTeachings)
    .where(and(
      eq(noteLearningRoundTeachings.roundId, roundId),
      eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId),
      eq(noteLearningRoundTeachings.userId, scope.userId),
    ));
  return Number(rows[0]?.total ?? 0);
}

/**
 * 追加一条教学产物（只追加；0284 的触发器与权限层是最终防线）。
 *
 * 三条判据与前几个写动作同形：轮次必须开着（closed ⇒ `round_closed`）、
 * `expectedRevision` 必须等于读过的那一版（`stale_revision`）、内容与依据先过合同。
 *
 * **不推进轮次 revision**：D1 §6.3 那个计数器是"状态与计划修订"共用的，教学产物两者
 * 都不是（它是派生内容，不是这一轮走到哪一步）。所以这里没有 round 的 UPDATE——
 * CAS 由 `FOR UPDATE` 锁住那一行之后比一次承担；并发重复请求的"多落一条"由
 * `findReusableTeaching` 预读 + 轮内序号唯一索引兜底，而不是靠把 revision 吹大。
 *
 * 刀五（39d W4-6）在这里连带写**动态产物行**并把 id 回写到教学行上。顺序必须是
 * **先生成内容 → 插产物行 → 插教学产物行（带 artifactId）**：教学表是只追加的
 * （0284 触发器挡 UPDATE），`artifact_id` 只有在 INSERT 那一刻带得上。两条行同属
 * 调用方的这一条短事务；产物那一半**怎么失败都不许把教学这一半拖下水**——
 * 见 `insertTeachingArtifactV1`。
 */
export async function createTeaching(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  request: {
    roundId: string;
    expectedRevision: number;
    kind: RoundTeachingKindV1;
    content: unknown;
    sourceBlockOrdinals: number[];
    personalSources?: NoteReflectionTeachingSnapshotV1[];
    snapshotHash: string;
    drivingQuestionRevision: number;
    kernelTaskRef: string | null;
    /**
     * 动态产物的来源（刀五；39d W4-1 尾把 `material` 那一支换成 `rendered` 也能走）。
     * **省略 = 这一条只有文字形态**：`artifact_id` 留空，与"产物生成失败"落在同一格
     * （合同不区分这两件事——两者都是"没有动态版本"）。
     *
     * `rendered` 那一支是**事务外**渲染好的整份 HTML：模型写讲解、可信播放器执行，
     * 读数由服务端算（§6.1）。这一层只落库。
     */
    artifact?: RoundArtifactSourceV1;
    /**
     * 生成阶段（`generate` 档）已经发生的那次失败，**在教学行落库之后**补记。
     *
     * 为什么由调用方回传而不是这里自己发那次调用：生成必须在事务外（D5 §5.2），而
     * 失败留痕必须挂在 `teaching_id` 上——教学行那一刻还不存在。两件事隔开做，中间
     * 这一段就是回传。省略 = 没有发过那次调用（**没请求过** 与 **请求了但失败** 是
     * §6.2 要求说不同话的两件事，界面上也就靠这一格区分）。
     */
    artifactGenerationFailure?: {
      reason: Extract<ArtifactFailureReasonV1, "model_failed" | "contract_rejected">;
      detail: string;
    } | null;
  },
  options: {
    now?: Date;
    /**
     * 产物失败的原因往哪说（路由把 `req.log` 传下来）。失败策略是"教学照常成功"，
     * 所以这里不是错误出口，只是**把原因留在服务端日志里**的那一格。
     */
    reportArtifactFailure?: (message: string) => void;
  } = {},
): Promise<RoundTeachingV1> {
  const now = options.now ?? new Date();
  const reportArtifactFailure = options.reportArtifactFailure ?? (() => {});
  const parsedContent = roundTeachingContentV1Schema.safeParse(request.content);
  if (!parsedContent.success) {
    throw new RoundServiceError(
      "invalid_teaching_content",
      `这条教学产物的内容不合法：${parsedContent.error.issues[0]?.message ?? "形状不对"}`,
    );
  }
  const ordinals = request.sourceBlockOrdinals;
  if (
    !Array.isArray(ordinals)
    || ordinals.length > 200
    || ordinals.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    throw new RoundServiceError("invalid_teaching_content", "依据块序号必须是 1 起的整数（最多 200 个）");
  }
  const personalSources = z.array(noteReflectionTeachingSnapshotV1Schema).max(3).safeParse(request.personalSources ?? []);
  if (!personalSources.success) throw new RoundServiceError("invalid_teaching_content", "私人理解来源快照不合法");

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
    throw new RoundServiceError("round_closed", "这一轮已经收尾，终态只读：不再生成新的教学内容");
  }
  if (row.revision !== request.expectedRevision) {
    throw new RoundServiceError("stale_revision", "这一轮的状态已经变化，请刷新后重试");
  }

  const ordinalRows = await tx
    .select({ maxOrdinal: sql<number | null>`max(${noteLearningRoundTeachings.ordinal})` })
    .from(noteLearningRoundTeachings)
    .where(eq(noteLearningRoundTeachings.roundId, row.id));
  const nextOrdinal = Number(ordinalRows[0]?.maxOrdinal ?? 0) + 1;

  // 刀五的顺序：内容 → 产物行 → 教学行（教学表只追加，id 只能在插入那一刻带上）。
  // 产物构建/渲染失败**不在这里落库**：产物行落在教学行之前，那时还没有 teaching_id
  // 可挂（0298 头注「为什么 teaching_id 可空」）。留到教学行落库之后那一段再写，那时能
  // 挂到具体的一条讲解上。**生成阶段**（事务外那一次模型调用）的失败同理。
  const artifactWrite = request.artifact
    ? await insertTeachingArtifactV1(tx, scope, {
      roundId: row.id,
      source: request.artifact,
      snapshotHash: request.snapshotHash,
      createdAt: now,
    }, reportArtifactFailure)
    : { artifactId: null, failure: null };
  const artifactId = artifactWrite.artifactId;

  const inserted = await tx.insert(noteLearningRoundTeachings).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    roundId: row.id,
    ordinal: nextOrdinal,
    kind: request.kind,
    content: parsedContent.data as unknown as Record<string, unknown>,
    sourceBlockOrdinals: ordinals,
    personalSourceSnapshots: personalSources.data as unknown as unknown[],
    // 哈希与问题版本记的是**生成时刻**的那两份（D3 §5）：轮次行上的哈希不可改写，
    // 但"这条解释是按哪一版做的"只有写在产物行上才回答得了。
    snapshotHash: request.snapshotHash,
    drivingQuestionRevision: request.drivingQuestionRevision,
    kernelTaskRef: request.kernelTaskRef,
    artifactId,
    createdAt: now,
  }).returning();
  const teachingRow = inserted[0];
  if (!teachingRow) throw new RoundServiceError("create_failed", "这条教学产物没落下来");
  // §16.4「动态交付失败记录保留」：教学行已经落下来了，此刻才有 teaching_id 可挂，
  // 所以两条失败留痕都写在这里而不是各自产生的那一侧。**写失败不许影响这一行**——它记的
  // 是两件独立的事（D4 §6.2：动态失败不冒充教学失败），所以刻意不包 SAVEPOINT：真写不
  // 进去时整发失败，比"教学行落了但失败原因丢了"更容易被发现。
  // 两条**都**写（而不是 `??` 取一条）：生成失败之后有可能照样渲染出了产物（模型那一发
  // 重试成了），也可能渲染整份被拒（超配额）——那是两件独立的事，各占一行才对得上
  // §18.3 把「动画成功」与「内容可教学」分开数的那句话。
  for (const failure of [
    ...(request.artifactGenerationFailure
      ? [{
        stage: "generate" as const,
        reason: request.artifactGenerationFailure.reason,
        detail: request.artifactGenerationFailure.detail,
      }]
      : []),
    ...(artifactWrite.failure ? [artifactWrite.failure] : []),
  ]) {
    await recordArtifactFailureV1(tx, scope, {
      roundId: row.id,
      teachingId: teachingRow.id,
      stage: failure.stage,
      reason: failure.reason,
      detail: failure.detail,
      snapshotHash: request.snapshotHash,
      createdAt: now,
    });
  }
  return toTeachingContract(teachingRow);
}

/**
 * 写这一条教学的动态版本（刀五）。返回 `null` **永远不等于"这一条教学失败"**：
 * D4 §6.2「动态失败不冒充教学失败」——生成失败或超配额时教学行照写、`artifact_id` 留空，
 * 原因只进服务端日志。
 *
 * 为什么要套一层 SAVEPOINT（nested transaction）：产物 INSERT 一旦抛错（连接、约束、
 * 权限），整个事务会进入 aborted 状态，后面那条教学行连写都写不下去——那就把"产物失败"
 * 升级成了"教学失败"。保存点把失败圈在产物这一半里，回滚之后教学行照常落
 * （`markdown-import-service.ts` 的单篇导入用的是同一形状）。
 */
async function insertTeachingArtifactV1(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  params: { roundId: string; source: RoundArtifactSourceV1; snapshotHash: string; createdAt: Date },
  reportFailure: (message: string) => void,
): Promise<{
  artifactId: string | null;
  /**
   * 失败详情，**回传给调用方去落库**（0298 `note_learning_round_artifact_failures`），
   * 而不再只是进一次日志。§16.4 验收第一句要的就是"失败原因事后读得到"，而日志做不到。
   * 形状与迁移 0298 建立、0304 拓宽之后的 `nlraf_stage_reason_chk` 同一组取值。
   */
  failure: {
    stage: ArtifactFailureStageV1;
    reason: ArtifactFailureReasonV1;
    detail: string;
  } | null;
}> {
  // 这一层**只落库**，不再生成：模型调用与渲染都在事务外做完了（D5 §5.2 三段式的
  // 第二段），落到这里时只剩一次 INSERT。这里若再敢调一次模型，就是把持行锁等外部
  // 响应这件事又请回来——而 `ai-task-kernel` 那道闸门只查作用域，查不到这里。
  //
  // 认不出来的 `kind` **当场喊**，而不是掉进 `buildDeterministicArtifactHtmlV1` 里报
  // "Cannot read properties of undefined (reading 'explanation')"：那一句读起来像是
  // 材料空，实际是**调用方给错了形状**，而把它说成前者会让排查从材料查起。
  if (params.source.kind !== "rendered" && params.source.kind !== "material") {
    throw new Error(
      `产物来源的 kind 不认识：${String((params.source as { kind?: unknown }).kind)}`
      + "（只有 rendered（事务外渲染好的整份 HTML）与 material（原始材料）两种）",
    );
  }
  const built = params.source.kind === "rendered"
    ? verifyRenderedArtifactHtmlV1(params.source.html)
    : buildDeterministicArtifactHtmlV1(params.source.input);
  if (!built.ok) {
    reportFailure(`这一条教学产物的动态版本没有生成（${built.reason}）：${built.detail}`);
    // 构建失败的 reason 与 0304 的 build 档两档同宽；对不上就在这里炸，
    // 不让它落到库 CHECK 上半夜拒一次。
    if (built.reason !== "empty" && built.reason !== "over_quota") {
      throw new Error(`产物构建失败的 reason 不在 0304 的 build 档里：${built.reason}`);
    }
    return { artifactId: null, failure: { stage: "build", reason: built.reason, detail: built.detail } };
  }
  try {
    const artifactId = await tx.transaction(async (artifactTx) => {
      const inserted = await artifactTx.insert(noteLearningRoundArtifacts).values({
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        roundId: params.roundId,
        kind: ROUND_ARTIFACT_KIND_V1,
        html: built.html,
        snapshotHash: params.snapshotHash,
        // §6.3「保存实际使用版本」：同一份 HTML 里已经写了这一行，画面上当场可查；
        // 库里这一列是给事后按生成器分组用的。确定性那条路没有模型版本，留空。
        generatorRef: params.source.kind === "rendered" ? params.source.generatorRef : "",
        createdAt: params.createdAt,
      }).returning({ id: noteLearningRoundArtifacts.id });
      const artifactRow = inserted[0];
      if (!artifactRow) throw new Error("这一份动态产物没有落下来");
      return artifactRow.id;
    });
    return { artifactId, failure: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportFailure(`这一条教学产物的动态版本没有落库（教学那一半照常写）：${message}`);
    return { artifactId: null, failure: { stage: "persist", reason: "persist_failed", detail: message } };
  }
}

/**
 * 落库前**第二道**配额闸（第一道在渲染器 `buildDynamicArtifactHtmlV1` 里，第三道在桌面
 * `assembleArtifactDocument` 里）。
 *
 * 为什么渲染器已经查过还要再查一次：渲染器与落库之间隔着一次 HTTP 回程与一次
 * `createTeaching` 调用，而整份拒绝（而不是截断）这条判据的**代价**落在库 CHECK 上——
真到库那里才发现超长，得到的是一次 23514，于是"超配额"这件事被误报成"约束冲突"，
 * 而 0298 的 `over_quota` 那一档正是为它准备的。
 */
function verifyRenderedArtifactHtmlV1(html: string): { ok: true; html: string } | { ok: false; reason: "empty" | "over_quota"; detail: string } {
  if (html.trim().length === 0) {
    return { ok: false, reason: "empty", detail: "渲染器交回来的产物是空的" };
  }
  const length = artifactCharLengthV1(html);
  if (length > ROUND_ARTIFACT_MAX_CHARS_V1) {
    return {
      ok: false,
      reason: "over_quota",
      detail: `产物 ${length} 字符，超过上限 ${ROUND_ARTIFACT_MAX_CHARS_V1}（整份拒绝，不截断）`,
    };
  }
  return { ok: true, html };
}

/**
 * 一条教学产物的动态版本引用（刀五的读侧那一格）。`null` = 这一条没有动态版本——
 * **不是失败**（D4 §6.2）：文字解释照旧在 `content` 里，界面照旧要能读能练。
 *
 * 不做 phase 限制：轮次关闭后历史回放要能取到同一份产物，所以只按"这条教学行现在
 * 可见吗"读，不看轮次是不是开着。产物行读不到（不可见或已被维护路径清掉）也如实回
 * `null`——渲染层据此决定挂不挂宿主，挂一个取不到的 id 只会画出浏览器自己的错误页。
 */
export async function readTeachingArtifactRef(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  teachingId: string,
): Promise<RoundTeachingArtifactRefV1 | null> {
  const teachingRows = await tx
    .select({ artifactId: noteLearningRoundTeachings.artifactId })
    .from(noteLearningRoundTeachings)
    .innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundTeachings.roundId))
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRoundTeachings.id, teachingId),
      eq(noteLearningRoundTeachings.workspaceId, scope.workspaceId),
      eq(noteLearningRoundTeachings.userId, scope.userId),
      // 39d W5-6 刀一：只回一个 artifactId 指针，但**拿到它就能取到 HTML**，
      // 所以指针本身也是一扇门——失权之后不该再递出这把钥匙。
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  const artifactId = teachingRows[0]?.artifactId ?? null;
  if (!artifactId) return null;

  const artifactRows = await tx
    .select({
      id: noteLearningRoundArtifacts.id,
      kind: noteLearningRoundArtifacts.kind,
      createdAt: noteLearningRoundArtifacts.createdAt,
    })
    .from(noteLearningRoundArtifacts)
    .where(and(
      eq(noteLearningRoundArtifacts.id, artifactId),
      eq(noteLearningRoundArtifacts.workspaceId, scope.workspaceId),
      eq(noteLearningRoundArtifacts.userId, scope.userId),
    ))
    .limit(1);
  const row = artifactRows[0];
  if (!row) return null;
  return roundTeachingArtifactRefV1Schema.parse({
    version: 1,
    artifactId: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * 按 id 取整份动态产物 HTML（刀五的 GET 路由那一条读）。显式 (workspace, user) 过滤与
 * 其余读法同形：命中不了（不存在或对当前这个人不可见）就回 `null`，由路由翻成 404。
 * **不做 phase 限制**：历史回放取的就是旧轮次的同一份产物。
 */
export async function readRoundArtifactHtml(
  tx: ApiTransaction,
  scope: RoundScopeV1,
  artifactId: string,
): Promise<string | null> {
  // 39d W5-6 刀一（§16.13／§14.4）：**整份动态讲解 HTML** 是受保护内容里最直接的一份，
  // 以前只按 (workspace, user) 过滤——共享撤回之后仍然取得到。经 round → notes 判可见性。
  const rows = await tx
    .select({ html: noteLearningRoundArtifacts.html })
    .from(noteLearningRoundArtifacts)
    .innerJoin(noteLearningRounds, eq(noteLearningRounds.id, noteLearningRoundArtifacts.roundId))
    .innerJoin(notes, eq(notes.id, noteLearningRounds.noteId))
    .where(and(
      eq(noteLearningRoundArtifacts.id, artifactId),
      eq(noteLearningRoundArtifacts.workspaceId, scope.workspaceId),
      eq(noteLearningRoundArtifacts.userId, scope.userId),
      visibleNotesCondition(scope.userId),
    ))
    .limit(1);
  return rows[0]?.html ?? null;
}
