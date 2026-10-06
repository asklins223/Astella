/**
 * 方案 44 §8.5：有/无**相关经验**的同批对照（真实模型，需凭据）。
 *
 * 与 `companion-persona-ab-eval.ts` 同一套闸门与形态：默认不跑，要显式打开。
 *
 * ```bash
 * cd workers/ai-worker
 * set -a; . ../../.env; set +a
 * REAL_MODEL_BATCH=1 AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *   npx tsx --tsconfig tsconfig.json scripts/experience-comparison-runner.ts --real-model
 * ```
 *
 * ## 它做的三件事
 *
 * 1. **冻结题库**：`TASKS` 是不可变的同批任务，两臂各跑一遍，任务 id 相同——
 *    `summarizeExperienceComparison` 会核对这一点，不同批直接拒绝比较。
 * 2. **两臂只差一件事**：无经验臂不带做法目录，有经验臂带上
 *    `renderMethodCatalogBlock` 的产出（与制卡链路同一份渲染，不是另写一段文字）。
 * 3. **如实记缺失**：没评的项记 `null` 而不是 0；用量拿不到就记 `null`。
 *    报告里会逐项报出「测到多少条」，缺测时不给那项差值。
 *
 * ## 它刻意不做的事
 *
 * - **不自动打分**。内容错误、同类返工、重复解释这些要人来看；脚本只产出样本与
 *   原始回答，评分字段留 `null` 并提示怎么填。自动打分等于让模型给自己判分，
 *   而 §6.3 明确不承认模型自评。
 * - **不把「回答变短」当成改善**。报告里固定带上这句话。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../src/lib/logger.ts";
import { AgentRole, COMPANION_CHARACTER_BASE_V7, COMPANION_HOST_PROTOCOL_V6, COMPANION_IDENTITY_BOUNDARY_V2 } from "@ailearn/shared";
import { summarizeExperienceComparison, type ExperienceComparisonSampleV1 } from "@ailearn/ai-quality";
import { renderMethodCatalogBlock, selectRelevantMethods } from "../src/agent/relevant-methods.ts";
import { resolveEvalProvider } from "../src/integration-tests/eval-provider.ts";

/** 冻结题库：两臂用同一批，改动要在这里留痕（新增 id，不改旧 id 的含义）。 */
interface ComparisonTask {
  id: string;
  /** 任务本身（用户那句话或任务描述）。 */
  goal: string;
  /** 这一批材料；两臂必须一致，否则对照不成立。 */
  materialRef: string;
  difficulty: "standard" | "hard";
  /** 冻结的做法目录——有经验臂按 goal 相关性从这里选。 */
  methodCatalog: Array<{ methodId: string; revision: number; title: string; appliesWhen: string }>;
}

/**
 * 冻结题库。§8.5 点名**至少覆盖五个场景**，这里逐条对上一个，不留「顺带也算」：
 *
 *   S1 公式条件保留 · S2 讲解偏好 · S3 本次例外 · S4 新材料方法复用
 *   S5 失败替代 · S6 撤回
 *
 * 每个场景都给了 `scenario` 字段，因为它决定**人工评阅时看什么**——
 * 同样一句「有没有保留适用条件」，在 S1 是核心指标，在 S5 只是噪音。
 * 把评阅标准藏在评审者脑子里，等于让不同人评出不同结论。
 *
 * 每道题带**两轮**（`turns`）：单轮看不出「偏好」和「例外」——那两样都要靠
 * 第二轮对第一轮的回应才判断得出来。
 */
interface ComparisonTurn { user: string; assistant?: string }

interface ComparisonTask {
  id: string;
  /** §8.5 的哪个场景；与题库是一一对应的，不要随意改。 */
  scenario: "S1_formula_condition" | "S2_explanation_preference" | "S3_this_time_exception"
    | "S4_new_material_reuse" | "S5_failure_alternative" | "S6_retraction";
  /** 评阅时这一题主要看什么——写在题上，不要只写在评审说明里。 */
  rubric: string;
  goal: string;
  materialRef: string;
  difficulty: "standard" | "hard";
  methodCatalog: Array<{ methodId: string; revision: number; title: string; appliesWhen: string }>;
  turns: ComparisonTurn[];
}

