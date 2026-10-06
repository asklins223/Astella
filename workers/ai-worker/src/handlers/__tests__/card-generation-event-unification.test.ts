/**
 * run 事件写入在 worker 侧的**唯一实现**回归（2026-10-04，J）。
 *
 * 背景：`card-generation-v2/run-io.ts` 此前自己维护了一份 MAX+INSERT，与 API 的
 * `helpers.insertEvent` 和制卡领域包的 `insertEventBatch` 逐字同形。同形的写入有三份
 * 就意味着改一边漏一边：列闭包、seq 分配、默认值语义会各自漂移，漂移时真库只会在
 * 唯一索引上以 23505 报出来——单测里一个都不红。所以收拢成一份，并用下面的用例把
 * 收拢后仍然必须成立的行为钉住。
 *
 * 这里钉三件事：
 *  1. **跨宿主引用相等**：`run-io.ts` 转出的 `insertEvent` 与 `@astella/card-generation`
 *     的是**同一个函数对象**。比的是引用，不是行为——行为相等不能排除"有人复制了
 *     一份改了个名字"。也不用"源码里含 import"代替：那种断言在有人把 import 换回
 *     私有实现时照样绿。
 *  2. **批量语义没在收拢中丢**：空批次不查不写、seq 从既有最大值接着排、按入参顺序
 *     递增、payload 原样透传。
 *  3. **只给真写进去的行发事件**：`skipExisting` 下没插进去的候选不留 `authored` 事件。
 *
 * 假执行器要**跟着写入推进 maxSeq**——真库里 MAX(event_seq) 会看到本事务前面刚写的行。
 * 恒返回初值的假桩测的是一个真库上不会发生的场景：假桩比被测代码更容易骗人。
 *
 * 不碰数据库；真实库上的 23505 与行锁围栏由主会话串行验收。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emitSourceContentCapEvent,
  insertAuthoredCandidatesBatched,
  insertEvent,
} from "../../card-generation-v2/run-io.ts";
import type { LearningCardCandidateRevisionV2 } from "@astella/shared/card-generation-v2-contracts";

type EventRow = {
  workspaceId: string;
  runId: string;
  eventSeq: number;
  eventType: string;
  payload: unknown;
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

/**
 * 事件侧只实现公共窄端口真正用到的那两个方法（select / insert），候选行落库仍走
 * worker 自己的 `execute`——所以这个假桩比"什么都返回 undefined"的万能桩更容易
 * 发现"某个调用点偷偷换了执行面"。
 */
function makeTx(options: { initialMaxSeq?: number; insertedCandidateIds?: string[] } = {}) {
  const events: EventRow[] = [];
  let current = options.initialMaxSeq ?? 0;
  let selectCount = 0;
  let executeCount = 0;
  const tx = {
    execute: () => {
      executeCount += 1;
      return Promise.resolve(
        (options.insertedCandidateIds ?? []).map((id) => ({ candidate_revision_id: id })),
      );
    },
    select: () => ({
      from: () => ({
        where: () => {
          selectCount += 1;
          return Promise.resolve([{ maxSeq: current }]);
        },
      }),
    }),
    insert: () => ({
      values: (rows: EventRow[] | EventRow) => {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          events.push(row);
          current = Math.max(current, row.eventSeq);
        }
        return Promise.resolve();
      },
    }),
  };
  return {
    events,
    tx: tx as never,
    selectCount: () => selectCount,
    executeCount: () => executeCount,
  };
}

/** 夹具只需要身份三列——这一格要断言的是事件那一侧的列，候选列闭包另有钉它的用例。 */
function makeCandidate(candidateId: string, candidateRevisionId: string): LearningCardCandidateRevisionV2 {
  return { candidateId, candidateRevisionId } as LearningCardCandidateRevisionV2;
}

const CANDIDATES = [
  makeCandidate("cand-a", "rev-a"),
  makeCandidate("cand-b", "rev-b"),
  makeCandidate("cand-c", "rev-c"),
];

// ─── 唯一实现 ───────────────────────────────────────────────────────────────

test("worker run-io 转出的就是制卡领域包里那一个函数对象（没有第二份写入实现）", async () => {
  const runIo = await import("../../card-generation-v2/run-io.ts");
  const domain = await import("@astella/card-generation");
  assert.equal(runIo.insertEvent, domain.insertEvent);
  // 批量那条 worker 不转出（调用点是内部的一处），但它必须存在于同一处实现里——
  // 只剩单条可用、批量留在别处，等于事件写入又分了两份。
  assert.equal(typeof domain.insertEventBatch, "function");
});

// ─── 批量语义 ───────────────────────────────────────────────────────────────

