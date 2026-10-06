import assert from "node:assert/strict";
import { test } from "node:test";
import { buildArmRequest } from "../../scripts/experience-comparison-runner.ts";

/**
 * 方案 44 §8.5：有/无经验的对照里，**两臂只能差「经验」这一件事**。
 *
 * 这条不变量最容易悄悄破掉：为了「让有经验那臂更好发挥」顺手改一句措辞、补一条要求，
 * 差值就不再归因于经验。它不会报错，只会让整份对照失去意义——所以在这里钉住。
 */

const task = {
  id: "S1",
  scenario: "S1_formula_condition" as const,
  rubric: "公式的适用条件有没有被写出来。",
  goal: "把牛顿第二定律讲清楚，带上它的适用条件。",
  materialRef: "frozen-physics-01",
  difficulty: "standard" as const,
  turns: [{ user: "把牛顿第二定律讲清楚，带上它的适用条件。" }],
  methodCatalog: [{
    methodId: "11111111-1111-4111-8111-111111111101", revision: 2,
    title: "讲公式先说适用条件", appliesWhen: "涉及公式或定理的讲解时",
  }],
};

test("44 §8.5：两臂的用户消息一字不差", () => {
  const without = buildArmRequest({ task, arm: "without_experience", model: "m" });
  const withExperience = buildArmRequest({ task, arm: "with_experience", model: "m" });
  assert.deepEqual(withExperience.messages, without.messages);
  assert.equal(withExperience.messages[0]!.content, task.goal);
});

test("44 §8.5：偏好/例外/撤回这三个场景单轮判断不出来——题库必须按多轮铺", () => {
  const multi = buildArmRequest({
    task: {
      ...task,
      id: "S6", scenario: "S6_retraction",
      rubric: "撤回之后有没有继续沿用。",
      goal: "先按我刚才说的那个方式复习。",
      turns: [
        { user: "按每周一三五的节奏安排复习。" },
        { user: "一三五不行，改成二四六。刚才那条当我没说。" },
        { user: "那这周按什么安排？" },
      ],
    },
    arm: "without_experience", model: "m",
  });
  const users = multi.messages.filter(m => m.role === "user");
  assert.equal(users.length, 3, "三轮都要发出去——撤回类场景在第二轮才发生");
  assert.ok(users[2]!.content.includes("这周按什么安排"), "最后一轮必须是原始 goal");
});

test("44 §8.5：六道题逐条对上「至少覆盖」的场景清单，一个都不少", async () => {
  const { TASKS } = await import("../../scripts/experience-comparison-runner.ts");
  const { REQUIRED_SCENARIOS } = await import("@astella/ai-quality");
  const covered = new Set<string>(TASKS.map(entry => entry.scenario));
  const missing = (REQUIRED_SCENARIOS as readonly string[]).filter(scenario => !covered.has(scenario));
  assert.deepEqual(missing, [], `§8.5 点名的场景题库里缺：${missing.join("、")}`);
  // 每道题都必须自带评阅标准——只写在评审说明里，等于让不同人评出不同结论。
  for (const entry of TASKS) assert.ok(entry.rubric.length > 8, `${entry.id} 没有可执行的评阅标准`);
});

test("44 §8.5：无经验臂真的没有做法目录，有经验臂真的带上了", () => {
  const without = buildArmRequest({ task, arm: "without_experience", model: "m" });
  const withExperience = buildArmRequest({ task, arm: "with_experience", model: "m" });
  assert.ok(!without.systemPrompt.includes("<related_methods>"));
  assert.ok(withExperience.systemPrompt.includes("<related_methods>"));
  // 用的是制卡链路那一份渲染，不是另写一段「参考以下方法」。
  assert.ok(withExperience.systemPrompt.includes("讲公式先说适用条件"));
});

test("44 §8.5：除了目录，两臂的系统提示逐字相同", () => {
  const without = buildArmRequest({ task, arm: "without_experience", model: "m" });
  const withExperience = buildArmRequest({ task, arm: "with_experience", model: "m" });
  // 去掉目录块本身（连同它前后为排版加的空行），剩下的必须逐字相同。
  const strip = (text: string) =>
    text.replace(/\n*<related_methods>[\s\S]*?<\/related_methods>\n*/, "\n").trimEnd();
  assert.equal(strip(withExperience.systemPrompt), strip(without.systemPrompt),
    "两臂的差别必须只有做法目录；多一句要求就等于把差值归因给了那句话");
});

test("44 §8.5：任务不相关时目录为空——不给不相干的做法", () => {
  const unrelated = { ...task, goal: "今天天气怎么样？" };
  const request = buildArmRequest({ task: unrelated, arm: "with_experience", model: "m" });
  assert.ok(!request.systemPrompt.includes("<related_methods>"));
  // 这种情况下两臂其实是一样的，报告里应把它读成「这一题没给经验」，
  // 而不是「给了经验但没用」——判据在 selectRelevantMethods 的相关系数上。
  const without = buildArmRequest({ task: unrelated, arm: "without_experience", model: "m" });
  assert.equal(request.systemPrompt, without.systemPrompt);
});

test("44 §8.5：冷启动与持续使用是两次分开的跑，产物不会互相覆盖", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../scripts/experience-comparison-runner.ts", import.meta.url).pathname;
  // 不带 --real-model 会静默退出；这里只验**参数解析**与目录分流。
  for (const args of [["--observation=bogus"], ["--observation=continuous_use"]]) {
    // `--tsconfig` 是 **tsx** 的参数，不是 node 的——直接 `node --import tsx --tsconfig`
    // 会报 `bad option: --tsconfig`，那不是脚本在拒绝非法值（本测试的第一版就栽在这，
    // 差点把「跑不起来」当成「拒绝生效」）。
    const run = spawnSync(
      "npx", ["tsx", "--tsconfig", "tsconfig.json", script, ...args],
      { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" },
    );
    if (args[0] === "--observation=bogus") {
      assert.notEqual(run.status, 0, "非法 observation 必须被拒，不能默默按 cold_start 跑");
      assert.match(run.stderr, /--observation 只能是 cold_start 或 continuous_use/);
    }
  }
});
