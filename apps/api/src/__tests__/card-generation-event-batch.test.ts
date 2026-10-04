import assert from "node:assert/strict";
import test from "node:test";

/**
 * P1-1：`insertEventBatch` 必须与逐条 `insertEvent` 产生**逐字相同**的结果。
 *
 * 这里用两个假执行器跑同一批事件，逐字段比对写出去的行——
 * 重点是 event_seq 的连续性、顺序、以及入参 payload 的原样透传。
 * 只比"条数对"是不够的：seq 错位或顺序颠倒时消费侧读出来的事件流是乱的，
 * 而那不会让任何一条既有断言变红。
 *
 * 2026-10-04：这两个函数已下沉到制卡领域包 `@ailearn/card-generation`
 * （`packages/card-generation/src/events.ts`）。下面这些用例仍经 API 的
 * `helpers.ts` 调用——它转出的是**同一个函数对象**，而最后一条用例把这一点
 * 钉住：`insertEvent` 一旦在 helpers.ts 里被重新声明成第二份实现，事件序
 * 就会有两个答案，而上面所有断言照样全绿。
 */

type Row = { eventSeq: number; eventType: string; payload: unknown; workspaceId: string; runId: string };

/**
 * 假执行器要**跟着写入推进 maxSeq**——真实库里 MAX(event_seq) 会看到本事务
 * 前面刚写的行。第一版让它恒定返回初值，于是"逐条"那条参照路径每次都算出同一个
 * seq（41, 41, 41...），测的是一个真库上不会发生的场景。假桩比被测代码更容易骗人。
 */
function makeTx(initialMaxSeq: number) {
  const inserted: Row[] = [];
  let current = initialMaxSeq;
  let selectCount = 0;
  return {
    inserted,
    selectCount: () => selectCount,
    tx: {
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            return Promise.resolve([{ maxSeq: current }]);
          },
        }),
      }),
      insert: () => ({
        values: (rows: Row[] | Row) => {
          const list = Array.isArray(rows) ? rows : [rows];
          for (const r of list) {
            inserted.push(r);
            current = Math.max(current, r.eventSeq);
          }
          return Promise.resolve();
        },
      }),
    } as never,
  };
}

const EVENTS = [
  { eventType: "learning_objective.activated", payload: { objectiveId: "o1" } },
  { eventType: "learning_card.activated", payload: { cardId: "c1" } },
  { eventType: "learning_objective.activated", payload: { objectiveId: "o2" } },
  { eventType: "learning_card.activated", payload: { cardId: "c2" } },
];

test("批量写入产生的行与逐条写入逐字相同（seq 连续、顺序一致）", async () => {
  const { insertEventBatch, insertEvent } = await import("../modules/card-generation-v2/helpers.ts");

  // 参照：逐条。同一批里第一条读到 maxSeq 之后写进去，seq 递增。
  const one = makeTx(40);
  for (const e of EVENTS) {
    await insertEvent(one.tx, "ws-1", "run-1", e.eventType, e.payload);
  }

  // 实际：整批一次
  const batch = makeTx(40);
  await insertEventBatch(batch.tx, "ws-1", "run-1", EVENTS);

  assert.deepEqual(batch.inserted, one.inserted);
});

test("批量把 MAX 查询从 N 次降到 1 次", async () => {
  const { insertEventBatch, insertEvent } = await import("../modules/card-generation-v2/helpers.ts");
  const one = makeTx(0);
  for (const e of EVENTS) await insertEvent(one.tx, "ws-1", "run-1", e.eventType, e.payload);
  const batch = makeTx(0);
  await insertEventBatch(batch.tx, "ws-1", "run-1", EVENTS);

  assert.equal(one.selectCount(), EVENTS.length);
  assert.equal(batch.selectCount(), 1);
});

test("空批次不查库也不写库（values([]) 是 drizzle 的未定义行为）", async () => {
  const { insertEventBatch } = await import("../modules/card-generation-v2/helpers.ts");
  const t = makeTx(7);
  await insertEventBatch(t.tx, "ws-1", "run-1", []);
  assert.equal(t.selectCount(), 0);
  assert.deepEqual(t.inserted, []);
});

test("seq 从既有最大值接着往上排，不会撞已有行", async () => {
  const { insertEventBatch } = await import("../modules/card-generation-v2/helpers.ts");
  const t = makeTx(100);
  await insertEventBatch(t.tx, "ws-1", "run-1", EVENTS);
  assert.deepEqual(t.inserted.map((r) => r.eventSeq), [101, 102, 103, 104]);
});

test("没给 payload 的条目落成空对象，不落成 undefined", async () => {
  const { insertEventBatch } = await import("../modules/card-generation-v2/helpers.ts");
  const t = makeTx(0);
  await insertEventBatch(t.tx, "ws-1", "run-1", [{ eventType: "x" }]);
  assert.deepEqual(t.inserted[0]!.payload, {});
});

test("insertEvent 自己就走批量路径（单条 = 一批）", async () => {
  const { insertEvent, insertEventBatch } = await import("../modules/card-generation-v2/helpers.ts");
  const a = makeTx(3);
  await insertEvent(a.tx, "ws", "run", "t", { k: 1 });
  const b = makeTx(3);
  await insertEventBatch(b.tx, "ws", "run", [{ eventType: "t", payload: { k: 1 } }]);
  assert.deepEqual(a.inserted, b.inserted);
});

test("API helpers 转出的就是领域包里那一个函数对象（没有第二份写入实现）", async () => {
  const helpers = await import("../modules/card-generation-v2/helpers.ts");
  const domain = await import("@ailearn/card-generation");
  // 逐个比**引用**而不是比行为：行为相等不能排除"有人复制了一份改了个名字"，
  // 而两份写入实现的后果是 event_seq 由两个基线各自算——同一批事件读出来
  // 会重号，屏上看不出异常、但事件流已经乱了。
  assert.equal(helpers.insertEvent, domain.insertEvent);
  assert.equal(helpers.insertEventBatch, domain.insertEventBatch);
  assert.equal(helpers.CardGenerationV2ServiceError, domain.CardGenerationV2ServiceError);
});
