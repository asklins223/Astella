/**
 * 「仅提醒这一次」服务层的判决表与边界纪律（39d W5-4 刀一；39 §9.1 末段、§16.24）。
 *
 * 三组判据，各自有分工：
 *  1. **判决表**（纯函数，六种结局）——不用造库就能把"并发已处理／令牌旧了／不是一次性的"
 *     这些形状全试一遍；把它们留在集测里就只能靠真的并发出来，而那会偶发。
 *  2. **源码形状**：这一对服务一个学习观察都不写、也不建继任。这是 §9.1
 *     「提醒的处理与学习判定分开」在代码上唯一能被静态守住的地方。
 *  3. **合同形状**：线上那对请求/回执真的拒掉缺字段、多字段与过去的日期。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideAcknowledgeOneTimeReminderV1,
  ONE_TIME_REMINDER_ACKNOWLEDGED_REASON,
  ONE_TIME_REMINDER_REQUESTED_REASON,
} from "./one-time-reminder-service.ts";
import {
  acknowledgeOneTimeReminderResultV2Schema,
  acknowledgeOneTimeReminderV2Schema,
  requestOneTimeReminderResultV2Schema,
  requestOneTimeReminderV2Schema,
} from "@ailearn/shared/review-reminder-contracts";

// apps/api/src/modules/review → 上溯五级才是仓库根（review→modules→src→api→apps→root）。
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SERVICE_FILE = join(REPO_ROOT, "apps/api/src/modules/review/one-time-reminder-service.ts");

const PENDING_ONE_TIME = {
  status: "pending",
  generation: 1,
  reminderKind: "one_time" as const,
  reasonCode: ONE_TIME_REMINDER_REQUESTED_REASON,
};

test("判决表：待处理的一次性提醒 ⇒ 关掉", () => {
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(PENDING_ONE_TIME, { scheduleGeneration: 1 }),
    { action: "acknowledge" },
  );
});

test("判决表：读不到那一行 ⇒ not_found（不区分「不存在」与「不是你的」，路由翻成同一个 404）", () => {
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(null, { scheduleGeneration: 1 }),
    { action: "not_found" },
  );
});

test("判决表：已经处理过的那一条，重放交回同一份回执而不是 409", () => {
  const done = { ...PENDING_ONE_TIME, status: "completed", generation: 2,
    reasonCode: ONE_TIME_REMINDER_ACKNOWLEDGED_REASON };
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(done, { scheduleGeneration: 1 }),
    { action: "already_acknowledged" },
    "拿着旧令牌重放一条已处理的提醒被判成冲突 ⇒ 界面会提示「请刷新」，而事实上没有冲突",
  );
  // 令牌对得上时也是同一档：处理是幂等的，不是版本敏感的。
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(done, { scheduleGeneration: 2 }),
    { action: "already_acknowledged" },
  );
});

test("判决表：令牌对不上 ⇒ stale_generation（但只在还没终态的那些形态上判）", () => {
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(PENDING_ONE_TIME, { scheduleGeneration: 7 }),
    { action: "stale_generation" },
  );
});

test("判决表：不是待处理 ⇒ not_pending（已取消／已撤下的那一类）", () => {
  for (const status of ["cancelled", "dismissed", "superseded"]) {
    assert.deepEqual(
      decideAcknowledgeOneTimeReminderV1(
        { ...PENDING_ONE_TIME, status, reasonCode: null },
        { scheduleGeneration: 1 },
      ),
      { action: "not_pending" },
      `status=${status} 那一档判错了`,
    );
  }
});

test("判决表：持续安排的那一条**不许**被这条命令关掉（§9.1 停订走另一行）", () => {
  assert.deepEqual(
    decideAcknowledgeOneTimeReminderV1(
      { ...PENDING_ONE_TIME, reminderKind: "sustained" },
      { scheduleGeneration: 1 },
    ),
    { action: "not_one_time" },
    "「这次提醒我处理了」能吃掉一条持续安排 ⇒ 用户想跳过这一次就能停掉整个订阅",
  );
});

test("判决表本身是灵敏的：not_one_time 那一档是 acknowledge 之前的最后一道闸", () => {
  // 这条不是"断言源码里有那句话"——那只会证明我写过它。判的是**顺序**：持续安排那一档
  // 必须在 `acknowledge` 之前被拦住，所以删掉它，持续安排就会一路落到"关掉"。
  const source = readFileSync(SERVICE_FILE, "utf8");
  const guard = 'if (subject.reminderKind !== "one_time") return { action: "not_one_time" };';
  const acknowledge = 'return { action: "acknowledge" };';
  const guardAt = source.indexOf(guard);
  const acknowledgeAt = source.indexOf(acknowledge);
  assert.ok(guardAt > 0 && acknowledgeAt > 0, "判决函数里读不到那两档 ⇒ 这条判据空转");
  const between = source.slice(guardAt + guard.length, acknowledgeAt);
  assert.equal(
    between.trim().split("\n").filter((line) => line.trim().length > 0).length, 0,
    `not_one_time 与 acknowledge 之间还夹着别的分支（${between.trim()}）：顺序变了，持续安排可能绕过那一档`,
  );
  // 反向自证：把那一档删掉之后，acknowledge 前面就没有闸了——这正是"顺序判据读得到闸"的意思。
  const mutated = source.replace(guard, "");
  assert.ok(mutated.includes(acknowledge));
  assert.ok(
    !mutated.slice(0, mutated.indexOf(acknowledge)).includes('return { action: "not_one_time" }'),
    "删掉那一档之后它仍然拦在 acknowledge 之前 ⇒ 变异没有落在正确位置",
  );
});

test("纪律：这一对服务不写任何学习观察，也不建继任（§9.1 提醒与学习判定分开）", () => {
  const source = readFileSync(SERVICE_FILE, "utf8");
  for (const table of [
    "learningAssessments",
    "learningArtifacts",
    "learningRunEvents",
    "learningRunActionLedger",
    "objectiveReviewHoldsV2",
  ]) {
    assert.ok(!source.includes(table),
      `${table} 出现在了这一对服务里：关闭一次提醒是安排回执，不是学习事实（§9.2 三种事实分开）`);
  }
  // 继任安排只能由边界在**新建**时产生；这里任何一次 insert 都意味着绕过它。
  assert.equal(
    (source.match(/\.insert\(/g) ?? []).length,
    0,
    "这一对服务里出现了 insert：排期必须走唯一调度边界（0287 的判据）",
  );
  // 唯一允许的写就是关掉那一行，且 status 是字面量（单写者台账要求能静态读出来）。
  const updates = source.match(/\.update\(\s*reviewSchedules\s*\)/g) ?? [];
  assert.equal(updates.length, 1, "这一对服务里 review_schedules 的 update 点数变了：新增一处要写进单写者台账");
});

test("纪律：reason_code 两档分开（请求是一档、处理是另一档）", () => {
  assert.notEqual(ONE_TIME_REMINDER_REQUESTED_REASON, ONE_TIME_REMINDER_ACKNOWLEDGED_REASON,
    "两档 reason 撞成同一个值 ⇒ 重放判定（读 reason 认终态）会认错行");
  const source = readFileSync(SERVICE_FILE, "utf8");
  assert.ok(source.includes("ONE_TIME_REMINDER_REQUESTED_REASON"),
    "立提醒那一发没有用它自己那档 reason");
  assert.ok(source.includes("ONE_TIME_REMINDER_ACKNOWLEDGED_REASON"),
    "关提醒那一发没有用它自己那档 reason");
});

test("线上合同：请求必须有 noteId/objectiveId/dueAt，且不多收字段", () => {
  const base = { noteId: "11111111-1111-4111-8111-111111111111",
    objectiveId: "22222222-2222-4222-8222-222222222222",
    dueAt: "2026-09-28T09:00:00+08:00" };
  assert.equal(requestOneTimeReminderV2Schema.safeParse(base).success, true);
  assert.equal(requestOneTimeReminderV2Schema.safeParse({ ...base, dueAt: undefined }).success, false);
  assert.equal(requestOneTimeReminderV2Schema.safeParse({ ...base, noteId: "not-a-uuid" }).success, false);
  // 多字段拒掉：strictObject，否则客户端可以悄悄带上一个服务端会忽略的 reminderKind。
  assert.equal(requestOneTimeReminderV2Schema.safeParse({ ...base, reminderKind: "one_time" }).success, false,
    "请求体收下了服务端自己会忽略的字段");
});

test("线上合同：处理那一发必须带乐观令牌", () => {
  assert.equal(acknowledgeOneTimeReminderV2Schema.safeParse({
    scheduleId: "11111111-1111-4111-8111-111111111111", scheduleGeneration: 2,
  }).success, true);
  assert.equal(acknowledgeOneTimeReminderV2Schema.safeParse({
    scheduleId: "11111111-1111-4111-8111-111111111111",
  }).success, false, "没有令牌也能关掉一条提醒 ⇒ 两个窗口点第二次会静默盖掉前一次的 generation");
  assert.equal(acknowledgeOneTimeReminderV2Schema.safeParse({
    scheduleId: "11111111-1111-4111-8111-111111111111", scheduleGeneration: 0,
  }).success, false, "generation 0 不是一条真实排期的形状");
});

test("线上合同：回执里 reminderKind 与 alreadyAcknowledged 都必填（两句不同的话不许合成一个）", () => {
  const base = { version: 2 as const, scheduleId: "11111111-1111-4111-8111-111111111111",
    dueAt: "2026-09-28T09:00:00+08:00", created: false };
  assert.equal(requestOneTimeReminderResultV2Schema.safeParse({ ...base, reminderKind: "sustained", held: false }).success, true);
  assert.equal(requestOneTimeReminderResultV2Schema.safeParse({ ...base, held: false }).success, false,
    "没有 reminderKind 的回执读不出「她点的仅提醒这一次到底是不是一次性的」");
  const ack = { version: 2 as const, scheduleId: "11111111-1111-4111-8111-111111111111",
    scheduleGeneration: 2, dueAt: "2026-09-28T09:00:00+08:00" };
  assert.equal(acknowledgeOneTimeReminderResultV2Schema.safeParse({ ...ack, alreadyAcknowledged: false }).success, true);
  assert.equal(acknowledgeOneTimeReminderResultV2Schema.safeParse(ack).success, false,
    "没有 alreadyAcknowledged 的回执分不出「这一次真关了」与「重放交回原来那一份」");
  assert.equal(requestOneTimeReminderResultV2Schema.safeParse({ ...base, reminderKind: "one_time", held: true }).success, true,
    "held 这一档与 created 无关：被「暂不安排」挡下时 created 也是 false");
});