test("候选批量落库写出的 authored 事件：seq 从既有最大值接着排、顺序与入参一致、payload 原样透传", async () => {
  const t = makeTx({ initialMaxSeq: 40, insertedCandidateIds: ["rev-a", "rev-b", "rev-c"] });
  const inserted = await insertAuthoredCandidatesBatched(
    t.tx,
    WORKSPACE_ID,
    RUN_ID,
    CANDIDATES,
    new Map(),
  );

  assert.deepEqual(inserted.sort(), ["rev-a", "rev-b", "rev-c"]);
  assert.deepEqual(t.events.map((e) => e.eventSeq), [41, 42, 43]);
  assert.deepEqual(t.events.map((e) => e.eventType), [
    "card_candidate.authored",
    "card_candidate.authored",
    "card_candidate.authored",
  ]);
  // 顺序：seq 的次序与候选的入参次序一一对应。读侧按 seq 读出来的先后关系
  // 在这里就已经定了——顺序颠倒不会让任何一条既有断言变红，但事件流是乱的。
  assert.deepEqual(t.events.map((e) => e.payload), [
    { candidateId: "cand-a", candidateRevisionId: "rev-a" },
    { candidateId: "cand-b", candidateRevisionId: "rev-b" },
    { candidateId: "cand-c", candidateRevisionId: "rev-c" },
  ]);
  assert.deepEqual(t.events.map((e) => [e.workspaceId, e.runId]), [
    [WORKSPACE_ID, RUN_ID],
    [WORKSPACE_ID, RUN_ID],
    [WORKSPACE_ID, RUN_ID],
  ]);
});

test("空批次不查库也不写库（values([]) 是 drizzle 的未定义行为）", async () => {
  const t = makeTx({ initialMaxSeq: 7 });
  const inserted = await insertAuthoredCandidatesBatched(t.tx, WORKSPACE_ID, RUN_ID, [], new Map());

  assert.deepEqual(inserted, []);
  assert.equal(t.executeCount(), 0);
  assert.equal(t.selectCount(), 0);
  assert.deepEqual(t.events, []);
});

test("候选全被既有行占住时（skipExisting 撞车）一条事件都不发，也不查 MAX", async () => {
  const t = makeTx({ initialMaxSeq: 12, insertedCandidateIds: [] });
  const inserted = await insertAuthoredCandidatesBatched(
    t.tx,
    WORKSPACE_ID,
    RUN_ID,
    CANDIDATES,
    new Map(),
    { skipExisting: true },
  );

  assert.deepEqual(inserted, []);
  assert.equal(t.selectCount(), 0);
  assert.deepEqual(t.events, []);
});

test("只给真写进去的那部分候选发事件（混合返回：两插一冲突）", async () => {
  const t = makeTx({ insertedCandidateIds: ["rev-a", "rev-c"] });
  await insertAuthoredCandidatesBatched(
    t.tx,
    WORKSPACE_ID,
    RUN_ID,
    CANDIDATES,
    new Map(),
    { skipExisting: true },
  );

  assert.deepEqual(t.events.map((e) => (e.payload as { candidateRevisionId: string }).candidateRevisionId), [
    "rev-a",
    "rev-c",
  ]);
  assert.deepEqual(t.events.map((e) => e.eventSeq), [1, 2]);
});

test("MAX 只查一次：三条事件一次往返，不是每条一次", async () => {
  const t = makeTx({ insertedCandidateIds: ["rev-a", "rev-b", "rev-c"] });
  await insertAuthoredCandidatesBatched(t.tx, WORKSPACE_ID, RUN_ID, CANDIDATES, new Map());
  assert.equal(t.selectCount(), 1);
});

// ─── 单条路径 ───────────────────────────────────────────────────────────────

test("单条 insertEvent 就是一批：同一条事件逐条写与批量写出的行相同", async () => {
  const one = makeTx({ initialMaxSeq: 3 });
  await insertEvent(one.tx, WORKSPACE_ID, RUN_ID, "card_generation.simplified_plan_committed", { k: 1 });
  const batch = makeTx({ initialMaxSeq: 3 });
  const { insertEventBatch } = await import("@astella/card-generation");
  await insertEventBatch(batch.tx, WORKSPACE_ID, RUN_ID, [
    { eventType: "card_generation.simplified_plan_committed", payload: { k: 1 } },
  ]);

  assert.deepEqual(one.events, batch.events);
  assert.equal(one.selectCount(), 1);
});

test("连续两次单条写入会重读 MAX，seq 不会重号", async () => {
  const t = makeTx({ initialMaxSeq: 40 });
  await insertEvent(t.tx, WORKSPACE_ID, RUN_ID, "a");
  await insertEvent(t.tx, WORKSPACE_ID, RUN_ID, "b");
  assert.deepEqual(t.events.map((e) => e.eventSeq), [41, 42]);
  assert.deepEqual(t.events.map((e) => e.eventType), ["a", "b"]);
});

test("没给 payload 的条目落成空对象，不落成 undefined", async () => {
  const t = makeTx();
  await insertEvent(t.tx, WORKSPACE_ID, RUN_ID, "card_generation.no_cards_recommended");
  assert.deepEqual(t.events[0]!.payload, {});
});

test("源文本截断留痕只在真截断时写，载荷是公开的三个数", async () => {
  const capped = makeTx();
  await emitSourceContentCapEvent(capped.tx, {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    cap: { truncated: true, originalLength: 90_000, limit: 60_000 },
  });
  assert.equal(capped.events.length, 1);
  assert.equal(capped.events[0]!.eventType, "card_generation.source_content_capped");
  assert.deepEqual(capped.events[0]!.payload, {
    limit: 60_000,
    originalLength: 90_000,
    usedLength: 60_000,
  });

  const untouched = makeTx();
  await emitSourceContentCapEvent(untouched.tx, {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    cap: { truncated: false, originalLength: 1_200, limit: 60_000 },
  });
  assert.deepEqual(untouched.events, []);
  assert.equal(untouched.selectCount(), 0);
});