export const TASKS: ComparisonTask[] = [
  {
    id: "S1", scenario: "S1_formula_condition",
    rubric: "公式的适用条件有没有被写出来（写成文字或明确的限定从句都算）；有没有把条件悄悄删掉。",
    goal: "把牛顿第二定律讲清楚，带上它的适用条件。",
    materialRef: "frozen-physics-01", difficulty: "standard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111101", revision: 2,
      title: "讲公式先说适用条件", appliesWhen: "涉及公式或定理的讲解时",
    }],
    turns: [{ user: "把牛顿第二定律讲清楚，带上它的适用条件。" }],
  },
  {
    id: "S2", scenario: "S2_explanation_preference",
    rubric: "第二轮有没有按用户第一次纠正过的偏好来讲（先给反例再给定义）；有没有无视第一轮的纠正。",
    goal: "讲机会成本，用一个新例子。",
    materialRef: "frozen-econ-01", difficulty: "standard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111102", revision: 1,
      title: "新概念先给反例再给定义", appliesWhen: "讲解用户第一次接触的概念时",
    }],
    turns: [
      { user: "讲一下机会成本。" },
      { user: "不对，我是习惯先看定义再找例子。别每次都反过来。" },
      { user: "那重新讲一次机会成本。" },
    ],
  },
  {
    id: "S3", scenario: "S3_this_time_exception",
    rubric: "本轮用户给的例外有没有被遵守；有没有把上一次的偏好套到这一次上来（这是关键错法）。",
    goal: "这次直接给结论，不要铺垫。",
    materialRef: "frozen-exception-01", difficulty: "standard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111104", revision: 4,
      title: "默认先给反例，本次要求优先", appliesWhen: "讲解概念且用户没有另行要求时",
    }],
    turns: [
      { user: "讲一下复利。" },
      { user: "这次别铺垫，直接给结论。" },
    ],
  },
  {
    id: "S4", scenario: "S4_new_material_reuse",
    rubric: "换新材料之后，有没有沿用方法里与材料无关的那部分做法；有没有把方法里绑定旧材料的内容照搬。",
    goal: "用这份新材料做一张卡片。",
    materialRef: "frozen-new-material-01", difficulty: "hard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111105", revision: 3,
      title: "制卡先核原文再拆要点", appliesWhen: "根据新材料生成卡片时",
    }],
    turns: [
      { user: "用《细胞呼吸》那份笔记做一张卡片。" },
      { user: "换一份新的：《光合作用》。按同样的做法来。" },
    ],
  },
  {
    id: "S5", scenario: "S5_failure_alternative",
    rubric: "上一步失败之后有没有换一条路；有没有把失败的那一步说成已经完成。",
    goal: "把这周的错题整理出来，并说明每道错在哪。",
    materialRef: "frozen-failure-01", difficulty: "hard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111106", revision: 2,
      title: "取不到原文就如实说缺材料", appliesWhen: "需要引用原始材料而取不到时",
    }],
    turns: [
      { user: "把这周笔记第 12 页的错题整理出来。" },
      { user: "第 12 页取不到？那就从我贴出来的三道题讲。" },
    ],
  },
  {
    id: "S6", scenario: "S6_retraction",
    rubric: "用户撤回之后，后面有没有继续沿用被撤回的那条；有没有在撤回之后仍然引用它。",
    goal: "先按我刚才说的那个方式复习。",
    materialRef: "frozen-retraction-01", difficulty: "standard",
    methodCatalog: [{
      methodId: "11111111-1111-4111-8111-111111111107", revision: 2,
      title: "复习按周滚动，先核对遗漏", appliesWhen: "安排或回顾一周的复习时",
    }],
    turns: [
      { user: "按每周一三五的节奏安排复习。" },
      { user: "等等，一三五不行，改成二四六。刚才那条当我没说。" },
      { user: "那这周按什么安排？" },
    ],
  },
];

type Arm = "without_experience" | "with_experience";

/**
 * 两种观察（§8.5 要求**分开**，不能混算）。
 *
 * `cold_start`：同一批新任务，两臂只差「有没有相关经验」。
 * `continuous_use`：同一批任务在**已经用了一段时间之后**再跑——看的是「继续用下去
 * 会不会更好」，它和冷启动回答的是两个不同的问题。混在一起算出来的差值没有意义，
 * 所以输出目录也分开，两份样本不会互相覆盖。
 */
type Observation = "cold_start" | "continuous_use";

function selectedObservation(): Observation {
  const option = process.argv.find((argument) => argument.startsWith("--observation="));
  const value = option?.slice("--observation=".length) ?? "cold_start";
  assert.ok(value === "cold_start" || value === "continuous_use",
    `--observation 只能是 cold_start 或 continuous_use，收到：${value}`);
  return value;
}

