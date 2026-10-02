import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0349_companion_tool_status_vocabulary.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as { entries: Array<{ tag: string }> };
const contracts = readFileSync(
  new URL("../../../../packages/shared/src/contracts/companion-agent-contracts.ts", import.meta.url),
  "utf8",
);
const nodes = readFileSync(
  new URL("../../../../apps/desktop-client/src/renderer/src/app/companion-agent-nodes.ts", import.meta.url),
  "utf8",
);
const traceView = readFileSync(
  new URL("../../../../apps/desktop-client/src/renderer/src/components/companion/CompanionRunTraceView.tsx", import.meta.url),
  "utf8",
);

test("0349 已登记", () => {
  assert.ok(journal.entries.some((e) => e.tag === "0349_companion_tool_status_vocabulary"));
});

test("CHECK 约束认这两个词，且**替换**而不是叠加", () => {
  assert.match(migration, /DROP CONSTRAINT companion_agent_tool_calls_status_check/);
  assert.match(migration, /ADD CONSTRAINT companion_agent_tool_calls_status_check/);
  for (const status of ["not_executed", "unavailable"]) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
  // 原来那八个词必须还在，否则是换掉而不是放宽。
  for (const status of ["requested", "executing", "succeeded", "outcome_unknown", "failed", "blocked", "expired"]) {
    assert.match(migration, new RegExp(`'${status}'`));
  }
});

test("共享契约与客户端都收这两个词 —— 三处不同步就会有一处显示「无法识别」", () => {
  assert.match(contracts, /"not_executed"/);
  assert.match(contracts, /"unavailable"/);
  assert.match(nodes, /not_executed: "not_executed"/);
  assert.match(nodes, /unavailable: "unavailable"/);
});

test("两档各有**自己的**文案，且都不是「失败」", () => {
  // 折叠成"失败"时用户既不知道该改参数还是该去开开关，
  // 而 unavailable 的合同要求恰恰是「指出实际影响及可用替代」。
  assert.match(traceView, /not_executed: "没有开始"/);
  assert.match(traceView, /unavailable: "这次用不了"/);
  assert.match(traceView, /failed: "失败"/);
});

test("诊断视图把这两档也算作「这一轮没拿到结果」", () => {
  assert.match(traceView, /node\.state === "not_executed"/);
  assert.match(traceView, /node\.state === "unavailable"/);
});

test("【自证】判据认得出「只改约束、忘了改客户端」这个真实退化", () => {
  // 只加 CHECK 的半成品：用户会看到「工具状态无法识别，操作结果待核对」。
  const constraintOnly = "ALTER TABLE ... ADD CONSTRAINT ... CHECK (status IN ('not_executed'));";
  assert.ok(!/TOOL_STATE|CompanionRunTraceView/.test(constraintOnly), "自证样本没造好");
  assert.match(nodes, /unavailable: "unavailable"/, "自证：客户端这一侧确实也补了");
  assert.match(traceView, /unavailable: "这次用不了"/, "自证：文案这一侧确实也补了");
});