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
  assert.equal(resolveHandlerTimeout("companion_agent"), DEFAULT_AI_TASK_TIMEOUT_MS);
  for (const type of ["companion_memory_extract", "companion_summarizer", "companion_daily_summary",
    "note_overview_generate", "note_annotation_explain", "note_expansion_generate", "note_dynamic_artifact_generate"]) {
    assert.equal(resolveHandlerTimeout(type), DEFAULT_AI_TASK_TIMEOUT_MS);
    assert.equal(resolveProviderCallTimeout(type), DEFAULT_AI_PROVIDER_TIMEOUT_MS);
  }
});

test("resolveHandlerTimeout falls back to global default for unknown types", () => {
  assert.equal(resolveHandlerTimeout("unknown_type"), DEFAULT_AI_TASK_TIMEOUT_MS);
});

test("resolveHandlerTimeout respects a per-type override", () => {
  process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS = "120000";
  assert.equal(resolveHandlerTimeout("parse_source"), 120_000);
});

test("resolveHandlerTimeout respects the global override", () => {
  process.env.WORKER_MODEL_TIMEOUT_MS = "60000";
  assert.equal(resolveHandlerTimeout("unknown_type"), 60_000);
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
  const { COMPANION_AGENT_DEADLINE_MS, COMPANION_AGENT_TOOL_TIMEOUT_MS } = await import("@astella/shared");
  const { READ_IMAGE_TOOL_TIMEOUT_MS } = await import("../handlers/companion-read-tools.ts");
  const {
    COMPANION_AGENT_PERSISTENCE_MARGIN_MS,
    resolveCompanionAgentBudget,
  } = await import("../lib/handler-timeout-config.ts");

  const handler = resolveHandlerTimeout("companion_agent");
  const runBudget = handler - COMPANION_AGENT_PERSISTENCE_MARGIN_MS;

  assert.ok(handler > LEASE_TIMEOUT_MS, "长任务应能跨过可续租的崩溃回收窗口");
  assert.ok(
    COMPANION_AGENT_DEADLINE_MS >= handler,
    "合同预算不该在一个新 attempt 里比 handler 更早绑住：那会把超时误记成 AGENT_BUDGET_EXCEEDED",
  );
  assert.ok(
    READ_IMAGE_TOOL_TIMEOUT_MS < runBudget,
    "最重的单个工具必须能在 run 预算内跑完一次，否则它每一次都会被中途掐死",
  );
  assert.ok(
    resolveProviderCallTimeout("companion_agent") < runBudget,
    "一次 provider 调用不能吃完整个 run 预算（后面的收尾就没有余地了）",
  );
  assert.ok(
    runBudget - READ_IMAGE_TOOL_TIMEOUT_MS >= COMPANION_AGENT_TOOL_TIMEOUT_MS * 2,
    "读完一张图之后，至少要还剩两次查库工具的时间，否则这一步之后什么都做不了",
  );

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
    DEFAULT_AI_TASK_TIMEOUT_MS,
    "伴星跟随统一任务时限，不能再被两分钟租约限制",
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
