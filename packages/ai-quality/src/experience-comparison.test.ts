import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeExperienceComparison,
  DEFAULT_EXPERIENCE_COMPARISON_POLICY,
  type ExperienceComparisonSampleV1,
} from "./experience-comparison.ts";

/**
 * 方案 44 §8.5：有/无相关经验的同批对照。
 *
 * 这里判的主要不是「算得对不对」，而是**样本撑不住时会不会照样给出方向**。
 * 那才是这类报告真实的失效方式：数字都对，结论是错的。
 */

const base = (over: Partial<ExperienceComparisonSampleV1> & Pick<ExperienceComparisonSampleV1, "taskId" | "arm">): ExperienceComparisonSampleV1 => ({
  observation: "cold_start",
  providerId: "openai_compatible",
  modelId: "qwen3.8-flash",
  promptVersion: "v1",
  methodVersions: [],
  materialRef: "note-version-1",
  difficulty: "standard",
  contentErrors: 0,
  sameClassRework: 0,
  repeatedExplanations: 0,
  invalidToolCalls: 0,
  compactionSemanticLoss: 0,
  taskCompleted: true,
  waitMs: 1_000,
  costTokens: 2_000,
  ...over,
});

/** 同批 n 道题、两臂各一遍；`with` 用来给「有经验」那一臂加差异。 */
function pairedStudy(n: number, withOver: Partial<ExperienceComparisonSampleV1> = {}) {
  const samples: ExperienceComparisonSampleV1[] = [];
  // 场景轮转铺满 §8.5 的清单：少了任何一个，报告会自己拒绝下结论——
  // 那样这里的断言就变成在测「拒绝路径」而不是「差值路径」了。
  const scenarios = [
    "S1_formula_condition", "S2_explanation_preference", "S3_this_time_exception",
    "S4_new_material_reuse", "S5_failure_alternative", "S6_retraction",
  ];
  for (let index = 0; index < n; index += 1) {
    const shared = {
      materialRef: `note-version-${index}`,
      difficulty: index % 3 === 0 ? "hard" : "standard",
      scenario: scenarios[index % scenarios.length]!,
      rubric: "这题的评阅标准",
    };
    samples.push(base({ taskId: `task-${index}`, arm: "without_experience", ...shared }));
    samples.push(base({ taskId: `task-${index}`, arm: "with_experience", methodVersions: ["m@3"], ...shared, ...withOver }));
  }
  return samples;
}

test("44 §8.5：样本充足且同批时给出差值，并带上「没有证明什么」", () => {
  const report = summarizeExperienceComparison(
    pairedStudy(10, { contentErrors: -1, sameClassRework: -1 }),
    { observation: "cold_start" },
  );
  assert.equal(report.outcome, "supported");
  assert.deepEqual(report.refusals, []);
  assert.equal(report.deltas?.contentErrors, -10);
  assert.equal(report.deltas?.sameClassRework, -10);
  // 「输入变短/记忆变多不算改善」这句话必须固定在场，否则报告会被当成成长成绩。
  assert.ok(report.notShown.some(line => line.includes("不把使用次数、记忆条数、输入变短当作改善")));
  assert.ok(report.notShown.some(line => line.includes("不证明「越用越好」")));
});

test("44 §8.5：样本不够就不下结论，而且说清差在哪", () => {
  const report = summarizeExperienceComparison(pairedStudy(3), { observation: "cold_start" });
  assert.equal(report.outcome, "unsupported");
  assert.equal(report.deltas, null, "没有数字比一个误导的数字好");
  // 不写死条数：3 道题既不够每臂 8 条，也盖不满 §8.5 的六个场景——
  // 多出来的拒绝是**对的**，写死 2 反而会让「场景缺口」这条判据没法加进来。
  const sizeRefusals = report.refusals.filter(line =>
    line.includes(`门槛 ${DEFAULT_EXPERIENCE_COMPARISON_POLICY.minSamplesPerArm}`));
  assert.equal(sizeRefusals.length, 2, "两臂各一条样本不足");
  assert.ok(report.refusals.some(line => line.includes("§8.5 要求至少覆盖的场景")),
    "3 道题盖不满六个场景，必须说出来——否则报告会被读成整体改善");
  assert.deepEqual(report.scenarioCoverage.missing.length > 0, true);
});

test("44 §8.5：两组不是同一批任务时拒绝比较——难度不可比", () => {
  const samples = [
    ...pairedStudy(10),
    base({ taskId: "extra-only-with", arm: "with_experience" }),
    base({ taskId: "extra-only-with", arm: "with_experience", methodVersions: ["m@3"] }),
  ];
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.equal(report.outcome, "unsupported");
  assert.ok(report.refusals.some(line => line.includes("不是同一批任务")));
});

test("44 §8.5：完成范围差太多时，质量读数不在同一件事上", () => {
  const samples = pairedStudy(10).map(sample =>
    sample.arm === "with_experience" && sample.taskId !== "task-0"
      ? { ...sample, taskCompleted: false }
      : sample);
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.equal(report.outcome, "unsupported");
  assert.ok(report.refusals.some(line => line.includes("完成范围差得太多")));
});

