/**
 * 轮次活跃度的**服务端对账扫描**（39d W4-5 ④；PRD §3.2「没有其他活跃端时标记可恢复暂停，
 * 不新增轮次」，判据本体在 `round-idle-pause-policy.ts`）。
 *
 * 这一层只负责四件事，其余都在判据那份纯函数里：
 *  1. **枚举要看的 (空间,人)**：活跃度与轮次都是按人算的，所以扫描的单位就是一个 scope。
 *  2. **按 scope 读那三格证据**（live 租约／挂在这一轮上的非终态 run／最后一次变化），
 *     读法全部带同一对 GUC，`now` 由同一发给出（两条时间判据不许各自读一次时钟）。
 *  3. **动作只走 `advanceRound` 那条 `pause` 转移**——**这一层一行 UPDATE 都不写**：
 *     `paused_at` 记账、共用计数器前进一步、身份列不动，这三件都由 reducer + CAS 那一条路保证。
 *  4. **不新增轮次**（PRD 明令）：这一发只有"转态"这一种动作，没有 createRound 的调用点。
 *
 * ─── 两条现场量到的形状（2026-09-26，一次性库 `ailearn_w45_sweep` 上以 `ailearn_api` 实测）
 *  - `note_learning_rounds` 是 FORCE RLS 且谓词是纯 `(workspace_id,user_id)` GUC 匹配，
 *    **没有** worker 旁路（D1 §6.5）：裸读 0 行、只设 `app.workspace_id` 也是 0 行，
 *    必须两个 GUC 都带上才看得见（本仓库那一条"裸读也要带两个 set_config"的旧坑，同一族）。
 *    所以扫描不是"一条 SQL 扫全库"，而是**逐 scope 开一个带上下文的事务**。
 *  - 待扫的 scope 由 **0286 那支预筛函数**给（`ailearn_note_rounds_idle_for_pause`）：
 *    它以 `SECURITY DEFINER`（owner `ailearn_migrator`，带 BYPASSRLS）跨租户挑出
 *    "active 且已过宽限期"的 (空间,人)，扫描只对这批开事务。为什么不裸枚举
 *    `workspace_members`：那样每一趟的代价随**成员数**长，而不是随在学的轮次长——
 *    实测 1 330 条成员 ⇒ 2149 / 2026 / 1846 ms 且停掉 0 条（39d §19 同日那行）。
 *    预筛只是**候选**，不是判决：每个 scope 里那三格证据仍在带 GUC 的事务里重读一遍，
 *    所以函数多算或漏算都不会把一个不该停的轮次停下来。
 *
 * ─── 一处已知的窗口，写在这里而不是藏起来
 *  读租约与写那一行之间仍可能有人正好回来 publish 一份新上下文：那一发**挡不住**，
 *  因为续租不推进轮次的 `revision`，CAS 看不见它。后果是"她刚回来，这一轮还停着"，
 *  一次点击就能接回去（W4-5 ④ 前置那一发），不丢任何数据。要收窄就得让 publish 那一条路
 *  顺手推进轮次计数器——那是另一笔设计决定，不在这一刀顺手做。
 */
