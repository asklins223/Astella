/**
 * 「最后一个活跃端离开 ⇒ 把进行中的轮次标成可恢复暂停」的**纯判据**
 * （39d W4-5 ④；PRD §3.2 那句「没有其他活跃端时标记可恢复暂停，**不新增轮次**」）。
 *
 * 为什么单独一个文件（形状取自 `learning-runs/gap-help-policy.ts`）：
 *  - **判据是纯函数**：输入是"这一轮此刻读到的四件事"，输出是"该不该停 + 被哪一条挡住"。
 *    读库、写库、CAS、幂等全在调用方（`round-activity-sweep.ts`），这一份只做决定——
 *    所以它可被单测钉死、可被变异验，四条判据各自有名字（`blockedBy`），不会糊成一句"没停"。
 *  - **可调参数只有一处常量＋一个环境变量**（本仓库既有约定，见 `round-budgets.ts`）：
 *    总控是 `roundActivitySweepIntervalMsV1()`，它留了一个 `off` 档 = 完全回到改前行为
 *    （既不排定时器，直调扫描也一个字都不写）。
 *
 * 两条来自 D1 §3.1 实现记录（2026-09-26 现读）的硬约束，写成代码而不是注释：
 *  1. **只能服务端扫，不能让正要离开的那一端报**：客户端自觉上报＝让要离开的人决定状态。
 *     所以这里没有任何"收到离开事件"的入口，判据全部由"现在读到什么"给出。
 *  2. **宽限期必须大于那份 30 秒租约本身**：租约每 10 秒续一次，`expires_at` 走到 30 秒
 *     是**租约边界**，不是"人走了"的证据（关窗到判离开之间本来就有最多 30 秒的窗口期）。
 *     `ROUND_IDLE_PAUSE_GRACE_MS_V1` 因此**由 `CONTEXT_LEASE_SECONDS` 派生**而不是各写一个数：
 *     "比租约长"这件事从此是结构性的，改租约不会悄悄把宽限期变成比租约短。
 */
import { learningRunPhaseSchema } from "@ailearn/shared/learning-run-contracts";
import { CONTEXT_LEASE_SECONDS } from "../companion-bridge/context-hydration.ts";
import type { RoundPhaseV1 } from "./round-reducer.ts";

export type LearningRunPhaseNameV1 = (typeof learningRunPhaseSchema)["_output"];

/**
 * run 的 12 档 phase 各自"已经走完了没有"。**一格都不许漏**：`Record` 让这个总数由
 * 编译期保证（shared 那边新增一档就会在这里缺一格），单测再按
 * `learningRunPhaseSchema.options` 现读的那一份比一次条数，两道都拦着"悄悄多一档"。
 *
 * 分成"走完"与"没走完"两类的依据不是本文件的偏好，是 `learning_runs` 的转移语义：
 *  - `completed`／`ended`／`skipped`／`cancelled`／`stale` 五档是终态——
 *    `getReturnContract` 里那份 `activePhases`（`run-service.ts:3124`）与桌面
 *    `formal-assessment-guard.ts:16` 的 `TERMINAL_PHASES` 都是这五档，两份读数一致；
 *  - 余下七档都还能往前走：其中 `paused` 与 `recoverable_error` 是"停在半路但会回来"，
 *    把它们算成终态就会在人还在做题时把外面那一轮停掉。
 */
export const LEARNING_RUN_PHASE_TERMINALITY_V1: Record<LearningRunPhaseNameV1, boolean> = {
  preparing: false,
  active: false,
  assessing: false,
  checkpoint: false,
  committing: false,
  paused: false,
  recoverable_error: false,
  completed: true,
  ended: true,
  skipped: true,
  cancelled: true,
  stale: true,
};

/** 终态那五档（SQL 侧 `phase NOT IN (...)` 用的就是这一份，不再抄第二遍字面量）。 */
export const LEARNING_RUN_TERMINAL_PHASES_V1: readonly LearningRunPhaseNameV1[] = Object.freeze(
  (Object.keys(LEARNING_RUN_PHASE_TERMINALITY_V1) as LearningRunPhaseNameV1[])
    .filter((phase) => LEARNING_RUN_PHASE_TERMINALITY_V1[phase]),
);

