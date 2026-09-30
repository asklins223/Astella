/**
 * 单元层的**共享替身**（2026-09-29，P2-7）。
 *
 * ## 审计说的"0 个 fixture 模块"不准确
 *
 * 集成层的 fixture 一直有（`integration-tests/helpers/*-fixture.ts` 四份）。
 * 缺的是**单元层**的：单测需要的不是数据夹具，而是"被测函数手上那个
 * `executor: ApiTransaction` 长什么样"。
 *
 * ## 为什么要共享
 *
 * 服务层的写读几乎都走 `executor` 形参（P2-4 量过：`apps/api/src/modules` 里
 * 61 处），于是每个单测都得自己搓一个能 `select/insert/update` 的替身。
 * 搜一遍就有 `makeWhereResult` × 4、`makeTx` × 2、`createMockApp` × 3 …
 *
 * ## ⚠️ 但**不要**把它们当成一样东西合并
 *
 * 三份 `makeWhereResult` 的 `orderBy` 行为**不一样**：
 *
 * ```ts
 * // A（card-service.test.ts）：orderBy 返回**链自身**，于是还能 .limit()
 * orderBy: () => result,
 * // B（review-service / activation-service）：orderBy 直接**返回 rows**
 * orderBy: () => rows,
 * ```
 *
 * 被测代码只要有一处写成 `.orderBy(..).limit(n)`，A 能跑、B 会在 `rows.length`
 * 上炸；反过来若代码读 `.orderBy(..)` 的返回值，B 给的才是对的。
 *
 * 所以这里把两种形状**都留着，并且用名字区分**：
 * `thenableRows()`（B 那种）与 `thenableChain()`（A 那种）。
 * 统一成一个的那一刻，先确认被测代码走的是哪条路。
 */

/** 一个"既是链又是 thenable"的最小结果对象。 */
type Chainable = Record<string, unknown> & {
  then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) => Promise<unknown>;
};

function makeThenable(rows: unknown[]): Chainable {
  const chain: Chainable = {
    // 返回**链自身**：`.orderBy(..).limit(n)` 还能接着调
    orderBy: () => chain,
    // `limit(n)` 必须真的限。
    //
    // 2026-09-29：这里原先写成 `async () => rows`——**忽略参数**。
    // 它不会让任何测试变红，只会悄悄让"限 2 条"的断言通过（因为它给的是全部 3 条，
    // 而断言通常只比前两条）；或者反过来，在真的比长度时给出误导性的结果。
    // 一个**不实现自己名义上的行为**的夹具，比没有夹具更坏。
    limit: async (n?: unknown) => (
      typeof n === "number" && n >= 0 ? rows.slice(0, n) : rows
    ),
    then(onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
  } as Chainable;
  return chain;
}

/**
 * 形状 B：`orderBy` 直接把 rows 交出去。
 *
 * 用于被测代码**不**在 `orderBy` 之后继续链式调用的场合。
 */
export function thenableRows(rows: unknown[]): Chainable {
  const chain = makeThenable(rows);
  // 覆写成"直接给 rows"——这是与 A 的唯一差别，也是三份旧副本分叉的地方
  (chain as Record<string, unknown>).orderBy = () => rows;
  return chain;
}

/**
 * 形状 A：`orderBy` 返回链自身，可在之后继续 `.limit()` / `.where()`。
 *
 * 用于被测代码写成 `.orderBy(..).limit(n)` 的场合。
 */
export function thenableChain(rows: unknown[]): Chainable {
  return makeThenable(rows);
}

export type StubQuery = {
  /** 让 stub 记住"这次被查了哪些条件"，供断言用。 */
  calls: { op: string; args: unknown[] }[];
  /** 让 stub 记下最近一次 select/insert/update 的返回值。 */
  results: Record<string, unknown[]>;
};

/**
 * 一个能接住 `select/from/where/orderBy/limit` 与
 * `insert/values/onConflictDoUpdate/returning`、`update/set/where/returning`
 * 的最小 executor 替身。
 *
 * 它**不校验**调用顺序，也不模拟 RLS——那不是它的职责；
 * 它的职责是"被测函数手上的那个东西有个稳定形状，不至于每份测试重搓一遍"。
 */
export function createExecutorStub(overrides: {
  /** 按操作名给返回值；未列出的返回空数组。 */
  results?: Record<string, unknown[]>;
} = {}) {
  const calls: StubQuery["calls"] = [];
  const results: Record<string, unknown[]> = { ...(overrides.results ?? {}) };

  const terminal = (op: string) => async () => results[op] ?? [];

  const executor: Record<string, unknown> = {
    calls,
    results,
    select: (fields?: unknown) => {
      calls.push({ op: "select", args: [fields] });
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => thenableChain(results.select ?? []),
        limit: (n: number) => thenableChain((results.select ?? []).slice(0, n)),
        orderBy: () => chain,
        returning: terminal("select"),
        then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
          Promise.resolve(results.select ?? []).then(onF, onR),
      };
      return chain;
    },
    insert: (table?: unknown) => {
      calls.push({ op: "insert", args: [table] });
      const chain: Record<string, unknown> = {
        values: (v: unknown) => {
          calls.push({ op: "values", args: [v] });
          return chain;
        },
        onConflictDoUpdate: (spec: unknown) => {
          calls.push({ op: "onConflictDoUpdate", args: [spec] });
          return chain;
        },
        returning: terminal("insert"),
        then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
          Promise.resolve(results.insert ?? []).then(onF, onR),
      };
      return chain;
    },
    update: (table?: unknown) => {
      calls.push({ op: "update", args: [table] });
      const chain: Record<string, unknown> = {
        set: (v: unknown) => {
          calls.push({ op: "set", args: [v] });
          return chain;
        },
        where: () => chain,
        returning: terminal("update"),
        then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
          Promise.resolve(results.update ?? []).then(onF, onR),
      };
      return chain;
    },
    execute: terminal("execute"),
    delete: (table?: unknown) => {
      calls.push({ op: "delete", args: [table] });
      const chain: Record<string, unknown> = {
        where: () => chain,
        returning: terminal("delete"),
        then: (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
          Promise.resolve(results.delete ?? []).then(onF, onR),
      };
      return chain;
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(executor),
  };

  return executor;
}
