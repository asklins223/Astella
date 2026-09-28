import assert from "node:assert/strict";
import test from "node:test";
import { decideRoundNextStep } from "./round-progression.ts";

const runId = "44444444-4444-4444-8444-444444444444";
const baseline = {
  roundPhase: "active" as const,
  hasTeaching: true,
  hasTarget: true,
  canStartPractice: true,
  transferSuitable: true,
  gapHelpStopped: false,
  teachingCreatedAt: "2026-09-28T08:00:00.000Z",
  latestPractice: null,
};
const observed = {
  runId,
  phase: "completed" as const,
  goal: "stabilize" as const,
  outcome: "partial" as const,
  gapFacets: ["apply" as const],
  gapFacetsKnown: true,
  updatedAt: "2026-09-28T08:10:00.000Z",
};

test("无目标时不能把无卡笔记的输入句冒充先试题", () => {
  assert.equal(decideRoundNextStep({ ...baseline, hasTeaching: false, hasTarget: false }).kind, "explain");
  assert.equal(decideRoundNextStep({ ...baseline, hasTarget: false }).kind, "review_material");
});

test("未练时给一次尝试，未结算时继续既有练习", () => {
  assert.equal(decideRoundNextStep(baseline).kind, "attempt");
  const inFlight = decideRoundNextStep({ ...baseline,
    latestPractice: { ...observed, phase: "assessing", outcome: null },
  });
  assert.deepEqual([inFlight.kind, inFlight.basisRunId], ["resume", runId]);
});

test("真实缺口给针对帮助；帮助后才建议再试；重复无改善时停止自动推进", () => {
  const help = decideRoundNextStep({ ...baseline, latestPractice: observed });
  assert.deepEqual([help.kind, help.gapFacets, help.evidence], ["help", ["apply"], "incomplete"]);
  assert.equal(decideRoundNextStep({ ...baseline, teachingCreatedAt: "2026-09-28T08:11:00.000Z",
    latestPractice: observed }).kind, "retry");
  assert.equal(decideRoundNextStep({ ...baseline, gapHelpStopped: true,
    latestPractice: observed }).kind, "choose");
});

test("覆盖练习只作为练习证据；适用时再做应用，完成应用才收口", () => {
  const covered = { ...observed, outcome: "practice_completed" as const, gapFacets: [] };
  const next = decideRoundNextStep({ ...baseline, latestPractice: covered });
  assert.deepEqual([next.kind, next.evidence], ["apply", "practice_covered"]);
  assert.equal(decideRoundNextStep({ ...baseline, transferSuitable: false, latestPractice: covered }).kind, "finish");
  assert.equal(decideRoundNextStep({ ...baseline, latestPractice: { ...covered, goal: "transfer" } }).kind, "finish");
  assert.equal(decideRoundNextStep({ ...baseline, latestPractice: { ...covered, gapFacetsKnown: false } }).kind,
    "uncertain", "缺少结构化评分细节不能把历史练习冒充已覆盖");
});

test("系统判不了不算缺口；关闭与暂停不再签下一道", () => {
  const uncertain = decideRoundNextStep({ ...baseline, latestPractice: {
    ...observed, outcome: "not_assessable", gapFacets: [],
  } });
  assert.deepEqual([uncertain.kind, uncertain.gapFacets, uncertain.evidence], ["uncertain", [], "unassessable"]);
  assert.equal(decideRoundNextStep({ ...baseline, roundPhase: "paused" }).kind, "choose");
  assert.equal(decideRoundNextStep({ ...baseline, roundPhase: "closed" }).kind, "finish");
  const closed = decideRoundNextStep({ ...baseline, roundPhase: "closed", latestPractice: observed });
  assert.deepEqual([closed.kind, closed.evidence, closed.gapFacets], ["finish", "incomplete", ["apply"]]);
});
