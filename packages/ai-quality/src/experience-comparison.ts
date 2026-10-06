/**
 * 方案 44 §8.5：有/无相关经验的同批对照。
 *
 * ## 为什么先写「拒绝下结论」的部分
 *
 * 这类报告最容易出的不是算错，而是**在样本撑不住的时候照样给出一个方向**：
 *   - 两组的任务不是同一批 → 难度不可比，却读成「有经验更好」；
 *   - 用量缺失一半 → 成本那一栏其实是「有数据的那些」，却读成总体成本；
 *   - 完成范围不同 → 一组多做了几道，却读成通过率提升；
 *   - 冷启动与持续使用混在一起 → 那是两个不同的问题（§8.5 要求分开）。
 * 所以 `summarizeExperienceComparison` 在给出任何差值之前，先判这些条件，
 * 判不过就把结论标成 `unsupported` 并说明原因，而不是照样输出一个数字。
 *
 * ## 它不做什么
 *
 * 不做语义判断、不读模型自评、不把「沉默」「停留」「点击」「落库成功」算成好评
 * （§6.3／§8.5）。这些字段在这里根本没有位置——不是忘了加。
 */

export type ExperienceArmV1 = "without_experience" | "with_experience";

/** 对照的两种观察对象，**必须分开报**（§8.5）。 */
export type ExperienceObservationV1 = "cold_start" | "continuous_use";

export interface ExperienceComparisonSampleV1 {
  /** 同一道任务在两个臂里用同一个 id——这是「同批」的唯一凭据。 */
  taskId: string;
  /**
   * §8.5 的哪个场景（公式条件保留 / 讲解偏好 / 本次例外 / 新材料复用 / 失败替代 / 撤回）。
   * 带着它出报告，才能说清「这批样本覆盖了 §8.5 点名的哪些场景、漏了哪些」。
   */
  scenario?: string;
  /** 这一题的评阅标准——随样本一起流转，别留在评审者脑子里。 */
  rubric?: string;
  arm: ExperienceArmV1;
  observation: ExperienceObservationV1;
  /** 模型路由：换过模型就不是同一次对照。 */
  providerId: string;
  modelId: string;
  promptVersion: string;
  /** 这一臂实际用到的方法版本；无经验臂为空数组。 */
  methodVersions: string[];
  /** 冻结材料版本；不同材料不算同一道题。 */
  materialRef: string;
  difficulty: string;
  /**
   * 各项质量读数：**没测到就是 null，不是 0**。
   *
   * §8.5 要求「样本与缺失用量公开」。把没测到的记成 0 会让报告看起来「一次都没出错」，
   * 而事实是这一项根本没评。所以每项都允许 null，汇总时单独报测到了多少条。
   */
  contentErrors: number | null;
  sameClassRework: number | null;
  repeatedExplanations: number | null;
  invalidToolCalls: number | null;
  /** 压缩语义损失：只有真的发生过折叠才测得到，没折叠的样本这里是 null。 */
  compactionSemanticLoss: number | null;
  /** 这次是否真的完成了任务范围（用来判两组是否可比）。 */
  taskCompleted: boolean;
  waitMs: number | null;
  costTokens: number | null;
}

/** 汇总时用的门槛。默认值刻意保守：样本不够时宁可不说。 */
export interface ExperienceComparisonPolicyV1 {
  /** 每臂最少样本数。 */
  minSamplesPerArm: number;
  /** 用量缺失占比超过它，成本与等待就不给结论。 */
  maxMissingUsageRatio: number;
}

export const DEFAULT_EXPERIENCE_COMPARISON_POLICY: ExperienceComparisonPolicyV1 = {
  minSamplesPerArm: 8,
  maxMissingUsageRatio: 0.1,
};

/** 方案 44 §8.5 明写「至少覆盖」的场景。报告按这个清单核对，不按样本里有什么算什么。 */
export const REQUIRED_SCENARIOS: readonly string[] = [
  "S1_formula_condition", "S2_explanation_preference", "S3_this_time_exception",
  "S4_new_material_reuse", "S5_failure_alternative", "S6_retraction",
];

/** 一项质量读数的汇总：和值之外还要给出**测到了多少条**。 */
export interface ExperienceMetricSummaryV1 {
  /** 有读数的样本数。 */
  measured: number;
  /** 这些样本的和；measured 为 0 时是 null，而不是 0。 */
  total: number | null;
  /** 均值；measured 为 0 时是 null。 */
  mean: number | null;
}

export interface ExperienceArmSummaryV1 {
  arm: ExperienceArmV1;
  samples: number;
  completed: number;
  contentErrors: ExperienceMetricSummaryV1;
  sameClassRework: ExperienceMetricSummaryV1;
  repeatedExplanations: ExperienceMetricSummaryV1;
  invalidToolCalls: ExperienceMetricSummaryV1;
  compactionSemanticLoss: ExperienceMetricSummaryV1;
  /** 只统计有读数的样本；缺失量单独报。 */
  meanWaitMs: number | null;
  meanCostTokens: number | null;
  missingUsage: number;
}