function outputDirFor(observation: Observation): string {
  const base = process.env.COMPARISON_OUT_DIR ?? "/tmp/plan44-comparison";
  return observation === "cold_start" ? base : `${base}-continuous`;
}

/** 两臂共用的系统提示：除了做法目录，一个字都不差。 */
function systemPrompt(catalogBlock: string): string {
  return [
    COMPANION_HOST_PROTOCOL_V6, "", COMPANION_IDENTITY_BOUNDARY_V2, "", COMPANION_CHARACTER_BASE_V7,
    ...(catalogBlock ? ["", catalogBlock] : []),
  ].join("\n");
}

export interface RunnerSample extends ExperienceComparisonSampleV1 {
  /** 原始回答，留给人工评分。 */
  reply: string;
  finishReason: string | null;
}

/** 组装一次请求。导出供单测核对「两臂只差目录」这条不变量。 */
export function buildArmRequest(input: {
  task: ComparisonTask;
  arm: Arm;
  model: string;
  maxTokens?: number;
}): { systemPrompt: string; messages: Array<{ role: "user" | "assistant"; content: string }> } {
  // 有经验臂用的就是制卡链路那一份渲染；不是另写一段「参考以下方法」。
  const catalog = input.arm === "with_experience"
    ? renderMethodCatalogBlock(selectRelevantMethods(
      input.task.methodCatalog.map(entry => ({
        version: 1 as const, methodId: entry.methodId, revision: entry.revision,
        title: entry.title, appliesWhen: entry.appliesWhen,
        steps: [], exceptions: [], evidence: [], capabilities: [],
        state: "active" as const, userControlled: false, epistemicStatus: "supported" as const,
        availability: "available" as const, author: "user" as const,
        changeReason: null, sourceRunId: null, sourceRunRevision: null,
        evidenceIndependentCount: 1,
        offeredCount: 0, adoptedCount: 0, consultedCount: 0, helpfulCount: 0, unhelpfulCount: 0,
        lastConsultedAt: null, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
      })),
      input.task.goal,
    ))
    : "";
  // 单轮还是多轮由题库自己说（`turns`）。「讲解偏好」「本次例外」「撤回」这三个场景
  // **单轮判断不出来**——它们要靠第二轮对第一轮的回应。所以这里按 turns 铺，
  // 而不是只发 goal 那一句。
  return {
    systemPrompt: systemPrompt(catalog),
    messages: input.task.turns.flatMap((turn, index) => {
      const exchange: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: turn.user },
      ];
      if (index < input.task.turns.length - 1) {
        // 中间轮次的助手回答是题目预置的（`assistant` 可选）：它让后续轮次有一个
        // 可依据的上下文，也正是「用户纠正上一轮」这类场景需要的。
        const reply = turn.assistant ?? `（第 ${index + 1} 轮的回答）`;
        exchange.push({ role: "assistant", content: reply });
      }
      return exchange;
    }),
  };
}

/** 评分模板：把没测到的项显式留成 null，等人工填。 */
function unscored(task: ComparisonTask, arm: Arm, model: string, observation: Observation, reply: {
  text: string; finishReason: string | null; waitMs: number;
  promptTokens: number | null; completionTokens: number | null;
}): RunnerSample {
  return {
    taskId: task.id,
    scenario: task.scenario,
    rubric: task.rubric,
    arm,
    observation,
    providerId: "eval",
    modelId: model,
    promptVersion: "plan44-comparison-v1",
    methodVersions: arm === "with_experience" ? task.methodCatalog.map(entry => `${entry.methodId}@${entry.revision}`) : [],
    materialRef: task.materialRef,
    difficulty: task.difficulty,
    // 下面五项**没有自动打分的来源**：脚本只产出回答，人不填就保持 null。
    contentErrors: null,
    sameClassRework: null,
    repeatedExplanations: null,
    invalidToolCalls: 0, // 这两臂都不发工具（tools: []），「无效工具调用」可确定为零。
    compactionSemanticLoss: null, // 这次对照没有触发折叠，测不到。
    taskCompleted: reply.text.trim().length > 0,
    waitMs: reply.waitMs,
    costTokens: reply.promptTokens !== null && reply.completionTokens !== null
      ? reply.promptTokens + reply.completionTokens
      : null,
    reply: reply.text,
    finishReason: reply.finishReason,
  };
}

