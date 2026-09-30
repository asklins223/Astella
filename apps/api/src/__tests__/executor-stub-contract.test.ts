import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutorStub,
  thenableChain,
  thenableRows,
} from "../test-support/executor-stub.ts";

/** 测试里从替身上取出方法用的最小签名。 */
type Fn = (...args: unknown[]) => unknown;

/**
 * P2-7：单元层共享替身的**契约**。
 *
 * ## 这条夹具存在的理由
 *
 * 服务层的写读几乎都走 `executor: ApiTransaction` 形参，所以每个单测都得搓一个
 * 能 `select/insert/update` 的替身。搜一遍就有 `makeWhereResult` × 4、
 * `makeTx` × 2、`createMockApp` × 3 …——每份都自己实现一遍。
 *
 * ## 但三份旧副本**不是一样东西**
 *
 * `orderBy` 的行为分叉：形状 A 返回**链自身**（之后还能 `.limit()`），
 * 形状 B 直接**返回 rows**。被测代码只要有一处写成 `.orderBy(..).limit(n)`，
 * 形状 B 就会在 `rows.length` 上炸。
 *
 * 所以这一条钉的是：**两种形状都存在，且它们的行为**确实不同**——
 * 哪天有人"顺手统一"成一份，这里会红。
 */

test("形状 A：orderBy 之后还能继续链式调用", async () => {
  const chain = thenableChain([{ id: 1 }, { id: 2 }]);
  const afterOrder = ((chain as Record<string, unknown>).orderBy as Fn)();
  assert.equal(typeof afterOrder, "object", "形状 A 的 orderBy 返回链自身");
  const limited = ((afterOrder as Record<string, unknown>).limit as Fn)();
  assert.deepEqual(await limited, [{ id: 1 }, { id: 2 }]);
});

test("形状 B：orderBy 直接把 rows 交出去", async () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const chain = thenableRows(rows);
  const afterOrder = ((chain as Record<string, unknown>).orderBy as Fn)();
  assert.deepEqual(afterOrder, rows,
    "形状 B 的 orderBy 返回 rows 本身——这正是与 A 分叉的地方");
  // 直接 await 整条链仍然拿到 rows
  assert.deepEqual(await chain, rows);
});

test("两种形状都能被 await 成 rows", async () => {
  const rows = [{ a: 1 }];
  assert.deepEqual(await thenableChain(rows), rows);
  assert.deepEqual(await thenableRows(rows), rows);
});

test("executor 替身：select / insert / update 都接得住常用链", async () => {
  const stub = createExecutorStub({
    results: {
      select: [{ id: "a" }, { id: "b" }, { id: "c" }],
      insert: [{ id: "new" }],
      update: [{ id: "u" }],
    },
  });
  const call = (m: string) => (stub[m] as unknown as Fn)() as Record<string, Fn>;

  // select: .where() 之后 .limit(n) 要真的限
  const afterWhere = (call("select").where as Fn)() as Record<string, Fn>;
  assert.deepEqual(await ((afterWhere.limit as Fn)(2) as Promise<unknown[]>),
    [{ id: "a" }, { id: "b" }], "limit 要真的限");

  // insert: .values().onConflictDoUpdate().returning()
  const afterValues = (call("insert").values as Fn)({ x: 1 }) as Record<string, Fn>;
  const afterConflict = (afterValues.onConflictDoUpdate as Fn)({ target: [] }) as Record<string, Fn>;
  assert.deepEqual(await (afterConflict.returning as Fn)(), [{ id: "new" }]);

  // update: .set().returning()
  const afterSet = (call("update").set as Fn)({ y: 2 }) as Record<string, Fn>;
  assert.deepEqual(await (afterSet.returning as Fn)(), [{ id: "u" }]);

  // 替身记住了每次调用，断言才有抓手
  const ops = (stub.calls as { op: string }[]).map((c) => c.op);
  assert.deepEqual(ops, ["select", "insert", "values", "onConflictDoUpdate", "update", "set"],
    "调用序列要能被断言——否则这个替身只是让人少写几行，不提供任何保证");
});


test("executor.transaction 直通（带上下文的事务在单测里不该中断）", async () => {
  const stub = createExecutorStub({ results: { select: [{ ok: 1 }] } });
  const value = await (stub.transaction as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(
    async (tx) => {
      assert.equal(tx, stub, "事务回调拿到的应当就是同一个替身");
      return "done";
    },
  );
  assert.equal(value, "done");
});

test("【自证】『两种形状不同』这条是真的：把 B 改成 A 会改变可链性", () => {
  const rows = [{ id: 1 }];
  const b = thenableRows(rows) as Record<string, unknown>;
  // 形状 B 的 orderBy 结果上没有 limit —— 而真实服务代码会这么写
  assert.equal(typeof ((b.orderBy as Fn)() as Record<string, unknown>).limit, "undefined",
    "自证样本没造好：形状 B 的 orderBy 结果上不该有 limit");
  const a = thenableChain(rows) as Record<string, unknown>;
  assert.equal(typeof ((a.orderBy as Fn)() as Record<string, unknown>).limit, "function",
    "自证样本没造好：形状 A 的 orderBy 结果上应当有 limit");
});