test("44 §8.5：路由或提示词变了，差值不归因于经验", () => {
  const samples = pairedStudy(10).map(sample =>
    sample.arm === "with_experience" ? { ...sample, modelId: "另一个模型" } : sample);
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.equal(report.outcome, "unsupported");
  assert.ok(report.refusals.some(line => line.includes("modelId 不一致")));
});

test("44 §8.5：同一道题两组材料版本不同，就不是同一次对照", () => {
  const samples = pairedStudy(10).map(sample =>
    sample.arm === "with_experience" && sample.taskId === "task-4"
      ? { ...sample, materialRef: "note-version-4-改过" }
      : sample);
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.equal(report.outcome, "unsupported");
  assert.ok(report.refusals.some(line => line.includes("材料版本不同")));
});

test("44 §8.5：用量缺失太多时，成本与等待不给结论", () => {
  const samples = pairedStudy(10).map((sample, index) =>
    index % 2 === 0 ? { ...sample, waitMs: null, costTokens: null } : sample);
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  const usageRefusal = report.refusals.find(line => line.includes("成本与等待不给结论"));
  assert.ok(usageRefusal, "缺失一半还报成本，那一栏其实是「有数据的那些」");
  // 质量指标不受影响，所以缺失本身不该把整份报告判死——但它确实进了 refusals，
  // 于是 outcome 仍是 unsupported：这一版宁可只给「能说的那部分」也不给差值。
  assert.equal(report.outcome, "unsupported");
  assert.equal(report.arms[0]!.missingUsage, 10);
});

test("44 §8.5：冷启动与持续使用分开报，不混在一起算", () => {
  const samples = [
    ...pairedStudy(10),
    ...pairedStudy(10).map(sample => ({ ...sample, observation: "continuous_use" as const, taskId: `长期-${sample.taskId}` })),
  ];
  const cold = summarizeExperienceComparison(samples, { observation: "cold_start" });
  const continuous = summarizeExperienceComparison(samples, { observation: "continuous_use" });
  assert.equal(cold.arms[0]!.samples, 10);
  assert.equal(continuous.arms[0]!.samples, 10);
  assert.equal(cold.observation, "cold_start");
  // 合成一份也没有意义：那是两个不同的问题。
  const both = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.notEqual(both.arms[0]!.samples, 20);
});

test("44 §6.3：报告结构里没有「模型自评／沉默／点击」的位置", () => {
  const report = summarizeExperienceComparison(pairedStudy(10), { observation: "cold_start" });
  const keys = new Set(Object.keys(report.arms[0]!));
  for (const forbidden of ["selfRating", "engagement", "clicks", "silence", "writeSuccess"]) {
    assert.ok(!keys.has(forbidden), `${forbidden} 不该出现在质量读数里`);
  }
});

// ─── 44 §8.5：没测到的项不许写成 0 ─────────────────────────────────────────

test("44 §8.5：没测到的指标是 null，不是 0——「0 次错误」与「没评过」不是一件事", () => {
  const samples = pairedStudy(10).map(sample => ({
    ...sample,
    compactionSemanticLoss: null as number | null,
  }));
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  const arm = report.arms[0]!;
  assert.equal(arm.compactionSemanticLoss.measured, 0);
  assert.equal(arm.compactionSemanticLoss.total, null, "没测到就是 null；写 0 会读成「一次都没丢」");
  assert.equal(arm.compactionSemanticLoss.mean, null);
  // 缺测要公开，而且不能给出那一项的差值。
  assert.ok(report.refusals.some(line => line.includes("compactionSemanticLoss")));
  assert.equal(report.deltas, null);
});

test("44 §8.5：测全了才给差值，并且覆盖率逐项公开", () => {
  const report = summarizeExperienceComparison(
    pairedStudy(10, { contentErrors: -1 }),
    { observation: "cold_start" },
  );
  assert.equal(report.coverage.length, 2);
  assert.equal(report.coverage[0]!.measured.contentErrors, 10);
  assert.equal(report.coverage[0]!.measured.compactionSemanticLoss, 10);
  assert.equal(report.deltas?.contentErrors, -10);
});

test("44 §8.5：只有一边没测到时也不给那一项的差值", () => {
  const samples = pairedStudy(10).map(sample =>
    sample.arm === "with_experience" ? { ...sample, repeatedExplanations: null as number | null } : sample);
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.equal(report.deltas, null);
  assert.ok(report.refusals.some(line => line.includes("repeatedExplanations（10/20 条有读数）")));
});

test("44 §8.5：场景缺口单独可见——漏了就说，别让报告读成整体改善", () => {
  // 只铺 S1/S2 两个场景，其余四个没样本。
  const samples = pairedStudy(12).map((sample, index) => ({
    ...sample,
    scenario: index % 2 === 0 ? "S1_formula_condition" : "S2_explanation_preference",
  }));
  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  assert.deepEqual(report.scenarioCoverage.covered, ["S1_formula_condition", "S2_explanation_preference"]);
  assert.ok(report.scenarioCoverage.missing.includes("S5_failure_alternative"));
  assert.ok(report.refusals.some(line => line.includes("S5_failure_alternative")));
});
