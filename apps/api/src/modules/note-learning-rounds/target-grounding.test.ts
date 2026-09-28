import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoundTargetGrounder, selectGroundedApplicationScenario, selectGroundedRoundTarget } from "./target-grounding.ts";
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
  teachingSupported: true, teachingReason: "讲解只解释原文条件", teachingSegments: [{ ordinal: 1, supported: true, reason: "解释原文条件" }],
  publicQuestionSafe: true, suspectClaims: [], ...output,
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

test("new application setting requires an independent approval and cannot disclose the canonical fact", async () => {
  const applyTarget = { ...options.target, units: [{ ...options.target.units[0], facet: "apply" as const }] };
  const scenario = "另一杯水处在不同气压环境，你会先核对什么条件再判断沸腾温度？";
  const checked = await createRoundTargetGrounder(config, async (_url, _headers, body) => {
    assert.match(JSON.stringify(body), /applicationScenario/);
    return reply({ objectiveSupported: true, applicationScenarioSupported: true, units: [unit] });
  })({ ...options, target: applyTarget, applicationScenario: scenario });
  assert.equal(selectGroundedApplicationScenario(scenario, applyTarget, checked.report!, options.input), scenario);
  assert.equal(selectGroundedApplicationScenario(scenario, applyTarget,
    { ...checked.report!, applicationScenarioSupported: false }, options.input), null);
  assert.equal(selectGroundedApplicationScenario(`${scenario}标准大气压下水在100℃沸腾`, applyTarget,
    checked.report!, options.input), null);
  assert.equal(selectGroundedApplicationScenario("标准大气压下水在100℃沸腾", applyTarget,
    checked.report!, options.input), null, "copied note wording is not a new setting");
});

test("a supported target is withheld when its public first-try question gives away the answer", async () => {
  const report = await createRoundTargetGrounder(config, async () => reply({
    objectiveSupported: true, publicQuestionSafe: false, units: [unit],
  }))(options);
  assert.equal(selectGroundedRoundTarget(options.target, report.report), null);
  const leakedTarget = { ...options.target, objectiveStatement: "说明标准大气压下水在100℃沸腾" };
  const superficiallyApproved = await createRoundTargetGrounder(config, async () => reply({
    objectiveSupported: true, units: [unit],
  }))({ ...options, target: leakedTarget });
  assert.equal(selectGroundedRoundTarget(leakedTarget, superficiallyApproved.report), null);
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

test("a located suspect factual claim remains a warning and prevents a formal target", async () => {
  const sourceQuote = "复合索引缺少最左列条件就无法使用索引";
  const target = { ...options.target, units: [{ ...options.target.units[0], fact: sourceQuote, quote: sourceQuote }] };
  const result = await createRoundTargetGrounder(config, async (_url, _headers, body) => {
    const prompt = JSON.stringify(body);
    assert.match(prompt, /仅仅因为材料没有外部来源，不算可疑/);
    assert.match(prompt, /sourceQuote 必须逐字复制/);
    return reply({ objectiveSupported: true, units: [unit], suspectClaims: [{ unitIds: ["unit-1"], sourceBlockOrdinal: 1,
      sourceQuote, reason: "该说法过于绝对，索引是否可用还取决于查询条件与优化器判断。" }] });
  })({ ...options, target, input: { ...options.input, blocks: [{ ordinal: 1, type: "paragraph", text: `笔记：${sourceQuote}。` }] } });
  assert.equal(result.report?.teachingSupported, true);
  assert.equal(result.approved, false);
  assert.deepEqual(result.report?.suspectClaims, [{ unitIds: ["unit-1"], sourceBlockOrdinal: 1, sourceQuote,
    reason: "该说法过于绝对，索引是否可用还取决于查询条件与优化器判断。" }]);
});

test("a fabricated or mismatched claim quote is withheld while the suspect-claim hold remains", async () => {
  const result = await createRoundTargetGrounder(config, async () => reply({ objectiveSupported: true, units: [unit], suspectClaims: [{
    unitIds: ["unit-1"], sourceBlockOrdinal: 1, sourceQuote: "原文里不存在的事实句子", reason: "可能漏掉重要条件。",
  }] }))({ ...options, input: { ...options.input, blocks: [{ ordinal: 1, type: "paragraph", text: "原文只有真实存在的句子。" }] } });
  assert.equal(result.approved, false);
  assert.equal(result.report?.suspectClaims[0].sourceBlockOrdinal, null);
  assert.equal(result.report?.suspectClaims[0].sourceQuote, null);
});

test("a suspect unit is excluded while an independently supported unit remains practiceable", async () => {
  const safeUnit = { unitId: "unit-2", fact: "检索练习要求学习者先从记忆中回想答案", criterion: "指出先回想再核对", facet: "explain" as const,
    sourceBlockOrdinal: 2, quote: "先遮住答案，再从记忆中回想。" };
  const target = { ...options.target, units: [{ ...options.target.units[0], fact: "复合索引缺少最左列条件就无法使用索引",
    quote: "复合索引缺少最左列条件就无法使用索引" }, safeUnit] };
  const report = await createRoundTargetGrounder(config, async () => reply({ objectiveSupported: true, units: [unit,
    { unitId: "unit-2", factSupported: true, criterionSupported: true, reason: "第二段原文直接说明先回想" }], suspectClaims: [{
    unitIds: ["unit-1"], sourceBlockOrdinal: 1, sourceQuote: "复合索引缺少最左列条件就无法使用索引",
    reason: "这条说法可能忽略索引可用性与查询条件之间的关系。",
  }] }))({ ...options, target, input: { ...options.input, blocks: [
    { ordinal: 1, type: "paragraph", text: "复合索引缺少最左列条件就无法使用索引。" },
    { ordinal: 2, type: "paragraph", text: "先遮住答案，再从记忆中回想。" },
  ] } });
  const selected = selectGroundedRoundTarget(target, report.report);
  assert.equal(report.approved, false, "the original mixed target is not wholly approved");
  assert.deepEqual(selected?.target.units.map((candidate) => candidate.unitId), ["unit-2"]);
  assert.equal(selected?.target.objectiveStatement.includes("复合索引"), false);
  assert.deepEqual(selected?.report.units.map((candidate) => candidate.unitId), ["unit-2"]);
  assert.deepEqual(selected?.report.suspectClaims[0].unitIds, ["unit-1"]);
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
