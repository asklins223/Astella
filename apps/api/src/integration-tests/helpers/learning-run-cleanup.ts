/**
 * 按 **run id** 拆掉一场学习 run：删的顺序，加一遍"删完还剩什么"的现扫。
 *
 * 为什么要单独有一份（2026-09-27）：真窗口剧本走到「练一道」之前就停了，理由写在
 * `apps/desktop-client/scripts/probe-note-round-practice-entry.mts` 头部——
 * "全仓没有任何按 run id 清 run 的现成顺序，集成测试那一套是 workspace 级清扫，会连 owner 的工作区一起删"。
 * 于是所有"点开一场真 run、读屏、再走开"的判据都卡在**清理**上，而不是卡在驱动上。
 *
 * 顺序不是猜的，两条都拿 dev 库实测过：
 * ① 14 张表有 FK 指向 `learning_runs`：13 张 `ON DELETE CASCADE`，只有 `learning_target_snapshots_v2`
 *    是 **RESTRICT** ⇒ 它必须自己先删，否则那发 run 删除直接抛；
 * ② 另有表带 `run_id` 列却**没有 FK**，级联不会碰它们：今天按"哪些表里真躺着 learning run 的 id"数过，
 *    是 `learning_metric_events`（309 行）与 `understanding_change_sets`（61 行）。
 *    `learning_exposures_v2` 更绕：它连 `run_id` 列都没有，那一笔靠 `idempotency_key = 'run-reveal:<runId>'`
 *    认出来，而且挂着只追加守卫 `lex_v2_no_delete`（与 rounds 那族同一把共用函数）。
 *
 * **为什么 exposure 要跟着删**：曝光是"她看过答案"那本账。删了 run 却留下那一笔，
 * 同一目标上就多出一笔记不出来源的"已曝光"，而那场 run 已经不存在——留着比删掉更坏。
 * 删它需要在那一个事务里开维护闸门 `app.allow_history_mutation`（生产路径一处都不设，
 * 只有夹具与剧本用它，09-26 量过）。闸门只开在这一步，不顺手给整个清扫事务开上。
 *
 * 两份分工是这一存在的全部意义：**要删什么是手写的**（顺序得人负责），
 * **还剩什么是现读的**（从 `information_schema` 把所有 `*_run_id` 列找出来逐个数）。
 * 新出现一张挂着 run id、而这份清单没管的表 ⇒ 现扫会点名它，用例会红，不会静默。
 *
 * 这一份刻意**不 import 任何东西**：api 的集测与桌面的真窗口剧本都要用它，
 * 而剧本那边是 `node --experimental-strip-types` 直接跑、不经过打包与别名。
 * 所以这里只交声明式的数据，SQL 由调用方按自己那侧的执行器拼（集测用 drizzle 的 `tx\`…\``，
 * 剧本用 psql 字符串——那条路上 `renderPsqlStatementV1` 会先把 run id 按 uuid 形状卡死再拼）。
 */

/** 一场 run 的 id 必须长成这样才被允许拼进 psql 那一侧的语句。 */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertLearningRunIdV1(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`run id 不是 uuid 形状，拒绝拼进语句：${JSON.stringify(runId.slice(0, 24))}`);
  }
  return runId;
}

export type LearningRunCleanupStep = {
  /** 人类可读的那一格（用例与剧本都按它点名）。 */
  slot: string;
  table: string;
  /** 按列等值删（`column = runId`）；与 `exposureKeyPrefix` 二选一。 */
  column: string | null;
  /** exposure 那一格的认法：`idempotency_key = '<prefix><runId>'`。 */
  exposureKeyPrefix: string | null;
  /** 这一发要穿哪道维护闸门；null 表示不需要。 */
  maintenanceHatch: "allow_history_mutation" | null;
};

