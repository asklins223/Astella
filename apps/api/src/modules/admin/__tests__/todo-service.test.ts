/**
 * 待办清单的判据测试。
 *
 * 这条链路决定首屏**先给人看什么、以及点什么**，所以判据必须钉死：
 *   - 严重度分档（block / warn / info）——分错了，用户会先看到可选家务，
 *     而"密钥没配、功能已经不可用"被埋在下面；
 *   - 每个条目都必须带**能执行**的动作——首屏的纲就是这条，
 *     带不动作的条目退化成又一面数字墙。
 *
 * 数据来自夹具（`readQueueBacklog` / `readConfigSnapshot`），不碰数据库。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTodo } from "../todo-service.ts";
import type { ConfigSnapshot } from "../config-service.ts";
import type { QueueSummary } from "../ops-service.ts";

function emptyQueue(): QueueSummary {
  return {
    byType: [],
    totals: { pending: 0, running: 0, failedRecent: 0, deadTotal: 0, oldestPendingSeconds: 0 },
  };
}

function emptyConfig(): ConfigSnapshot {
  return {
    path: "/app/config/ai-platforms.json",
    exists: true,
    writable: false,
    readOnlyReason: null,
    platforms: [],
    capabilities: [],
    tts: null,
    issues: [],
    unresolvedEnvRefs: [],
    configFileMtime: null,
  };
}

test("什么都没有时：不编造待办", () => {
  const todo = buildTodo({ backlog: emptyQueue(), config: emptyConfig() });
  assert.equal(todo.items.length, 0);
  assert.deepEqual(todo.counts, { total: 0, block: 0, warn: 0, info: 0 });
});

test("缺密钥是 block，且指向配置页", () => {
  const config = { ...emptyConfig(), unresolvedEnvRefs: ["DASHSCOPE_API_KEY"] };
  const todo = buildTodo({ backlog: emptyQueue(), config });
  assert.equal(todo.counts.block, 1);
  const [item] = todo.items;
  assert.equal(item.severity, "block");
  assert.equal(item.action.kind, "goto_config");
  assert.ok(item.actionLabel.length > 0, "每个条目都要有动作文案");
  // 密钥名在 detail 里，标题只说「有几个没配」——这是对的分层：
  // 标题给结论，细节给线索，标题塞一长串变量名会读不完。
  assert.ok(item.detail.includes("DASHSCOPE_API_KEY"), "要说清是哪个密钥没配");
  assert.ok(/\d+ 个/.test(item.title), "标题要给出数量");
});

test("配置阻断问题：block，报第一个问题", () => {
  const config = {
    ...emptyConfig(),
    issues: [
      { path: "capabilities.agent_turn.platform", message: '引用了未定义的平台 "ghost"', blocking: true },
      { path: "platforms.x.type", message: "未知协议", blocking: false },
    ],
  };
  const todo = buildTodo({ backlog: emptyQueue(), config });
  assert.equal(todo.counts.block, 1, "非阻断问题不该算进待办");
  assert.equal(todo.items[0].action.kind, "goto_config");
  assert.ok(todo.items[0].detail.includes("ghost"));
});

test("失败任务是 warn，动作是按类型的重试", () => {
  const backlog: QueueSummary = {
    ...emptyQueue(),
    byType: [
      { jobType: "companion_thought", label: "伴星随想", known: true, pending: 0, running: 0, failedRecent: 7, deadTotal: 0, oldestPendingSeconds: 0 },
    ],
    totals: { pending: 0, running: 0, failedRecent: 7, deadTotal: 0, oldestPendingSeconds: 0 },
  };
  const todo = buildTodo({ backlog, config: emptyConfig() });
  assert.equal(todo.counts.warn, 1);
  const [item] = todo.items;
  assert.equal(item.action.kind, "retry_failed");
  assert.equal(item.action.jobType, "companion_thought", "动作必须带上具体作业类型");
  assert.equal(item.count, 7);
});

test("队列堵久了是 warn，指向队列页（不是直接动手）", () => {
  const backlog: QueueSummary = {
    ...emptyQueue(),
    totals: { pending: 3, running: 0, failedRecent: 0, deadTotal: 0, oldestPendingSeconds: 1200 },
  };
  const todo = buildTodo({ backlog, config: emptyConfig() });
  const stall = todo.items.find((item) => item.id === "queue.stalled");
  assert.ok(stall, "超过阈值必须产出待办");
  assert.equal(stall.severity, "warn");
  assert.equal(stall.action.kind, "goto_queues", "堵住了先看清楚再决定，不直接改状态");
});

test("队列刚排上来（未超阈值）不算待办", () => {
  const backlog: QueueSummary = {
    ...emptyQueue(),
    totals: { pending: 5, running: 0, failedRecent: 0, deadTotal: 0, oldestPendingSeconds: 30 },
  };
  const todo = buildTodo({ backlog, config: emptyConfig() });
  assert.equal(todo.items.filter((item) => item.id === "queue.stalled").length, 0);
});

test("死信是 info，动作是清理，且带类型", () => {
  const backlog: QueueSummary = {
    ...emptyQueue(),
    byType: [
      { jobType: "companion_thought", label: "伴星随想", known: true, pending: 0, running: 0, failedRecent: 0, deadTotal: 92, oldestPendingSeconds: 0 },
    ],
    totals: { pending: 0, running: 0, failedRecent: 0, deadTotal: 92, oldestPendingSeconds: 0 },
  };
  const todo = buildTodo({ backlog, config: emptyConfig() });
  const [item] = todo.items;
  assert.equal(item.severity, "info");
  assert.equal(item.action.kind, "purge_dead");
  assert.equal(item.action.jobType, "companion_thought");
  assert.equal(item.count, 92);
});

test("排序：block 先于 warn 先于 info；同级按数量降序", () => {
  const backlog: QueueSummary = {
    ...emptyQueue(),
    byType: [
      { jobType: "a", label: "甲", known: true, pending: 0, running: 0, failedRecent: 0, deadTotal: 5, oldestPendingSeconds: 0 },
      { jobType: "b", label: "乙", known: true, pending: 0, running: 0, failedRecent: 0, deadTotal: 40, oldestPendingSeconds: 0 },
      { jobType: "c", label: "丙", known: true, pending: 0, running: 0, failedRecent: 2, deadTotal: 0, oldestPendingSeconds: 0 },
      { jobType: "d", label: "丁", known: true, pending: 0, running: 0, failedRecent: 9, deadTotal: 0, oldestPendingSeconds: 0 },
    ],
    totals: { pending: 0, running: 0, failedRecent: 11, deadTotal: 45, oldestPendingSeconds: 0 },
  };
  const config = { ...emptyConfig(), unresolvedEnvRefs: ["SOME_KEY"] };
  const todo = buildTodo({ backlog, config });

  const severities = todo.items.map((item) => item.severity);
  // 所有 block 都在 warn 之前，warn 都在 info 之前
  const rank = { block: 0, warn: 1, info: 2 } as const;
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(
      rank[severities[i - 1]] <= rank[severities[i]],
      `顺序错了：${severities.join(" → ")}`,
    );
  }
  // 同级内按数量降序
  const warns = todo.items.filter((item) => item.severity === "warn");
  assert.equal(warns[0].count, 9, "9 次失败应排在 2 次前面");
  const infos = todo.items.filter((item) => item.severity === "info");
  assert.equal(infos[0].count, 40, "40 条死信应排在 5 条前面");
});