async function runRealModel(): Promise<void> {
  assert.equal(process.env.REAL_MODEL_BATCH, "1", "真实对照需要 REAL_MODEL_BATCH=1");
  const { provider, label } = resolveEvalProvider();
  assert.ok(provider.executeAgentTurn, `${label} 不支持 agent turn`);
  const observation = selectedObservation();
  const outDir = outputDirFor(observation);
  await mkdir(outDir, { recursive: true });

  const samples: RunnerSample[] = [];
  const raw: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  // 交叉顺序：每道题的两臂先后互换，抵消「后跑的更热」这类顺序效应。
  for (const [index, task] of TASKS.entries()) {
    const arms: Arm[] = index % 2 === 0
      ? ["without_experience", "with_experience"]
      : ["with_experience", "without_experience"];
    for (const arm of arms) {
      const request = buildArmRequest({ task, arm, model: provider.modelId });
      const startedAt = performance.now();
      // 单次失败不许带走整批：题目多、端点偶发截断都是常态，
      // 让一次失败把其余 11 次调用一起废掉，得到的是「没跑」而不是「跑了一半」。
      let response;
      try {
        response = await provider.executeAgentTurn!({
        role: AgentRole.COMPANION_AGENT,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: [],
        toolChoice: "auto",
        // 4096 而不是 2000：thinking 档的端点会把预算先花在推理上，
        // 实测 2000 会让它在产出第一个字之前就 `finish_reason="length"` 截断。
        // 这与 goal-context.ts 里记的是同一件事（那边连第一次工具调用都发不出来）。
        // 不靠调低温度或关掉思考档来「绕过」截断——那会把模型选择藏起来。
        maxTokens: 4_096,
        temperature: 0.4,
        model: provider.modelId,
        }, AbortSignal.timeout(120_000));
      } catch (error) {
        // 记下失败而不是静默丢掉：题目 id、臂与错误一起进 raw，
        // 人工评阅时能看出「这一格是空的」，而不是以为模型什么都没说。
        failures.push({
          taskId: task.id, arm,
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code ?? null,
        });
        logger.warn({ taskId: task.id, arm, err: error }, "comparison sample failed");
        continue;
      }
      const sample = unscored(task, arm, provider.modelId, observation, {
        text: response.content ?? "",
        finishReason: response.finishReason ?? null,
        waitMs: Math.round(performance.now() - startedAt),
        promptTokens: response.usage?.promptTokens ?? null,
        completionTokens: response.usage?.completionTokens ?? null,
      });
      samples.push(sample);
      raw.push({ taskId: task.id, arm, request, reply: response.content ?? "" });
    }
  }

  const report = summarizeExperienceComparison(samples, { observation: "cold_start" });
  await writeFile(join(outDir, "samples.json"), `${JSON.stringify(samples, null, 2)}\n`);
  await writeFile(join(outDir, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, "failures.json"), `${JSON.stringify(failures, null, 2)}\n`);
  await writeFile(join(outDir, "worksheet.md"), buildScoringWorksheet(samples));
  // 缺测是常态（五项要人工评分），所以这里不 assert 通过，只把状态打出来。
  console.log(JSON.stringify({
    provider: label, observation, samples: samples.length, failures: failures.length,
    outcome: report.outcome, refusals: report.refusals,
    scenarioCoverage: report.scenarioCoverage, coverage: report.coverage, outDir,
  }, null, 2));
  console.log(`人工评分：打开 ${join(outDir, "worksheet.md")}——每条样本已带该题的评阅标准与`
    + "原始回答，逐条填三格（内容错误 / 同类返工 / 重复解释），把填好的表存回同一目录，"
    + "再跑 `npx tsx scripts/experience-comparison-runner.ts --apply-worksheet` 即可并入报告。");
}

/**
 * 生成评分表：每条样本一行，带该题的**评阅标准**与**原始回答**。
 *
 * 为什么不给一个 JSON 让评审者手改：`samples.json` 里一条样本就是一坨嵌套对象，
 * 手改容易改错行、也看不出自己评的是哪一条。这里是**一张可读的表**——评阅标准直接印在
 * 旁边，回答全文也在，不需要来回翻。评完原样存回，再 `--apply-worksheet` 并入报告。
 *
 * 三格都是数字，`-` 表示「没评」——它与 0 的区别很重要：0 是「评了，确实没有」，
 * `-` 是「没评」，后者会被汇总器算成缺测而不是零。
 */