export type ExperienceClaimOutcomeV1 = "supported" | "unsupported";

/** 报告里每个指标的**测到多少条**——缺测不会被写成 0。 */
export interface ExperienceCoverageV1 {
  arm: ExperienceArmV1;
  samples: number;
  measured: Record<string, number>;
}

export interface ExperienceComparisonReportV1 {
  observation: ExperienceObservationV1;
  policy: ExperienceComparisonPolicyV1;
  arms: ExperienceArmSummaryV1[];
  /** 每一项各测到多少条；缺失公开（§8.5）。 */
  coverage: ExperienceCoverageV1[];
  /**
   * §8.5 点名「至少覆盖」的场景里，这一批**覆盖了哪些、漏了哪些**。
   *
   * 漏了不说，报告就会读成「整体改善」——而它其实只在最容易的那两个场景上成立。
   */
  scenarioCoverage: { covered: string[]; missing: string[] };
  /** 判定为可比较时才给差值；否则为 null。 */
  deltas: Record<string, number> | null;
  outcome: ExperienceClaimOutcomeV1;
  /** 为什么不能下结论；outcome 为 supported 时为空。 */
  refusals: string[];
  /**
   * 这份报告**没有**证明的东西。固定带上，避免被当成成长成绩 (§8.5)。
   */
  notShown: string[];
}