/** 删除顺序：先清无 FK 的孤儿账，再清 RESTRICT 那一格，最后删 run（其余 13 张跟着级联走）。 */
export function learningRunCleanupStepsV1(): LearningRunCleanupStep[] {
  return [
    {
      slot: "learning_exposures_v2（按 idempotency_key 认，要维护闸门）",
      table: "learning_exposures_v2",
      column: null,
      exposureKeyPrefix: "run-reveal:",
      maintenanceHatch: "allow_history_mutation",
    },
    {
      slot: "learning_metric_events（带 run_id 无 FK ⇒ 级联不会碰）",
      table: "learning_metric_events",
      column: "run_id",
      exposureKeyPrefix: null,
      maintenanceHatch: null,
    },
    {
      slot: "understanding_change_sets（同上）",
      table: "understanding_change_sets",
      column: "run_id",
      exposureKeyPrefix: null,
      maintenanceHatch: null,
    },
    {
      slot: "learning_target_snapshots_v2（FK 是 RESTRICT，必须先于 run）",
      table: "learning_target_snapshots_v2",
      column: "run_id",
      exposureKeyPrefix: null,
      maintenanceHatch: null,
    },
    {
      slot: "learning_runs（其余 13 张 CASCADE 跟着走）",
      table: "learning_runs",
      column: "id",
      exposureKeyPrefix: null,
      maintenanceHatch: null,
    },
  ];
}

/**
 * 现读"哪些列在挂 run id"：认的是列名形状（`run_id` 与 `<前缀>_run_id`），不是手抄的表名单。
 * 这一条不带参数，两侧都能直接发。
 */
export const learningRunIdColumnsQueryV1 = `
  select c.table_name as table_name, c.column_name as column_name
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.column_name ~ '(^|[a-z_]+_)run_id$'
  order by c.table_name, c.column_name`;

export type RunResidueSlot = {
  slot: string;
  table: string;
  /** 按列等值数（与 `keyPrefix` 二选一）。 */
  column: string | null;
  /** 那一格没有 run_id 列：这笔账是靠幂等键挂着的。 */
  keyPrefix: string | null;
};

/** 挂着 run id、却没有列可从 `information_schema` 认出来的那几格（只能写在这一份里）。 */
const RUN_ID_KEY_SLOTS: Array<{ table: string; keyPrefix: string }> = [
  { table: "learning_exposures_v2", keyPrefix: "run-reveal:" },
];

/** 由现读到的列名单拼出"每一格还剩几行"的那一遍扫描（每格一个 `{slot, remaining}` 结果行）。 */
export function learningRunResidueSlotsV1(
  columns: Array<{ tableName: string; columnName: string }>,
): RunResidueSlot[] {
  if (columns.length === 0) {
    throw new Error("残差扫描拿到零列 ⇒ 发现查询本身读空了，这一遍扫什么都不能证明");
  }
  const fromColumns: RunResidueSlot[] = columns.map(({ tableName, columnName }) => ({
    slot: `${tableName}.${columnName}`,
    table: tableName,
    column: columnName,
    keyPrefix: null,
  }));
  // 幂等键那一族是**追加进去的**，不是调用方可选的参数——扫描漏掉曝光那一格，
  // 正是这一份清单最容易再犯一次的形状（集测那一头因此被迫看见它）。
  const fromKeys: RunResidueSlot[] = RUN_ID_KEY_SLOTS.map(({ table, keyPrefix }) => ({
    slot: `${table}（幂等键 ${keyPrefix}<runId>）`,
    table,
    column: null,
    keyPrefix,
  }));
  return [...fromColumns, ...fromKeys];
}

/** psql 那一侧用的删除语句（集测不走这里）：run id 先按 uuid 卡死再拼，函数里没有第二条路。 */
export function renderPsqlStatementV1(step: LearningRunCleanupStep, runId: string): string {
  const id = assertLearningRunIdV1(runId);
  const where = step.exposureKeyPrefix === null
    ? `"${step.column}" = '${id}'`
    : `"idempotency_key" = '${step.exposureKeyPrefix}${id}'`;
  return `delete from public."${step.table}" where ${where}`;
}

/** psql 那一侧用的残差扫描（同样只走 uuid 卡死那一条路）。 */
export function renderPsqlResidueQueryV1(slots: RunResidueSlot[], runId: string): string {
  const id = assertLearningRunIdV1(runId);
  return slots
    .map(({ slot, table, column, keyPrefix }) => {
      const where = keyPrefix === null
        ? `"${column}" = '${id}'`
        : `"idempotency_key" = '${keyPrefix}${id}'`;
      return `select '${slot}' as slot, count(*)::text as remaining from public."${table}" where ${where}`;
    })
    .join(" union all ");
}

/** 只留下"还有行"的那几格。 */
export function nonzeroResidueV1(rows: Array<{ slot: string; remaining: string | number }>): string[] {
  return rows
    .filter((row) => Number(row.remaining) > 0)
    .map((row) => `${row.slot}=${row.remaining}`);
}