function buildScoringWorksheet(samples: readonly RunnerSample[]): string {
  const lines: string[] = [
    "# 方案 44 §8.5 人工评阅表",
    "",
    "逐条填三格：`内容错误` / `同类返工` / `重复解释`，填**整数**；这一条评不了就填 `-`。",
    "`-` 与 `0` 不同：`0` 是「评了，确实没有」，`-` 是「没评」——后者会被汇总成缺测，不会被当成零。",
    "",
    "评完把本文件存回同一目录，然后跑：",
    "",
    "```bash",
    "npx tsx --tsconfig tsconfig.json scripts/experience-comparison-runner.ts --apply-worksheet",
    "```",
    "",
    `样本共 ${samples.length} 条（每题两臂）。`,
    "",
  ];
  for (const sample of samples) {
    lines.push(
      `## ${sample.taskId} · ${sample.arm}`,
      "",
      `- 场景：\`${sample.scenario}\``,
      `- 评阅标准：${sample.rubric}`,
      `- 材料：${sample.materialRef} · 难度：${sample.difficulty} · token：${sample.costTokens ?? "缺"} · 等待：${sample.waitMs ?? "缺"}ms`,
      "",
      "**原始回答**",
      "",
      "```text",
      sample.reply,
      "```",
      "",
      "| 内容错误 | 同类返工 | 重复解释 |",
      "| --- | --- | --- |",
      "| - | - | - |",
      "",
    );
  }
  return lines.join("\n");
}

/** 把 worksheet.md 里填好的三格并回样本。 */
function applyWorksheet(outDir: string, samples: RunnerSample[]): number {
  const file = join(outDir, "worksheet.md");
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  let applied = 0;
  // 每节以 `## <taskId> · <arm>` 开头，随后是那张只有一行数据的表。
  // 只认**本表自己生成的**节标题：`## <taskId> · <arm>`。
  // 原先用 `/^## /m` 切分，结果把**回答正文里的 markdown 标题**（模型很爱写
  // `## 适用条件` 这类小节）也当成了一节——12 条样本被切成 20 节，后 8 节全落空，
  // 填好的分数也认不到哪一条上。
  const sections = text.split(/^## (?=[A-Z]\d+ · (?:with|without)_experience$)/m).slice(1);
  for (const section of sections) {
    const header = section.slice(0, section.indexOf("\n"));
    const [taskId, arm] = header.split(" · ");
    // 匹配那一行**数据**，且允许 `-`（未评）。
    // 第一版只匹配纯数字，于是遇到占位行 `| - | - | - |` 直接跳过整节——填了也应用不上。
    const row = section.match(/\|\s*(-|\d+)\s*\|\s*(-|\d+)\s*\|\s*(-|\d+)\s*\|\s*\n/);
    if (!taskId || !arm || !row) continue;
    const target = samples.find(sample => sample.taskId === taskId && sample.arm === arm);
    if (!target) continue;
    const [content, rework, repeated] = row.slice(1).map(value => (value === "-" ? null : Number(value)));
    target.contentErrors = content;
    target.sameClassRework = rework;
    target.repeatedExplanations = repeated;
    applied += 1;
  }
  return applied;
}

if (process.argv.includes("--apply-worksheet")) {
  const observation = selectedObservation();
  const outDir = outputDirFor(observation);
  const samples = JSON.parse(readFileSync(join(outDir, "samples.json"), "utf8")) as RunnerSample[];
  const applied = applyWorksheet(outDir, samples);
  const report = summarizeExperienceComparison(samples, { observation });
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ applied, outcome: report.outcome, refusals: report.refusals,
    coverage: report.coverage, scenarioCoverage: report.scenarioCoverage }, null, 2));
}

// 参数先校验，再看要不要真跑：写错 `--observation` 而忘了 `--real-model` 时，
// 静默退出 0 会让人以为「跑了但没数据」。
// 顶层 await 里抛出的断言会被 tsx 吞掉并仍然 exit 0，所以自己抓一次并置退出码
// （同族脚本 `companion-persona-ab-eval` 也是用 process.exitCode 表达失败）。
// 注意是**前缀**匹配：`--observation=x` 并不等于字符串 "--observation"。
// （第一版用 includes("--observation")，于是这段永远不进，非法值静默 exit 0。）
if (process.argv.some((a) => a.startsWith("--observation")) || process.argv.includes("--real-model")) {
  try {
    selectedObservation();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}

if (process.argv.includes("--real-model")) {
  await runRealModel();
}