const METRIC_KEYS = [
  "contentErrors", "sameClassRework", "repeatedExplanations",
  "invalidToolCalls", "compactionSemanticLoss",
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

function summarizeMetric(
  samples: readonly ExperienceComparisonSampleV1[],
  key: MetricKey,
): ExperienceMetricSummaryV1 {
  const values = samples.flatMap(sample => (sample[key] === null ? [] : [sample[key] as number]));
  if (values.length === 0) return { measured: 0, total: null, mean: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { measured: values.length, total, mean: total / values.length };
}

const NOT_SHOWN = [
  "它不证明「越用越好」：样本内的差值只是这一次对照的读数。",
  "它不把使用次数、记忆条数、输入变短当作改善——那些不是质量。",
  "它不用模型自评、沉默、停留、点击或落库成功当正反馈。",
];

function summarizeArm(samples: readonly ExperienceComparisonSampleV1[], arm: ExperienceArmV1): ExperienceArmSummaryV1 {
  const own = samples.filter(sample => sample.arm === arm);
  const waits = own.flatMap(sample => (sample.waitMs === null ? [] : [sample.waitMs]));
  const costs = own.flatMap(sample => (sample.costTokens === null ? [] : [sample.costTokens]));
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    arm,
    samples: own.length,
    completed: own.filter(sample => sample.taskCompleted).length,
    contentErrors: summarizeMetric(own, "contentErrors"),
    sameClassRework: summarizeMetric(own, "sameClassRework"),
    repeatedExplanations: summarizeMetric(own, "repeatedExplanations"),
    invalidToolCalls: summarizeMetric(own, "invalidToolCalls"),
    compactionSemanticLoss: summarizeMetric(own, "compactionSemanticLoss"),
    meanWaitMs: mean(waits),
    meanCostTokens: mean(costs),
    missingUsage: own.length - costs.length,
  };
}

/**
 * 汇总一次对照。
 *
 * 先判可比性，再给差值。判不过时 `deltas` 是 null——**没有数字**比一个误导的数字好。
 */
export function summarizeExperienceComparison(
  samples: readonly ExperienceComparisonSampleV1[],
  input: {
    observation: ExperienceObservationV1;
    policy?: ExperienceComparisonPolicyV1;
  },
): ExperienceComparisonReportV1 {
  const policy = input.policy ?? DEFAULT_EXPERIENCE_COMPARISON_POLICY;
  // 冷启动与持续使用是两个不同的问题，混在一起算出来的差值没有意义。
  const scoped = samples.filter(sample => sample.observation === input.observation);
  const arms = [summarizeArm(scoped, "without_experience"), summarizeArm(scoped, "with_experience")];
  const refusals: string[] = [];

  for (const arm of arms) {
    if (arm.samples < policy.minSamplesPerArm) {
      refusals.push(
        `${arm.arm} 只有 ${arm.samples} 个样本（门槛 ${policy.minSamplesPerArm}），差值不稳。`,
      );
    }
  }

  const withoutTasks = new Set(scoped.filter(s => s.arm === "without_experience").map(s => s.taskId));
  const withTasks = new Set(scoped.filter(s => s.arm === "with_experience").map(s => s.taskId));
  const onlyOne = [...withTasks].filter(id => !withoutTasks.has(id));
  const onlyOther = [...withoutTasks].filter(id => !withTasks.has(id));
  if (withoutTasks.size > 0 && withTasks.size > 0 && (onlyOne.length > 0 || onlyOther.length > 0)) {
    refusals.push(
      `两组不是同一批任务（仅「有经验」有 ${onlyOne.length} 道、仅「无经验」有 ${onlyOther.length} 道），难度不可比。`,
    );
  }

  // 完成任务范围不同时，通过率之类的读数不可比（§8.5「维持可比的任务完成范围」）。
  if (arms[0]!.samples > 0 && arms[1]!.samples > 0) {
    const ratioWithout = arms[0]!.completed / arms[0]!.samples;
    const ratioWith = arms[1]!.completed / arms[1]!.samples;
    if (Math.abs(ratioWithout - ratioWith) > 0.2) {
      refusals.push(
        `两组的完成范围差得太多（${Math.round(ratioWithout * 100)}% vs ${Math.round(ratioWith * 100)}%），`
        + "质量读数不在同一件事上。",
      );
    }
  }

  // 路由/提示词/材料不一致时，差值可能来自这些东西，而不是经验。
  for (const key of ["providerId", "modelId", "promptVersion"] as const) {
    const values = new Set(scoped.map(sample => sample[key]));
    if (values.size > 1) refusals.push(`两组的 ${key} 不一致（${[...values].join(" / ")}），差值不归因于经验。`);
  }
  const materials = new Map<string, Set<string>>();
  for (const sample of scoped) {
    const set = materials.get(sample.taskId) ?? new Set<string>();
    set.add(sample.materialRef);
    materials.set(sample.taskId, set);
  }
  const drifted = [...materials.entries()].filter(([, set]) => set.size > 1).map(([taskId]) => taskId);
  if (drifted.length > 0) refusals.push(`有 ${drifted.length} 道题两组用的材料版本不同，不是同一次对照。`);

  // 用量缺失太多时，成本与等待不给结论；质量指标不受影响。
  const total = scoped.length;
  const missing = arms[0]!.missingUsage + arms[1]!.missingUsage;
  const usageUsable = total > 0 && missing / total <= policy.maxMissingUsageRatio;
  if (!usageUsable && total > 0) {
    refusals.push(`用量缺失 ${missing}/${total}，成本与等待不给结论。`);
  }

  // 没测到的项要单独说：报告里出现一个「0 次内容错误」而其实根本没评，就是在骗人。
  const unmeasured: string[] = [];
  for (const key of METRIC_KEYS) {
    if (arms[0]![key].measured < arms[0]!.samples || arms[1]![key].measured < arms[1]!.samples) {
      const measured = arms[0]![key].measured + arms[1]![key].measured;
      const expected = arms[0]!.samples + arms[1]!.samples;
      if (expected > 0 && measured < expected) unmeasured.push(`${key}（${measured}/${expected} 条有读数）`);
    }
  }
  if (unmeasured.length > 0) refusals.push(`这些指标没测全，不给差值：${unmeasured.join("、")}。`);

  let deltas: Record<string, number> | null = null;
  if (refusals.length === 0) {
    const without = arms[0]!;
    const withExperience = arms[1]!;
    deltas = {};
    for (const key of METRIC_KEYS) {
      const left = without[key];
      const right = withExperience[key];
      // 两边都测到了才给差值：一边没测时的「差值」是拿 0 当读数算出来的。
      if (left.total === null || right.total === null) continue;
      deltas[key] = right.total - left.total;
    }
    if (usageUsable) {
      if (without.meanCostTokens !== null && withExperience.meanCostTokens !== null) {
        deltas.meanCostTokens = withExperience.meanCostTokens - without.meanCostTokens;
      }
      if (without.meanWaitMs !== null && withExperience.meanWaitMs !== null) {
        deltas.meanWaitMs = withExperience.meanWaitMs - without.meanWaitMs;
      }
    }
  }

  const seen = new Set(scoped.map(sample => sample.scenario).filter((value): value is string => Boolean(value)));
  const scenarioCoverage = {
    covered: REQUIRED_SCENARIOS.filter(scenario => seen.has(scenario)),
    missing: REQUIRED_SCENARIOS.filter(scenario => !seen.has(scenario)),
  };
  // 场景缺口**不**直接判死结论（样本本来就少），但必须被说出来。
  if (scenarioCoverage.missing.length > 0) {
    refusals.push(
      `§8.5 要求至少覆盖的场景里，这一批没有：${scenarioCoverage.missing.join("、")}。`,
    );
  }

  return {
    observation: input.observation,
    policy,
    arms,
    scenarioCoverage,
    coverage: arms.map(arm => ({
      arm: arm.arm,
      samples: arm.samples,
      measured: Object.fromEntries(METRIC_KEYS.map(key => [key, arm[key].measured])),
    })),
    deltas,
    outcome: refusals.length === 0 ? "supported" : "unsupported",
    refusals,
    notShown: NOT_SHOWN,
  };
}
