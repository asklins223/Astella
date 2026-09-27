import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoundTargetGrounder } from "./target-grounding.ts";
import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";

const config = { url: "https://example.test/chat/completions", key: "test", model: "grounder" };
const options = {
  teaching: { explanation: "本段的沸腾温度以标准大气压为条件。" },
  target: { conceptLabel: "沸腾", objectiveStatement: "说明沸腾条件", publicSummary: "温度与压力", knowledgeForm: "causal_model" as const,
    units: [{ unitId: "unit-1", fact: "标准大气压下水在100℃沸腾", criterion: "同时说明压力与温度条件", facet: "explain" as const,
      sourceBlockOrdinal: 1, quote: "标准大气压下水在100℃沸腾" }] },
  input: { drivingQuestion: "水何时沸腾", planSteps: [], blocks: [{ ordinal: 1, type: "paragraph", text: "标准大气压下水在100℃沸腾" }] },
  scope: { workspaceId: "workspace", userId: "user" }, round: { roundId: "round", noteVersionId: "version", sourceContentHash: "hash" },
  attemptId: "attempt", maxCalls: 2, currentActiveTransaction: () => undefined,
};
const unit = { unitId: "unit-1", factSupported: true, criterionSupported: true, reason: "原文有两个条件" };
const reply = (output: object) => ({ status: 200, statusText: "OK", body: { choices: [{ message: { content: JSON.stringify({
  teachingSupported: true, teachingReason: "讲解只解释原文条件", teachingSegments: [{ ordinal: 1, supported: true, reason: "解释原文条件" }], ...output,
}) } }] } });

test("grounding requires objective, fact and criterion support, with the complete exact unit set", async () => {
  for (const report of [
    { objectiveSupported: false, units: [unit] },
    { objectiveSupported: true, units: [{ ...unit, criterionSupported: false }] },
    { objectiveSupported: true, units: [{ ...unit, unitId: "another-unit" }] },
    { objectiveSupported: true, units: [unit, unit] },
  ]) {
    const result = await createRoundTargetGrounder(config, async () => reply(report))({ ...options, maxCalls: 1 });
    assert.equal(result.approved, false); assert.equal(result.modelCalls, 1);
  }
  const result = await createRoundTargetGrounder(config, async (_url, _headers, body, signal) => {
    assert.ok(signal); assert.match(JSON.stringify(body), /标准大气压/);
    return reply({ objectiveSupported: true, units: [unit] });
  })(options);
  assert.equal(result.approved, true);
});

test("unavailable configuration or exhausted calls/time cannot approve unverified teaching", async () => {
  let calls = 0;
  const requester: PublicJsonRequester = async () => { calls++; throw Error("must not call"); };
  for (const result of [
    await createRoundTargetGrounder(null, requester)(options),
    await createRoundTargetGrounder(config, requester)({ ...options, maxCalls: 0 }),
    await createRoundTargetGrounder(config, requester)({ ...options, maxDurationMs: 0 }),
  ]) assert.equal(result.report, null);
  assert.equal(calls, 0);
});

test("unsupported explanation is rejected even when every target unit is supported", async () => {
  const result = await createRoundTargetGrounder(config, async (_url, _headers, body) => {
    assert.match(JSON.stringify(body), /神经机制/); assert.match(JSON.stringify(body), /本段的沸腾温度/);
    return reply({ teachingSupported: false, teachingReason: "解释补入原文没有的因果机制", objectiveSupported: true, units: [unit] });
  })(options);
  assert.equal(result.approved, false); assert.equal(result.report?.teachingSupported, false);
});

test("material without an assessable target still receives an independent teaching check", async () => {
  const result = await createRoundTargetGrounder(config, async () => reply({ objectiveSupported: false, units: [] }))({ ...options, target: null });
  assert.equal(result.approved, false); assert.equal(result.report?.teachingSupported, true); assert.equal(result.modelCalls, 1);
});

test("every explanation sentence and example must be checked; one unsupported segment overrides a whole-text approval", async () => {
  const expanded = { ...options, teaching: { explanation: "本段提到标准大气压。它保证任意气压下都在100℃沸腾。", example: "标准大气压下水在100℃沸腾。" }, maxCalls: 1 };
  const missing = await createRoundTargetGrounder(config, async () => reply({ objectiveSupported: true, units: [unit] }))(expanded);
  assert.equal(missing.report, null, "a global approval cannot skip later sentences or the example");
  const contradicted = await createRoundTargetGrounder(config, async () => reply({ objectiveSupported: true, units: [unit], teachingSegments: [
    { ordinal: 1, supported: true, reason: "原文条件" }, { ordinal: 2, supported: false, reason: "把有条件事实说成无条件" },
    { ordinal: 3, supported: true, reason: "例子与原文一致" },
  ] }))(expanded);
  assert.equal(contradicted.report?.teachingSupported, false); assert.equal(contradicted.approved, false);
});

test("failed grounding transport is charged and cannot exceed remaining calls", async () => {
  let calls = 0;
  const result = await createRoundTargetGrounder(config, async () => { calls++; return { status: 503, statusText: "unavailable", body: {} }; })({ ...options, maxCalls: 1 });
  assert.equal(result.approved, false); assert.equal(result.report, null); assert.equal(calls, 1); assert.equal(result.modelCalls, 1);
});

test("remaining round time aborts a pending grounding provider", async () => {
  const result = await createRoundTargetGrounder(config, async (_url, _headers, _body, signal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    throw Error("unreachable");
  })({ ...options, maxCalls: 1, maxDurationMs: 25 });
  assert.equal(result.approved, false); assert.equal(result.modelCalls, 1);
});
