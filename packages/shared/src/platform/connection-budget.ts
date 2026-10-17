/**
 * 多副本部署前的**连接预算**核算（P3-11）。
 *
 * ## 为什么需要它
 *
 * 每个进程各自持有一个 postgres 连接池，**每个副本一份**。而 Postgres 的
 * `max_connections` 是**整个实例**共享的一个数。于是：
 *
 * ```
 * API 副本数 × 25  +  worker 副本数 × poolMax  <  max_connections
 * ```
 *
 * 这条不等式没有任何地方检查过。超了之后的表现不是报错，而是**连接被拒**——
 * `too many clients already`，业务侧看起来像"偶发 500"。
 *
 * ## 两个池的当前形状（2026-09-29 实读）
 *
 * · `apps/api/src/db/client.ts` — `max: 25`（**硬编码**，注释说是为了摊薄
 *   SSE 轮询的峰值排队）
 * · `workers/ai-worker/src/db.ts` — `max = max(15, min(64, QUEUE_CONCURRENCY × 4))`，
 *   默认并发 3 → 15
 *
 * 也就是说单实例双副本的最小情形是 `2×25 + 2×15 = 80`，
 * 而 Postgres 的默认 `max_connections` 是 **100**。worker 并发拉满（64）时
 * `2×25 + 2×64 = 178` —— 早就超了。
 *
 * ## 这个模块为什么放在 shared
 *
 * 因为预算的**两端**（api 与 worker）都要引用同一份数字，而它们不在同一个包里。
 * 放在任何一边，另一边就得跨包 import 那边的 `db.ts`——那会拖进整条连接初始化链。
 *
 * 它是**纯函数**：不读 `process.env`、不连库。要判断当前部署，
 * 由调用方把参数喂进来。
 */

/** api 单副本的池大小（与 `apps/api/src/db/client.ts` 的 `max: 25` 对齐）。 */
export const API_POOL_MAX = 25;

/** worker 单副本的池下限（`max(15, …)` 的那个 15）。 */
export const WORKER_POOL_MIN = 15;

/** worker 单副本的池上限（`min(64, …)` 的那个 64）。 */
export const WORKER_POOL_MAX = 64;

/**
 * Postgres 的默认 `max_connections`。
 *
 * 不是"我们想要的数"，是"没配时实际会是多少"——后者才是核算的基线。
 * 真要调大，应当在 compose 的 postgres `command` 里显式写，而不是改这里。
 */
export const POSTGRES_DEFAULT_MAX_CONNECTIONS = 100;

/**
 * worker 池大小：与 `workers/ai-worker/src/db.ts` 的算法**逐字同构**。
 *
 * 同构而不是共用，是因为那行在 worker 的 `db.ts` 里，而 `db.ts` 不能被 shared
 * import（shared 若依赖它，桌面端会把连接初始化链拖进打包图）。两份算法各写一遍
 * 的代价，就是下面那条守它们的守卫。
 */
export function workerPoolMax(concurrency: number): number {
  return Math.max(WORKER_POOL_MIN, Math.min(WORKER_POOL_MAX, concurrency * 4));
}

export type ConnectionBudgetInput = {
  /** api 副本数 */
  apiReplicas: number;
  /** worker 副本数 */
  workerReplicas: number;
  /** `QUEUE_CONCURRENCY`（worker 的实际并发配置） */
  workerConcurrency: number;
  /** 实际生效的 `max_connections`；不填就按 Postgres 默认 */
  maxConnections?: number;
};

export type ConnectionBudget = {
  apiTotal: number;
  workerTotal: number;
  total: number;
  maxConnections: number;
  /** 还能再撑几份当前配置的副本（取 api / worker 里更紧的那一侧） */
  headroomApiReplicas: number;
  headroomWorkerReplicas: number;
  ok: boolean;
};

/** 算一遍预算。不做任何 IO。 */
export function connectionBudget(input: ConnectionBudgetInput): ConnectionBudget {
  const maxConnections = input.maxConnections ?? POSTGRES_DEFAULT_MAX_CONNECTIONS;
  const perWorker = workerPoolMax(input.workerConcurrency);
  const apiTotal = input.apiReplicas * API_POOL_MAX;
  const workerTotal = input.workerReplicas * perWorker;

  // 预留 1 个给迁移、监控之类的系统连接——它们同样吃这个上限。
  const ceiling = Math.max(1, maxConnections - 1);
  const total = apiTotal + workerTotal;

  const headroomApiReplicas =
    API_POOL_MAX + perWorker <= 0 ? Infinity : Math.max(0, Math.floor((ceiling - total) / API_POOL_MAX));
  const headroomWorkerReplicas =
    perWorker <= 0 ? Infinity : Math.max(0, Math.floor((ceiling - total) / perWorker));

  return {
    apiTotal,
    workerTotal,
    total,
    maxConnections,
    headroomApiReplicas,
    headroomWorkerReplicas,
    ok: total <= ceiling,
  };
}

/** 预算超了时的一句话说明，给启动日志与 CI 用。 */
export function describeConnectionBudget(budget: ConnectionBudget): string {
  const verdict = budget.ok
    ? `还有余量（api 侧还能再加 ${budget.headroomApiReplicas} 副本、worker 侧 ${budget.headroomWorkerReplicas} 副本）`
    : `**超了**：超出 ${budget.total - Math.max(1, budget.maxConnections - 1)} 条连接。`
      + "后果不是报错而是连接被拒（`too many clients already`），业务侧看起来像偶发 500。";
  return `连接预算：api ${budget.apiTotal} + worker ${budget.workerTotal} = ${budget.total}，`
    + `上限 ${budget.maxConnections}（另留 1 条给系统连接）。${verdict}`;
}
