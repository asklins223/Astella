/** Tests for the active worker handler timeout resolution. */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { DEFAULT_AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_TASK_TIMEOUT_MS } from "@astella/shared";
import {
  resolveHandlerTimeout,
  resolveProviderCallTimeout,
  RESOLVED_TIMEOUT_INFO,
} from "../lib/handler-timeout-config.ts";

const ENV_KEYS = [
  "WORKER_MODEL_TIMEOUT_MS",
  "WORKER_TIMEOUT_PARSE_SOURCE_MS",
  "WORKER_TIMEOUT_COMPANION_AGENT_MS",
  "WORKER_PROVIDER_TIMEOUT_MS",
  "WORKER_PROVIDER_TIMEOUT_NOTE_OVERVIEW_GENERATE_MS",
  "WORKER_PROVIDER_TIMEOUT_NOTE_MIND_MAP_GENERATE_MS",
  "WORKER_PROVIDER_TIMEOUT_NOTE_ANNOTATION_EXPLAIN_MS",
  "WORKER_PROVIDER_TIMEOUT_NOTE_EXPANSION_GENERATE_MS",
  "WORKER_TIMEOUT_NOTE_DYNAMIC_ARTIFACT_GENERATE_MS",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

test("resolveHandlerTimeout returns active built-in defaults", () => {
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
  assert.equal(resolveHandlerTimeout("companion_agent"), Infinity);
  for (const type of ["companion_memory_extract", "companion_summarizer", "companion_daily_summary",
    "note_overview_generate", "note_annotation_explain", "note_expansion_generate", "note_dynamic_artifact_generate"]) {
    assert.equal(resolveHandlerTimeout(type), DEFAULT_AI_TASK_TIMEOUT_MS);
  }
  // 没有任务契约的类型仍跟随嵌套 provider 的全局默认。
  for (const type of ["companion_memory_extract", "companion_summarizer", "companion_daily_summary",
    "note_dynamic_artifact_generate"]) {
    assert.equal(resolveProviderCallTimeout(type), DEFAULT_AI_PROVIDER_TIMEOUT_MS);
  }
});

/**
 * 2026-10-16 线上：一次速看单发 242 s（mimo-v2.6-flash/medium 产出 9,411 completion
 * token），客户端 1.6 s 轮询、纸面从头到尾只写「正在整理」。这几条断言钉住的是
 * "笔记产物有单发预算、超时后有出路"，不是某个具体数字的审美。
 */
test("笔记学习产物有单发预算契约，且部署的显式值仍可覆盖", () => {
  assert.equal(resolveProviderCallTimeout("note_overview_generate"), 120_000);
  assert.equal(resolveProviderCallTimeout("note_mind_map_generate"), 150_000);
  assert.equal(resolveProviderCallTimeout("note_annotation_explain"), 90_000);
  assert.equal(resolveProviderCallTimeout("note_expansion_generate"), 150_000);
  for (const type of ["note_overview_generate", "note_mind_map_generate", "note_annotation_explain", "note_expansion_generate"]) {
    assert.ok(
      resolveProviderCallTimeout(type) < resolveHandlerTimeout(type),
      `${type} 的单发预算必须短于 handler，否则 handler 的持久化余量没有意义`,
    );
  }

  // 优先级：per-type env > WORKER_PROVIDER_TIMEOUT_MS > 内置契约。
  process.env.WORKER_PROVIDER_TIMEOUT_NOTE_OVERVIEW_GENERATE_MS = "200000";
  assert.equal(resolveProviderCallTimeout("note_overview_generate"), 200_000);

  // 全局值优先于内置契约——这正是 compose 必须为这几个任务显式声明 per-type 值的原因。
  delete process.env.WORKER_PROVIDER_TIMEOUT_NOTE_OVERVIEW_GENERATE_MS;
  process.env.WORKER_PROVIDER_TIMEOUT_MS = "900000";
  assert.equal(resolveProviderCallTimeout("note_overview_generate"), 900_000);

  assert.equal(RESOLVED_TIMEOUT_INFO.defaultProviderTimeouts.note_overview_generate, 120_000);
});

test("resolveHandlerTimeout falls back to global default for unknown types", () => {
  assert.equal(resolveHandlerTimeout("unknown_type"), DEFAULT_AI_TASK_TIMEOUT_MS);
});

test("resolveHandlerTimeout respects a per-type override", () => {
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "120000";
  assert.equal(resolveHandlerTimeout("parse_source"), 120_000);
});

test("显式伴星时限按部署配置执行，不额外压成 24 小时", () => {
  process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = String(28 * 24 * 60 * 60_000);
  assert.equal(resolveHandlerTimeout("companion_agent"), 28 * 24 * 60 * 60_000);
});

test("resolveHandlerTimeout respects the global override", () => {
  process.env.WORKER_MODEL_TIMEOUT_MS = "60000";
  assert.equal(resolveHandlerTimeout("unknown_type"), 60_000);
  assert.equal(resolveHandlerTimeout("companion_agent"), Infinity, "legacy global chat timeout must not cut an agent task short");
});

test("resolveHandlerTimeout ignores invalid env values", () => {
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "not-a-number";
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "-5";
  assert.equal(resolveHandlerTimeout("parse_source"), 60_000);
});

test("configured long tasks are independent of the crash recovery lease", () => {
  process.env.WORKER_TIMEOUT_NOTE_DYNAMIC_ARTIFACT_GENERATE_MS = "3600000";
  assert.equal(resolveHandlerTimeout("note_dynamic_artifact_generate"), 3600000);
  assert.ok(resolveHandlerTimeout("note_dynamic_artifact_generate") > RESOLVED_TIMEOUT_INFO.leaseTimeoutMs);
});

test("provider budget leaves time for persistence", () => {
  assert.equal(resolveProviderCallTimeout("parse_source"), 45_000);
  assert.equal(
    resolveHandlerTimeout("parse_source") - resolveProviderCallTimeout("parse_source"),
    15_000,
  );
});

test("dynamic artifact generation finishes inside the handler and follows its override", async () => {
  const { resolveNoteDynamicArtifactBudget, COMPANION_AGENT_PERSISTENCE_MARGIN_MS } = await import("../lib/handler-timeout-config.ts");
  const budget = resolveNoteDynamicArtifactBudget();
  assert.equal(budget.handlerAbortMs, resolveHandlerTimeout("note_dynamic_artifact_generate"));
  assert.equal(budget.loopDeadlineMs, budget.handlerAbortMs - COMPANION_AGENT_PERSISTENCE_MARGIN_MS);
  assert.ok(budget.loopDeadlineMs < budget.handlerAbortMs);
  assert.ok(budget.handlerAbortMs > budget.leaseMs);
  process.env.WORKER_TIMEOUT_NOTE_DYNAMIC_ARTIFACT_GENERATE_MS = "60000";
  assert.equal(resolveNoteDynamicArtifactBudget().loopDeadlineMs, 45_000);
});

/** The renewable lease is a recovery window; execution budgets still reserve persistence time. */
test("续租独立于执行预算，handler > run > 单次模型调用", async () => {
  const { LEASE_TIMEOUT_MS } = await import("../queue.ts");
  const { READ_IMAGE_TOOL_TIMEOUT_MS } = await import("../handlers/companion-read-tools.ts");
  const {
    COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
    resolveCompanionAgentBudget,
  } = await import("../lib/handler-timeout-config.ts");

  process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = "1800000";
  const handler = resolveHandlerTimeout("companion_agent");
  const runBudget = handler - COMPANION_AGENT_PERSISTENCE_MARGIN_MS;

  assert.ok(handler > LEASE_TIMEOUT_MS, "长任务应能跨过可续租的崩溃回收窗口");
  assert.ok(
    READ_IMAGE_TOOL_TIMEOUT_MS < runBudget,
    "最重的单个工具必须能在 run 预算内跑完一次，否则它每一次都会被中途掐死",
  );
  assert.ok(
    resolveProviderCallTimeout("companion_agent") < runBudget,
    "一次 provider 调用不能吃完整个 run 预算（后面的收尾就没有余地了）",
  );
  assert.ok(runBudget > READ_IMAGE_TOOL_TIMEOUT_MS, "工具执行受整轮剩余时间约束，不叠加猜测的查库次数预算");

  // 派生链本身：三层是 lease 的函数，不是三个各自维护的数字。
  const budget = resolveCompanionAgentBudget();
  assert.equal(budget.leaseMs, LEASE_TIMEOUT_MS);
  assert.equal(budget.handlerAbortMs, handler);
  assert.equal(budget.loopDeadlineMs, handler - COMPANION_AGENT_PERSISTENCE_MARGIN_MS);
  assert.ok(
    budget.loopDeadlineMs < budget.handlerAbortMs,
    "loop deadline 必须先于 handler abort：否则循环跑到一半被 abort 掐死，delta 与终态事务没有落库时间",
  );
  assert.equal(
    RESOLVED_TIMEOUT_INFO.defaultTimeouts.companion_agent,
    Infinity,
    "伴星没有默认整轮时限，由单次服务超时与租约回收处理失联",
  );
});

test("预算链跟着 env 覆盖一起动：handler 被覆盖时 loop deadline 不能停在旧值", async () => {
  const {
    COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
    resolveCompanionAgentBudget,
  } = await import("../lib/handler-timeout-config.ts");

  const before = resolveCompanionAgentBudget();
  process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS = "60000";
  try {
    const after = resolveCompanionAgentBudget();
    assert.equal(after.handlerAbortMs, 60_000);
    assert.equal(after.loopDeadlineMs, 60_000 - COMPANION_AGENT_PERSISTENCE_MARGIN_MS);
    assert.notEqual(after.loopDeadlineMs, before.loopDeadlineMs);
    assert.equal(after.leaseMs, before.leaseMs, "租约是外层边界，不该被 handler 覆盖改动");
  } finally {
    delete process.env.WORKER_TIMEOUT_COMPANION_AGENT_MS;
  }
});