import { and, asc, eq, gt, isNull, notInArray, sql } from "drizzle-orm";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { assistantPageContexts } from "@ailearn/shared/db-schema/companion-bridge";
import { learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import { noteLearningRounds } from "@ailearn/shared/db-schema/note-learning-rounds";
import { advanceRound, RoundServiceError, type RoundScopeV1 } from "./round-service.ts";
import {
  evaluateRoundIdlePauseV1,
  LEARNING_RUN_TERMINAL_PHASES_V1,
  ROUND_ACTIVITY_SWEEP_MAX_ROUNDS_PER_SCOPE_V1,
  ROUND_IDLE_PAUSE_GRACE_MS_V1,
  roundActivitySweepDisabledNoteV1,
  roundActivitySweepIntervalMsV1,
  type RoundIdlePauseBlockerV1,
} from "./round-idle-pause-policy.ts";

export type RoundIdlePausedV1 = {
  roundId: string;
  workspaceId: string;
  userId: string;
  noteId: string;
  /** 推进之后那一版的计数器值（幂等读数就钉在这一格上）。 */
  revision: number;
  pausedAt: string;
};

export type RoundActivitySweepResultV1 = {
  /** `false` = `off` 档：这一发什么都没做，与改前完全一致。 */
  enabled: boolean;
  /** 与 `enabled` 同义的另一句读数（关掉时要能在日志里说出是哪一档）。 */
  disabledReason: string | null;
  scopesScanned: number;
  roundsConsidered: number;
  paused: RoundIdlePausedV1[];
  /** 四条判据各自挡住了几条：没有这一格，"这一轮还在跑"就没有主语。 */
  blocked: Partial<Record<RoundIdlePauseBlockerV1, number>>;
  /** 读到 active 但写的时候被 CAS/终态挡下的条数（有人正好动了它，不是缺陷）。 */
  skippedByRace: number;
};

export type RoundActivitySweepOptionsV1 = {
  /** 这一发的"现在"。给单测与集测钉宽限期边界用（不靠 sleep 撞时间）。 */
  now?: Date;
  /**
   * 只扫这一个 (空间,人)。缺省 = 扫全部在册成员的空间。
   * 定点那一发同时是"跨 workspace/user 不可见"那条判据的可钉形状：
   * 带 scope 时**只有**这一个 scope 的行会被读到、被写过。
   */
  scope?: RoundScopeV1;
};

/** in-flight 守卫（照 `identity/service.ts:473` 的 `sessionCleanupRunning`）：定时器慢的时候不许叠加。 */
let sweepRunning = false;

/**
 * 扫一遍：把"进行中的轮次 + 该 (空间,人) 已无任何活跃端 + 这一轮没有开着的 run +
 * 距离最后一次变化已超过宽限期"那一格转成可恢复暂停。
 *
 * 可独立调用（集测直接 `await sweepIdleNoteRoundsForPauseV1({...})`），不依赖任何定时器。
 */
export async function sweepIdleNoteRoundsForPauseV1(
  options: RoundActivitySweepOptionsV1 = {},
): Promise<RoundActivitySweepResultV1> {
  const intervalMs = roundActivitySweepIntervalMsV1();
  const empty: RoundActivitySweepResultV1 = {
    enabled: intervalMs !== null,
    disabledReason: intervalMs === null ? roundActivitySweepDisabledNoteV1() : null,
    scopesScanned: 0,
    roundsConsidered: 0,
    paused: [],
    blocked: {},
    skippedByRace: 0,
  };
  if (intervalMs === null) return empty;

  const now = options.now ?? new Date();
  if (options.scope) return await runSweep(empty, now, [options.scope]);

  // 关着守卫：只有"全部空间"那一发会叠加（一次没跑完又来一次），定点那一发随时可进。
  if (sweepRunning) return empty;
  sweepRunning = true;
  try {
    return await runSweep(empty, now, await listSweepScopes());
  } finally {
    sweepRunning = false;
  }
}

/**
 * 待扫的 (空间,人)：在册成员（`left_at IS NULL`）去重。见文件头第二条实测。
 *
 * 成本实测（2026-09-26，dev 库）：1 330 条在册成员 ⇒ 每一发是 1 330 个"一次索引探测、
 * 绝大多数返回 0 行"的小事务（那条 WHERE 走 0282 部分唯一索引的前两列）。这一发是**收敛用的
 * 对账**，不是热路径；真到了量级失控那一天，正确的改法是把候选 scope 变成一条队列
 * （像 `learning_run_processing_outbox` 那样），**不是**把间隔拉长或给枚举加上限——
 * 上限只会让排在后面的空间永远扫不到（`note/maintenance.ts:55-57` 那条"没有 ORDER BY 的 LIMIT
 * 会把配额占满、饿死后面的笔记"是同一件事的另一半）。
 */
async function listSweepScopes(): Promise<RoundScopeV1[]> {
  // `as unknown as`：drizzle 给 postgres.js 的返回类型是 RowList，直接 cast 成数组会撞
  // TS2352（本仓库踩过）；这里的形状由那支函数的 RETURNS TABLE 定，不是猜的。
  const rows = (await db.execute(
    sql`SELECT DISTINCT workspace_id, user_id
          FROM public.ailearn_note_rounds_idle_for_pause(${ROUND_IDLE_PAUSE_GRACE_MS_V1})`,
  )) as unknown as ReadonlyArray<{ workspace_id: string; user_id: string }>;
  return rows.map((row) => ({ workspaceId: row.workspace_id, userId: row.user_id }));
}

async function runSweep(
  base: RoundActivitySweepResultV1,
  now: Date,
  scopes: readonly RoundScopeV1[],
): Promise<RoundActivitySweepResultV1> {
  const result: RoundActivitySweepResultV1 = {
    ...base,
    scopesScanned: 0,
    roundsConsidered: 0,
    paused: [],
    blocked: {},
    skippedByRace: 0,
  };
  for (const scope of scopes) {
    const outcome = await sweepOneScope(scope, now);
    result.scopesScanned += 1;
    result.roundsConsidered += outcome.roundsConsidered;
    result.paused.push(...outcome.paused);
    result.skippedByRace += outcome.skippedByRace;
    for (const [blocker, count] of Object.entries(outcome.blocked)) {
      const key = blocker as RoundIdlePauseBlockerV1;
      result.blocked[key] = (result.blocked[key] ?? 0) + (count ?? 0);
    }
  }
  return result;
}

type ScopeSweepOutcome = {
  roundsConsidered: number;
  paused: RoundIdlePausedV1[];
  blocked: Partial<Record<RoundIdlePauseBlockerV1, number>>;
  skippedByRace: number;
};

/**
 * 一个 (空间,人) 一发事务：读三格证据 → 判 → 走 `advanceRound` 的 `pause`。
 *
 * 三格证据的读法各有出处：
 *  - live 租约 = `assistant_page_contexts` 里**未过期且未撤销**的行（`expires_at > now`
 *    且 `revoked_at IS NULL`）。撤销与过期是两条不同的路（显式撤销 vs 30 秒到点），
 *    只判其中一条都会把"已经不算活跃"的那一份当成活跃端。
 *  - 非终态 run = `origin ->> 'roundId'` 指回来且 `phase` 不在终态那五档里
 *    （终态集合取 `round-idle-pause-policy.ts`，与 `run-service.ts:3124` 那份 `activePhases` 同判据）。
 *  - 最后一次变化 = 轮次行自己的 `updated_at`：它记的是"这一轮的状态/计划/问题被动过"，
 *    与"人还在不在"无关——所以它是判据④那条**退避**，不是判据②的替代品。
 */
async function sweepOneScope(scope: RoundScopeV1, now: Date): Promise<ScopeSweepOutcome> {
  return withWorkspaceTransaction(scope, async (tx) => {
    const candidates = await tx
      .select({
        id: noteLearningRounds.id,
        noteId: noteLearningRounds.noteId,
        revision: noteLearningRounds.revision,
        updatedAt: noteLearningRounds.updatedAt,
      })
      .from(noteLearningRounds)
      .where(and(
        eq(noteLearningRounds.workspaceId, scope.workspaceId),
        eq(noteLearningRounds.userId, scope.userId),
        // 判据①在 SQL 里先收窄一次（走 0282 那条部分唯一索引的前两列）：
        // `paused`/`closed` 的行根本不会被读进来，"绝不碰它们"因此不是靠事后判断。
        eq(noteLearningRounds.phase, "active"),
      ))
      .orderBy(asc(noteLearningRounds.updatedAt), asc(noteLearningRounds.id))
      .limit(ROUND_ACTIVITY_SWEEP_MAX_ROUNDS_PER_SCOPE_V1);
    const outcome: ScopeSweepOutcome = {
      roundsConsidered: candidates.length,
      paused: [],
      blocked: {},
      skippedByRace: 0,
    };
    if (candidates.length === 0) return outcome;

    const leaseRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assistantPageContexts)
      .where(and(
        eq(assistantPageContexts.workspaceId, scope.workspaceId),
        eq(assistantPageContexts.userId, scope.userId),
        isNull(assistantPageContexts.revokedAt),
        gt(assistantPageContexts.expiresAt, now),
      ));
    const livePageContextCount = Number(leaseRows[0]?.n ?? 0);

    const openRunRows = livePageContextCount > 0 ? [] : await tx
      .selectDistinct({ roundId: sql<string>`${learningRuns.origin} ->> 'roundId'` })
      .from(learningRuns)
      .where(and(
        eq(learningRuns.workspaceId, scope.workspaceId),
        eq(learningRuns.userId, scope.userId),
        // `notInArray` 不收 readonly 数组（那份常量是冻结的），复制一份进 SQL 而不是把常量松开。
        notInArray(learningRuns.phase, [...LEARNING_RUN_TERMINAL_PHASES_V1]),
        sql`${learningRuns.origin} ->> 'roundId' IS NOT NULL`,
      ));
    const openRunRoundIds = new Set(openRunRows.map((row) => row.roundId));

    for (const round of candidates) {
      const decision = evaluateRoundIdlePauseV1({
        phase: "active",
        livePageContextCount,
        openLearningRunCount: openRunRoundIds.has(round.id) ? 1 : 0,
        lastChangedAt: round.updatedAt,
        now,
      });
      if (!decision.shouldPause) {
        if (decision.blockedBy) {
          outcome.blocked[decision.blockedBy] = (outcome.blocked[decision.blockedBy] ?? 0) + 1;
        }
        continue;
      }
      try {
        const advanced = await advanceRound(tx, scope, {
          roundId: round.id,
          expectedRevision: round.revision,
          action: { kind: "pause" },
        }, now);
        outcome.paused.push({
          roundId: advanced.roundId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          noteId: advanced.noteId,
          revision: advanced.revision,
          pausedAt: advanced.pausedAt ?? now.toISOString(),
        });
      } catch (err) {
        // 同一发事务里读到 active、写的时候被 CAS 或终态挡下：那是有人正好动了它，
        // 记一笔继续扫别的，不把整轮扫描判成失败。
        if (err instanceof RoundServiceError
          && ["stale_revision", "round_closed", "round_not_found", "invalid_transition"].includes(err.code)) {
          outcome.skippedByRace += 1;
          continue;
        }
        throw err;
      }
    }
    return outcome;
  });
}