/** 认不出来的 phase 一律按"没走完"处理：宁可少停一轮，不可把还在进行的一轮停掉。 */
export function isLearningRunPhaseTerminalV1(phase: string): boolean {
  const parsed = learningRunPhaseSchema.safeParse(phase);
  return parsed.success ? LEARNING_RUN_PHASE_TERMINALITY_V1[parsed.data] : false;
}

/** 四条判据里哪一条把这一轮挡住了；`null` = 四条全成立。 */
export type RoundIdlePauseBlockerV1 =
  | "phase"
  | "live-page-context"
  | "open-learning-run"
  | "grace-period"
  | "unknown-last-change";

/**
 * 宽限期：租约的**三倍**（30 秒租约 → 90 秒）。三倍的组成写在理由里，不是拍的：
 *  - 1× 租约：`expires_at` 本身走到头不构成"人走了"（见文件头第 2 条）；
 *  - 再留一段给"这一轮刚刚还在被写"这件事追上读侧（计划修订、教学产物都发生在轮次行之外）；
 *  - 再留一段给定时器本身的节奏（扫描间隔默认 60 秒，最坏情况判据在两个 tick 之后才成立）。
 * 判据④问的是"距离轮次最后一次变化"，与②的"有没有 live 租约"是**两条独立的证据**：
 * 只有两条同时成立才停，任何一条单独成立都不算。
 */
export const ROUND_IDLE_PAUSE_GRACE_MS_V1 = CONTEXT_LEASE_SECONDS * 1000 * 3;

/** 一次扫描里一个 (空间,人) 最多处理几轮（按 `updated_at` 老的先处理，与笔记清除同纪律：
 * 没有 ORDER BY 的上限会反复选中同一批处理不完的行，饿死后面的）。 */
export const ROUND_ACTIVITY_SWEEP_MAX_ROUNDS_PER_SCOPE_V1 = 50;

export type RoundIdlePauseEvidenceV1 = {
  /** 判据①：轮次此刻的 phase（只有 `active` 才是"进行中的轮次"）。 */
  readonly phase: RoundPhaseV1 | string;
  /** 判据②：该 (workspace,user) 下未过期且未撤销的 live 页面上下文条数。 */
  readonly livePageContextCount: number;
  /** 判据③：挂在这一轮上、phase 不在终态集合里的 run 条数。 */
  readonly openLearningRunCount: number;
  /** 判据④：轮次最后一次变化（`updated_at`）；读不出来传 null，按"不停"处理。 */
  readonly lastChangedAt: Date | null;
  /** 这一发的"现在"（与判据②比租约用的是同一个时刻，两个判据不许各自读一次时钟）。 */
  readonly now: Date;
  /** 宽限期覆盖位：只给单测钉边界用，运行期一律取 `ROUND_IDLE_PAUSE_GRACE_MS_V1`。 */
  readonly graceMs?: number;
};

export type RoundIdlePauseDecisionV1 = {
  readonly shouldPause: boolean;
  readonly blockedBy: RoundIdlePauseBlockerV1 | null;
  /** 判据④用的那两个数，原样带回，让调用方的日志能说出"还差多久"。 */
  readonly graceMs: number;
  readonly idleMs: number | null;
};

/**
 * 四条判据**在同一发里同时成立**才停（D1 §3.1 的"扫"与 PRD §3.2 的"没有其他活跃端"）。
 *
 * 返回第一个挡住它的那一条（顺序就是四条的编号顺序），因为"没停"必须有主语：
 * 少了 `blockedBy`，读数只能说"这一轮还在跑"，说不了"是哪一条拦的"，
 * 下一轮调宽限期或改租约形状时就没有可归因的证据。
 *
 * 任何一格读不出来（NaN、null、负数）都按"不成立"处理 ⇒ 不停。这一条取向和
 * `gap-help-policy.ts` 里"判不了不是没弄通"同一族：**证据不全时不动用户的东西**。
 */
