/**
 * 候选交付的结账（doc 34 L42）。
 *
 * 现场是这条：用户在伴星中心看到「有一条记忆候选等待查看」，去记忆页确认或忽略；
 * 那两个动作过去**一个字节都不碰 `assistant_deliveries`**，于是那张卡片永远停在
 * "待处理"并继续给两个按钮，而 `acted`/`dismissed` 这两个终态在整库里 0 行。
 *
 * 这里不连数据库：断言的是"确认/忽略/删除这三条路各把交付写成了什么"。
 * jsonb 反查那一句（`payload_ref ->> 'memoryItemId'`）在真库上的行为由
 * `companion-memory-routes-http-postgres.integration.ts` 里新增的那段验（要真角色跑）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiTransaction } from "../../../../db/client.ts";
import { clearMemories, confirmMemory, deleteMemory, dismissMemory, type MemoryScope } from "../memory-service.ts";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const scope: MemoryScope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
};

function memoryRow() {
  return {
    id: MEMORY_ID,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    kind: "preference",
    content: "习惯晚上学习",
    sourceEventId: null,
    sourceSessionId: null,
    sourceSpeaker: null,
    sourceBasis: null,
    appliesWhen: null,
    validFrom: null,
    validUntil: null,
    userStated: false,
    userConfirmed: false,
    candidate: true,
    importance: 0.6,
    confidence: 0.7,
    scope: "workspace",
    pinned: false,
    archivedAt: null,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "none",
    sourceType: "model_inferred",
    globalKey: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:00:00.000Z"),
  };
}

/**
 * 链式替身：`update().set()` 记下载荷，`returning()` 按载荷类型决定还给不给行——
 * 写记忆的必须还回那一行（调用方拿它判存在），写交付的还空数组。
 */
function fakeExecutor(
  selectQueues: Array<Array<Record<string, unknown>>>,
  returnQueue: Array<Array<Record<string, unknown>>> = [],
) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  /** 随事务发的 NOTIFY 就计在这里：结完账必须唤醒别的设备，没结账就不许发。 */
  const executes: string[] = [];
  const operations: string[] = [];
  let selectIndex = 0;
  let returnIndex = 0;
  const chain = (pendingSet?: Record<string, unknown>, write = false): any => ({
    from: () => chain(pendingSet, write),
    where: () => chain(pendingSet, write),
    limit: () => chain(pendingSet, write),
    orderBy: () => chain(pendingSet, write),
    for: () => chain(pendingSet, write),
    set: (value: Record<string, unknown>) => {
      updates.push(value);
      operations.push("update");
      return chain(value, true);
    },
    values: (value: Record<string, unknown>) => {
      inserts.push(value);
      operations.push("insert");
      return chain(pendingSet, true);
    },
    onConflictDoNothing: () => chain(pendingSet, true),
    returning: () => Promise.resolve(returnQueue[returnIndex++] ?? (isDeliveryWrite(pendingSet) ? [] : [memoryRow()])),
    get: () => chain(pendingSet),
    // 写语句被 await 时不占读队列的槽：`update().set().where()` 也是 thenable，
    // 替它消费一次就会把后面的回读错位（第一次跑就是这样，报的是 `updated[0]` undefined）。
    then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
      (!write
        ? Promise.resolve(selectQueues[selectIndex++] ?? [])
        : Promise.resolve([])
      ).then(onOk, onErr),
  });
  // 入口一律从"未 set"起：读语句靠 `then` 领队列，写语句靠 `set()` 之后才算写。
  // （入口若被当成写，读会一律回空数组，"记忆不存在"那条就变成白过的。）
  const root = Object.assign(chain(), {
    select: () => chain(),
    update: () => chain(),
    insert: () => chain(),
    delete: () => chain(),
    execute: () => {
      executes.push("execute");
      operations.push("execute");
      return Promise.resolve([]);
    },
  });
  return { executor: root as unknown as ApiTransaction, updates, inserts, executes, operations };
}

function isDeliveryWrite(set: Record<string, unknown> | undefined): boolean {
  return typeof set?.state === "string" && "displayLease" in set;
}

function deliveryWrites(updates: Array<Record<string, unknown>>) {
  return updates.filter(isDeliveryWrite);
}

describe("记忆动作要把对应的候选交付结账", () => {
  it("确认记忆 → 交付写成 acted 并清掉展示租约", async () => {
    const { executor, updates, executes } = fakeExecutor(
      [[memoryRow()], [memoryRow()]],
      [[{ id: "delivery-1" }]],
    );
    await confirmMemory(executor, scope, MEMORY_ID);
    const closed = deliveryWrites(updates);
    assert.equal(closed.length, 1, "确认之后必须有一次交付结账");
    assert.equal(closed[0]?.state, "acted");
    assert.equal(closed[0]?.displayLease, null, "终态不留展示租约（与 ackDelivery 同一形状）");
    // 结完账要随同一事务 NOTIFY，否则别的设备上的那张卡片还挂着"待处理"的两个按钮。
    assert.equal(executes.length, 1, "结账之后必须发一次 inbox NOTIFY");
  });

  it("忽略记忆 → 交付写成 dismissed", async () => {
    const { executor, updates } = fakeExecutor([], [[memoryRow()], [{ id: "delivery-1" }]]);
    await dismissMemory(executor, scope, MEMORY_ID);
    const closed = deliveryWrites(updates);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.state, "dismissed");
  });

  it("删除记忆（纠正路径经由它）→ 交付不能继续排着", async () => {
    const { executor, updates } = fakeExecutor([], [[
      { id: MEMORY_ID, kind: "preference", sourceEventId: null },
    ], [{ id: "delivery-1" }]]);
    await deleteMemory(executor, scope, MEMORY_ID);
    const closed = deliveryWrites(updates);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.state, "dismissed");
  });

  it("删除带来源的记忆 → 同事务写入来源抑制墓碑", async () => {
    const sourceEventId = "00000000-0000-4000-8000-000000000011";
    const { executor, inserts } = fakeExecutor([], [[
      { id: MEMORY_ID, kind: "goal", sourceEventId },
    ], [{ id: "delivery-1" }]]);
    await deleteMemory(executor, scope, MEMORY_ID);
    assert.deepEqual(inserts, [{ userId: scope.userId, kind: "goal", sourceEventId }]);
  });

  it("一键清空在软删除前记录来源抑制，并与自动抽取共用用户锁", async () => {
    const { executor, executes, operations } = fakeExecutor([], [[{ id: MEMORY_ID }]]);
    assert.equal(await clearMemories(executor, scope), 1);
    // 四条前置都在软删除之前：取用户级写锁 → 换账号世代（迟到的反思读不回旧材料）
    // → 写来源抑制墓碑 → 停用这个账号下的自己的记事。少一条，清空就不完整。
    assert.equal(executes.length, 4, "写锁、换世代、抑制墓碑、停用记事，四条都得先发出去");
    assert.deepEqual(operations, ["execute", "execute", "execute", "execute", "update"],
      "抑制与记事停用必须先于软删除");
  });

  it("记忆不在这个空间/本人时不结账：也不能顺带唤醒别的设备", async () => {
    const { executor, updates, executes } = fakeExecutor([[]]);
    assert.equal(await confirmMemory(executor, scope, MEMORY_ID), null);
    assert.deepEqual(deliveryWrites(updates), [], "确认失败却结账，是在替用户答一条他没看的候选");
    assert.deepEqual(executes, [], "没结任何账就不许发 NOTIFY");
  });
});
