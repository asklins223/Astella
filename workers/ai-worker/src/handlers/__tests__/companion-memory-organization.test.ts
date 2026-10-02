/**
 * 后台整理的**触发判据**与**语义动作判据**（40 §4.6.3 / §4.6.9，验收 A74）。
 *
 * ## 为什么这两块必须是纯函数
 *
 * 它们决定「**动哪条记忆**」。动错了就是悄悄丢用户的数据——比不整理严重得多，
 * 而且这类错不报错、不崩溃，只是过一阵用户发现"她忘了我说过的话"。
 *
 * 把判据和 IO 混在一个函数里时，这两条规则最难测、也最容易被无声改掉：
 * 一次重构把 `oldestPendingAt` 换成"今天新增"是极自然的事，而没有任何测试会红。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_ORGANIZATION_BOUNDED_BATCH,
  MEMORY_ORGANIZATION_MIN_BACKLOG,
  MEMORY_ORGANIZATION_MIN_INTERVAL_MS,
  MEMORY_ORGANIZATION_OLDEST_PENDING_MS,
  memoryOrganizationActionFor,
  memoryOrganizationBatchSize,
  memoryOrganizationSurface,
  memoryOrganizationGate,
  type MemoryOrganizationCandidate,
} from "../companion-memory-organization.ts";

const NOW = new Date("2026-10-05T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

test("没有待处理就永远不跑——没有东西可整理时不该产生模型调用", () => {
  for (const lastSuccessAt of [null, daysAgo(100)]) {
    const decision = memoryOrganizationGate({
      backlogCount: 0,
      oldestPendingAt: null,
      lastSuccessAt,
      now: NOW,
    });
    assert.equal(decision.run, false, "积压为 0 却判定要跑");
    assert.equal(decision.run === false && decision.reason, "nothing_pending");
  }
});

test("首轮按**最早待处理**计时，而不是按「距上次成功」", () => {
  // 从没成功整理过 ⇒ 没有"上次"可距，只能看最早待处理躺了多久。
  const justOverThreshold = Math.ceil(MEMORY_ORGANIZATION_OLDEST_PENDING_MS / (24 * 60 * 60 * 1000)) + 1;
  const decision = memoryOrganizationGate({
    backlogCount: 3,
    oldestPendingAt: daysAgo(justOverThreshold),
    lastSuccessAt: null,
    now: NOW,
  });
  assert.equal(decision.run, true, "首轮里最旧的已经躺了 31 天，应当做一批");
  assert.equal(decision.run === true && decision.reason, "oldest_pending_expired");
  assert.equal(decision.run === true && decision.bounded, true, "这一条必须是有界小批");
});

test("首轮积压够 30 条就跑，且不限批", () => {
  const decision = memoryOrganizationGate({
    backlogCount: MEMORY_ORGANIZATION_MIN_BACKLOG,
    oldestPendingAt: daysAgo(1),
    lastSuccessAt: null,
    now: NOW,
  });
  assert.equal(decision.run, true);
  assert.equal(decision.run === true && decision.bounded, false);
});

test("日常情形：积压 ≥30 **且** 距上次成功 ≥7 天", () => {
  const ok = memoryOrganizationGate({
    backlogCount: 31,
    oldestPendingAt: daysAgo(3),
    lastSuccessAt: new Date(NOW.getTime() - MEMORY_ORGANIZATION_MIN_INTERVAL_MS),
    now: NOW,
  });
  assert.equal(ok.run, true);
  assert.equal(ok.run === true && ok.reason, "backlog_and_interval");

  // 积压够但只过了 3 天 ⇒ 不跑。
  const tooSoon = memoryOrganizationGate({
    backlogCount: 31,
    oldestPendingAt: daysAgo(3),
    lastSuccessAt: daysAgo(3),
    now: NOW,
  });
  assert.equal(tooSoon.run, false);
  assert.equal(tooSoon.run === false && tooSoon.reason, "not_enough_time");
});

test("低频用户不会被 7 天窗口永远挡住（合同点名过的失败形状）", () => {
  // 一个月说三句话 ⇒ 永远攒不到 30 条。若只用「积压 ≥30」当条件，
  // 这类用户的后台整理**一次都不跑**，而他们的记忆最需要整理。
  // 兜底是：最旧待处理满 30 天 ⇒ 有界小批。
  const lowFrequency = memoryOrganizationGate({
    backlogCount: 3,
    oldestPendingAt: daysAgo(40),
    lastSuccessAt: daysAgo(1), // 刚整理过，7 天窗口没过
    now: NOW,
  });
  assert.equal(lowFrequency.run, true, "低频用户被 7 天窗口挡死了");
  assert.equal(lowFrequency.run === true && lowFrequency.bounded, true);
});

test("分母是**累计积压**，不是「当天新增」", () => {
  // 自证：把 backlogCount 换成"今天新增"后，判定会整个反过来。
  // 今天新增 40 条但这三天都没成功过 ⇒ 按累计口径这是第一次触发。
  const firstEver = memoryOrganizationGate({
    backlogCount: 40,
    oldestPendingAt: daysAgo(2),
    lastSuccessAt: null,
    now: NOW,
  });
  assert.equal(firstEver.run, true);

  // 反例：昨天刚成功整理，今天新增 40 条 ⇒ 不跑（间隔没到）。
  const justRan = memoryOrganizationGate({
    backlogCount: 40,
    oldestPendingAt: daysAgo(2),
    lastSuccessAt: daysAgo(1),
    now: NOW,
  });
  assert.equal(justRan.run, false, "刚整理过就该等，不能每天跑一轮");
});

test("有界小批的批大小必须**小于**触发阈值——「有界」就是这个意思", () => {
  const bounded = memoryOrganizationGate({
    backlogCount: 2,
    oldestPendingAt: daysAgo(31),
    lastSuccessAt: daysAgo(1),
    now: NOW,
  });
  const size = memoryOrganizationBatchSize(bounded);
  assert.ok(size < MEMORY_ORGANIZATION_MIN_BACKLOG, "有界小批却等于整批阈值");
  assert.equal(size, MEMORY_ORGANIZATION_BOUNDED_BATCH);
});

const candidate = (over: Partial<MemoryOrganizationCandidate> = {}): MemoryOrganizationCandidate => ({
  memoryId: "m1",
  kind: "preference",
  sameFactTwinId: null,
  sameFactTwinContradicts: false,
  importance: 0.5,
  pinned: false,
  appliesWhen: null,
  validFrom: daysAgo(10),
  validUntil: null,
  independentEvidenceCount: 1,
  ...over,
});

test("五种语义动作的判据（§4.6.3 那张表）", () => {
  // 合并：同一事实且无矛盾
  assert.equal(memoryOrganizationActionFor(
    candidate({ sameFactTwinId: "m2", sameFactTwinContradicts: false }), NOW), "merge");
  // 冲突不强行合并 —— 交给并存 + 标争议，不是挑一个赢
  assert.notEqual(memoryOrganizationActionFor(
    candidate({ sameFactTwinId: "m2", sameFactTwinContradicts: true }), NOW), "merge");

  // 移除：过**声明期限**（机械过期）
  assert.equal(memoryOrganizationActionFor(candidate({ validUntil: daysAgo(1) }), NOW), "remove");
  // 期限还没到就不算过期
  assert.notEqual(memoryOrganizationActionFor(candidate({ validUntil: daysAhead(5) }), NOW), "remove");

  // 蒸馏：三份**独立**事件支持
  assert.equal(memoryOrganizationActionFor(candidate({ independentEvidenceCount: 3 }), NOW), "distill");

  // 升级：带条件 + 多份证据 + 未设期限
  assert.equal(memoryOrganizationActionFor(
    candidate({ appliesWhen: "我累的时候", independentEvidenceCount: 2 }), NOW), "upgrade");
  // 一次反馈不够 —— §4.6.3「一次行为只能支持一次观察」
  assert.notEqual(memoryOrganizationActionFor(
    candidate({ appliesWhen: "我累的时候", independentEvidenceCount: 1 }), NOW), "upgrade");

  // 降级：条件性记忆只有一份证据
  assert.equal(memoryOrganizationActionFor(
    candidate({ appliesWhen: "我累的时候", independentEvidenceCount: 1 }), NOW), "downgrade");
});

test("固定（pinned）不参与自动整理；「最近没被提到」也不是降级理由", () => {
  assert.equal(memoryOrganizationActionFor(candidate({ pinned: true }), NOW), null,
    "用户固定的东西不该被后台整理自动动");
  assert.equal(memoryOrganizationActionFor(candidate({ independentEvidenceCount: 5, pinned: true }), NOW), null);

  // §4.6.3：「不因未再次提到就断言失效」。
  // 判据里根本没有 lastUsedAt 这个输入 —— 这本身就是那条规则的保证。
  assert.equal(memoryOrganizationActionFor(candidate({ appliesWhen: null }), NOW), null,
    "没有任何可判据时应当什么都不做，而不是臆断失效");
});

test("【自证】判据认得出「按当天新增当分母」这个真实退化", () => {
  // 退化版：只看"今天新增"。
  const wrongGate = (todayNew: number) => todayNew >= MEMORY_ORGANIZATION_MIN_BACKLOG;
  // 低频用户：今天新增 2 条，累计 40 条且从没整理过。
  assert.equal(wrongGate(2), false, "自证样本没造好：退化版确实不会触发");
  assert.equal(memoryOrganizationGate({
    backlogCount: 40, oldestPendingAt: daysAgo(35), lastSuccessAt: null, now: NOW,
  }).run, true, "正确的累计口径应当触发");
});

test("surface 结论**至多一段**，没有可说的事就返回 null", () => {
  // §4.5.10「没有值得返回的内容可以为空」/ §4.6.9「至多返回一段」。
  // 编一句出来是负债：下一轮它会被注入，而它是关于"她刚整理过"的提示，
  // 不是给用户看的结论。
  assert.equal(memoryOrganizationSurface([], []), null);
  assert.ok(memoryOrganizationSurface(["a"], []));
  assert.ok(memoryOrganizationSurface([], ["b"]));
});

test("surface 结论有长度上限 —— 它进的是下一轮的上下文", () => {
  const long = Array.from({ length: 500 }, (_, i) => `m-${i}`);
  const surface = memoryOrganizationSurface(long, long);
  assert.ok(surface !== null);
  assert.ok((surface?.length ?? 0) <= 240, `surface 长 ${surface?.length}，超上限`);
});

test("【自证】判据认得出「每次都编一句」的退化", () => {
  const always = () => "整理完成";
  assert.equal(always(), "整理完成", "自证样本没造好");
  // 正控制：无事发生时我们确实返回 null，而不是这句话。
  assert.equal(memoryOrganizationSurface([], []), null);
});