export function evaluateRoundIdlePauseV1(
  evidence: RoundIdlePauseEvidenceV1,
): RoundIdlePauseDecisionV1 {
  const graceMs = evidence.graceMs ?? ROUND_IDLE_PAUSE_GRACE_MS_V1;
  const decide = (shouldPause: boolean, blockedBy: RoundIdlePauseBlockerV1 | null, idleMs: number | null) =>
    ({ shouldPause, blockedBy, graceMs, idleMs }) as RoundIdlePauseDecisionV1;

  const idleMs = evidence.lastChangedAt instanceof Date && !Number.isNaN(evidence.lastChangedAt.getTime())
    ? evidence.now.getTime() - evidence.lastChangedAt.getTime()
    : null;

  if (evidence.phase !== "active") return decide(false, "phase", idleMs);
  if (!isCountable(evidence.livePageContextCount) || evidence.livePageContextCount > 0) {
    return decide(false, "live-page-context", idleMs);
  }
  if (!isCountable(evidence.openLearningRunCount) || evidence.openLearningRunCount > 0) {
    return decide(false, "open-learning-run", idleMs);
  }
  if (idleMs === null) return decide(false, "unknown-last-change", idleMs);
  // 边界取 `>=`：恰好走到宽限期那一刻算"已过"，判据说的是"超过宽限期"里的最保守那一格，
  // 而单测把 `graceMs - 1` 与 `graceMs` 两格钉成两个相反的结果。
  if (idleMs < graceMs) return decide(false, "grace-period", idleMs);
  return decide(true, null, idleMs);
}

function isCountable(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ─── 总控（一处常量 + 一个环境变量）─────────────────────────────────────

/**
 * 默认扫描间隔 60 秒。为什么是这个数：判据②的证据本身有 30 秒粒度（租约到期才算离开），
 * 判据④还要再等 90 秒，60 秒的 tick 既不会让"离开"这件事被读得比它自己的粒度更细，
 * 也不会让检测延迟成倍叠加。它**不是**"60 秒内没点就算走"——那两件事分别归②与④。
 */
export const DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS = 60_000;

/** 低于这个数的间隔没有意义（比租约续租节奏 10 秒还密），按坏值处理。 */
export const ROUND_ACTIVITY_SWEEP_MIN_INTERVAL_MS = 5_000;

/** 显式关掉这一发时写的那几个值（`off` 档 = 完全回到改前行为：不建定时器，直调也不写库）。 */
export const ROUND_ACTIVITY_SWEEP_OFF_VALUES_V1: readonly string[] = Object.freeze([
  "off", "disabled", "none", "0",
]);

export const ENV_ROUND_ACTIVITY_SWEEP_INTERVAL = "NOTE_ROUND_IDLE_PAUSE_SWEEP_MS";

/**
 * `null` = 关（扫到 `off` 档）；数字 = 每那么久扫一次。
 *
 * 坏值回落**默认**而不是让服务起不来：这一发是收敛用的对账循环，不是任何请求的依赖，
 * 一个写错的 env 造成 API 起不来，比它想防的那一次误停严重得多。要关就明确写 `off`。
 */
export function roundActivitySweepIntervalMsV1(): number | null {
  const raw = process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL]?.trim().toLowerCase();
  if (!raw) return DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS;
  if (ROUND_ACTIVITY_SWEEP_OFF_VALUES_V1.includes(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < ROUND_ACTIVITY_SWEEP_MIN_INTERVAL_MS) {
    return DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS;
  }
  return parsed;
}

/** 关掉这一发时的那句话，两个调用点（server 与扫描本体）共用一份措辞，别说成两样。 */
export function roundActivitySweepDisabledNoteV1(): string {
  return `${ENV_ROUND_ACTIVITY_SWEEP_INTERVAL} 处于 off 档：不建定时器，扫描本身也不写库`;
}
