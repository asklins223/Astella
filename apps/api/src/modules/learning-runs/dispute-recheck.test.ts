/**
 * 争议系统侧复核生产者的**纯函数与入口形状**判据（39d W5-5；39 §8.6、§14.2）。
 *
 * 这里只放**不需要数据库**就能量的那几件——正是它们最容易被"接上真实库之后
 * 一切照过"盖掉：
 *
 *  1. **提示里没有原判**（§8.6「不得把同一次生成的自评直接当成独立评估」）。这一格
 *     红得最难看：把 `originalVerdicts` 顺手塞进提示词，模型就会照着原判改几个字，
 *     复核照样"跑成功"、照样落库、照样有理由——只是它不再是独立评估，而**没有任何
 *     其它判据会红**。
 *  2. **strict 解析**：逐条 id 与冻结闭包对不上就 fail closed（不补造）。
 *  3. **provider 没配时安静地跳过**，而不是抛错或"猜一个结论"（§14.2 的出口是用户
 *     自己结束争议；把 provider 故障说成"已复核"是最坏的误报）。
 *
 * 真库那一半（一次复核真的落库、更正只追加不重写原判、模型调用时**没有活动事务**、
 * 第二次不花钱）在 `dispute-recheck-postgres.integration.ts`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPUTE_RECHECK_TASK_ID,
  buildDisputeRecheckPrompt,
  disputeRecheckInputHashV2,
  parseDisputeRecheckReport,
  runDisputeRecheckV2,
  DisputeRecheckOutputError,
  type DisputeRecheckFactsV2,
} from "./dispute-recheck.ts";

function factsOf(over: Partial<DisputeRecheckFactsV2> = {}): DisputeRecheckFactsV2 {
  return {
    assessmentId: "3b0f1a52-0000-4000-8000-0000000000bb",
    disputeId: "3b0f1a52-0000-4000-8000-0000000000aa",
    disputeKind: "misunderstood",
    disputeStatement: "我第一次就写了回表那一步，不该判成没提到。",
    disputeSupplement: null,
    objectiveStatement: "说清索引的成本在哪一段",
    canonicalAnswerUnits: [{ unitId: "u1", text: "回表要再读一次聚簇索引之外的页" }],
    rubricUnits: [
      { rubricUnitId: "ru1", criterion: "答案里明确提到回表", facet: "recall", required: true },
      { rubricUnitId: "ru2", criterion: "答案里说到二级索引与主键列的差别", facet: "apply", required: false },
    ],
    evidenceRefs: [{ evidenceSnapshotHash: "a".repeat(64), preview: "二级索引只存主键列" }],
    taskIntent: "explain",
    taskPrompt: "为什么加索引仍然可能慢？",
    artifactText: "因为二级索引查到主键之后还要回表再读一次行。",
    snapshotHash: "s".repeat(64),
    originalVerdicts: [
      { rubricItemId: "ru1", verdict: "missing" },
      { rubricItemId: "ru2", verdict: "covered" },
    ],
    originalReportHash: "r".repeat(64),
    ...over,
  };
}

test("§8.6：提示词里没有原判的逐条结果——复核者必须自己判，而不是照着原判改写", () => {
  // 探针用**不可能来自 critic 枚举**的取值。不能用 `missing`／`covered` 本身去查：
  // 那两个词合法地出现在"判定规则"与输出合同里（枚举本身要给模型看），那种断言会
  // 恒红或者恒绿，两种都不量任何东西。而"原判被塞进提示词"这件事唯一可靠的指纹是
  // **原判那一列的取值本身出现在提示里**——给一个独特取值，它出现就说明被插值了。
  const facts = factsOf({
    originalVerdicts: [
      { rubricItemId: "ru1", verdict: "ORIGINAL_ONLY_MISSING" },
      { rubricItemId: "ru2", verdict: "ORIGINAL_ONLY_COVERED" },
    ],
  });
  const prompt = buildDisputeRecheckPrompt(facts);
  assert.ok(prompt.includes("ru1"), "正控制：评分条件 id 要在提示里（那是复核的参照物）");
  assert.ok(prompt.includes("covered"), "正控制：判定规则本身要给模型看");
  assert.ok(
    !prompt.includes("ORIGINAL_ONLY_MISSING") && !prompt.includes("ORIGINAL_ONLY_COVERED"),
    "提示里带上了原判的逐条判定：复核者会照着原判改写，那不是独立评估（§8.6）",
  );
  assert.ok(!prompt.includes(facts.originalReportHash!), "提示里带上了原判的 report_hash");
});

test("§14.2：提示词带着原题、原回答和依据这三样入参", () => {
  const facts = factsOf();
  const prompt = buildDisputeRecheckPrompt(facts);
  assert.ok(prompt.includes("为什么加索引仍然可能慢？"), "原题缺席");
  assert.ok(prompt.includes("因为二级索引查到主键之后还要回表再读一次行。"), "原回答缺席");
  assert.ok(prompt.includes("二级索引只存主键列"), "依据缺席");
  // 用户的异议理由也要给：四种 kind 要去核的方向不同（§14.2）。
  assert.ok(prompt.includes("我第一次就写了回表那一步"));
  assert.ok(prompt.includes(facts.disputeKind));
  // 补充说明有值时出现。
  assert.ok(buildDisputeRecheckPrompt(factsOf({ disputeSupplement: "我说的不是没有回表。" }))
    .includes("我说的不是没有回表。"));
});

test("任务身份与评估那条不同：§8.6 的「分开的任务上下文」从 id 开始", () => {
  // 两条任务共用量、连检查点键。id 一样就等于同一次任务，检查点会互相命中。
  assert.equal(DISPUTE_RECHECK_TASK_ID, "dispute_recheck");
  assert.notEqual(DISPUTE_RECHECK_TASK_ID, "assessment_critic");
});

test("strict 解析：逐条 id 与冻结闭包对不上就 fail closed（不补造、不猜）", () => {
  const good = JSON.stringify({
    outcome: "corrected",
    reason: "原回答确实写到了回表那一步。",
    verdicts: [
      { rubricItemId: "ru1", verdict: "covered", unitReason: "写了回表。" },
      { rubricItemId: "ru2", verdict: "covered", unitReason: "也说了差别。" },
    ],
  });
  assert.equal(parseDisputeRecheckReport(good, ["ru1", "ru2"]).outcome, "corrected");

  // 少一条 / 多一条 / 重复 / 未知 id / 不是 JSON / 未知枚举：全部拒。
  for (const [raw, expected] of [
    [JSON.stringify({ outcome: "upheld", reason: "x", verdicts: [{ rubricItemId: "ru1", verdict: "covered", unitReason: "y" }] }), "missing verdict"],
    [JSON.stringify({ outcome: "upheld", reason: "x", verdicts: [
      { rubricItemId: "ru1", verdict: "covered", unitReason: "y" },
      { rubricItemId: "ru2", verdict: "covered", unitReason: "y" },
      { rubricItemId: "ru9", verdict: "covered", unitReason: "y" },
    ] }), "unknown rubricItemId"],
    [JSON.stringify({ outcome: "upheld", reason: "x", verdicts: [
      { rubricItemId: "ru1", verdict: "covered", unitReason: "y" },
      { rubricItemId: "ru1", verdict: "missing", unitReason: "y" },
    ] }), "duplicate rubricItemId"],
    ["not json at all", "not valid JSON"],
    [JSON.stringify({ outcome: "upheld", reason: "x", verdicts: [
      { rubricItemId: "ru1", verdict: "probably", unitReason: "y" },
      { rubricItemId: "ru2", verdict: "covered", unitReason: "y" },
    ] }), "schema mismatch"],
  ] as const) {
    assert.throws(
      () => parseDisputeRecheckReport(raw, ["ru1", "ru2"]),
      (error: unknown) => error instanceof DisputeRecheckOutputError && error.message.includes(expected),
      `这一种错法必须 fail closed：${expected}`,
    );
  }
  // 闭包本身是空的 ⇒ 连"该收几条"都判不出来。
  assert.throws(() => parseDisputeRecheckReport(good, []), DisputeRecheckOutputError);
});

test("输入快照哈希对原回答与依据敏感（换一句话就换一个哈希）", () => {
  const base = disputeRecheckInputHashV2(factsOf());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(base, disputeRecheckInputHashV2(factsOf({ artifactText: "换一句回答" })));
  assert.notEqual(base, disputeRecheckInputHashV2(factsOf({ taskPrompt: "换一道题" })));
  assert.notEqual(base, disputeRecheckInputHashV2(factsOf({ disputeStatement: "换一个理由" })));
});

test("provider 没配时安静跳过：一个数据库查询都不发，也不抛错", async () => {
  // 真控制：它必须在**碰数据库之前**返回。夹具里没有 DATABASE_URL 时任何查询都会
  // 抛连接错误，而这一条要绿——所以"没配就跳过"这件事必须是纯配置判定。
  const previous = {
    url: process.env.ASSESSMENT_CRITIC_URL,
    key: process.env.ASSESSMENT_CRITIC_KEY,
    model: process.env.ASSESSMENT_CRITIC_MODEL,
    fallback: process.env.DASHSCOPE_API_KEY,
  };
  process.env.ASSESSMENT_CRITIC_URL = "";
  process.env.ASSESSMENT_CRITIC_KEY = "";
  process.env.DASHSCOPE_API_KEY = "";
  try {
    const result = await runDisputeRecheckV2(
      { currentActiveTransaction: () => undefined, url: " ", key: " " },
      { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID(), assessmentId: crypto.randomUUID() },
    );
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") assert.equal(result.reasonCode, "provider_not_configured");
  } finally {
    for (const [name, value] of [
      ["ASSESSMENT_CRITIC_URL", previous.url],
      ["ASSESSMENT_CRITIC_KEY", previous.key],
      ["ASSESSMENT_CRITIC_MODEL", previous.model],
      ["DASHSCOPE_API_KEY", previous.fallback],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
