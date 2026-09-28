/**
 * 真模型那一发的**人工复核**工具（39d W4-1 尾；39 §6.1）。
 *
 * 为什么它是脚本而不是一次性的一次性探针：§6.1 那条硬约束（读数来自服务端，不由模型
 * 逐次生成看似实测的数字）**只能在真模型上验**。离线用例证的是"合同收得下／收不下"，
 * 而真正会翻车的地方是模型**在自由文本里**写点什么——第一版就栽在这儿：qwen-plus 老实地
 * 写了「这不是对某次阅读行为的**实测**记录」，而按关键字扫的判据把那一句判成了违规，
 * 8 个真实样本毙掉 2 个。这个工具就是下次再调那类判据时该先跑一遍的东西。
 *
 * 它同时打印三份**真实读数**：
 *   - 服务端算出来的节点字数（模型拿不到这些值，只拿到正文）；
 *   - 模型自己选的形式（`sequence` / `flow` / `bars`）与步数；
 *   - 模型输出里到底有没有数字、出现在哪一句。
 *
 * 跑法（apps/api 下，需要 .env 里有 `DASHSCOPE_API_KEY` ＋ `ASSESSMENT_CRITIC_URL`）：
 *   DOTENV_CONFIG_PATH=../../.env npx tsx scripts/real-artifact-probe.mts
 *   DOTENV_CONFIG_PATH=../../.env npx tsx scripts/real-artifact-probe.mts --samples 3
 *
 * 它**只读**：不连库、不写任何状态。产物 HTML 写到 /tmp 供人工看。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import {
  computeArtifactNodesV1,
  hasMeasurementClaimV1,
  computeArtifactNodeReadoutV1,
} from "../src/modules/note-learning-rounds/round-artifact-measure.ts";
import {
  artifactCompletionSatisfiedV1,
  dynamicArtifactSpecV1Schema,
  llmDynamicArtifactProvider,
  runDynamicArtifactV1,
} from "../src/modules/note-learning-rounds/round-artifact-model.ts";
import {
  buildDynamicArtifactHtmlV1,
  DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1,
} from "../src/modules/note-learning-rounds/round-artifact-render.ts";
import { resolveTeachingModelConfig } from "../src/modules/note-learning-rounds/teaching-llm.ts";

const SAMPLES = Math.max(1, Number(process.argv[process.argv.indexOf("--samples") + 1]) || 2);

const CASES = [
  {
    q: "重读和提取练习的区别是什么？",
    m: {
      explanation: "重读是把材料再看一遍，感觉顺畅就以为记住了；提取练习是合上材料凭记忆重建要点。两者最大的差别在有没有真正从记忆里取出来：重读只需要认得，提取需要想得出。",
      example: "比如同样看一节技术文档，重读之后能顺畅地从头读下去，提取练习之后合上纸却说不出任何一个接口名。",
      planSteps: ["先说清两种做法各自要求你做什么", "再指出它们对记忆要求的差别", "最后用一个例子把差别摆出来"],
    },
  },
  {
    q: "为什么先看结构再看细节？",
    m: {
      explanation: "细节挂在大局上。不知道一篇文章分成哪几部分，读到中间就会失去位置感，记住的只是零散句子。先建立结构，后面每个细节都有地方放。",
      example: null,
      planSteps: ["先扫标题与小节，知道文章分几块", "再看每块讲什么", "最后回到细节", "把细节挂回它所属的那一块"],
    },
  },
  {
    q: "数据库索引是怎么让查询变快的？",
    m: {
      explanation: "索引是一棵按列值排序的树。查询带上了索引列时，数据库不必扫全表，可以顺着树往下找，只读少量页。代价是写入变慢，还要占空间。",
      example: "比如一千万行的表按用户 id 建索引之后，按 id 查一行只需要读几页。",
      planSteps: ["先说清索引是什么结构", "再说查询时怎么用它", "最后说代价"],
    },
  },
  {
    q: "记忆曲线是什么？",
    m: {
      explanation: "记忆的保留量会随时间下降，刚学完时最高，之后逐渐变低。遗忘的速度不是均匀的，刚学会的一段时间里掉得最快。",
      example: null,
      planSteps: ["说明保留量随时间下降", "指出下降不是均匀的", "说明最先掉的是刚学会的那部分"],
    },
  },
];

const config = resolveTeachingModelConfig();
if (!config) {
  console.error("没有解析到模型配置（需要 .env 里的 DASHSCOPE_API_KEY ＋ ASSESSMENT_CRITIC_URL）");
  process.exit(1);
}
console.log(`模型：${config.model}    每题取样：${SAMPLES}\n`);

let ok = 0, rejected = 0, shape = 0, transport = 0;
const forms: Record<string, number> = {};
const reasons: string[] = [];
const digitHits: string[] = [];

for (let i = 0; i < SAMPLES; i += 1) {
  for (const c of CASES) {
    const nodes = computeArtifactNodesV1(c.m);
    const result = await runDynamicArtifactV1({
      provider: llmDynamicArtifactProvider({ config }),
      modelId: config.model,
      maxModelCalls: 2,
      maxDurationMs: 110_000,
      input: { drivingQuestion: c.q, nodes },
      // 纯读，不连库：作用域给 undefined，内核那道闸就放行。
      scope: { workspaceId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" },
      round: { roundId: "00000000-0000-4000-8000-000000000003", noteVersionId: "00000000-0000-4000-8000-000000000004", sourceContentHash: "726f6b03d3d48cc646abd3b370ce97e8" },
      ordinal: 1,
      currentActiveTransaction: () => undefined,
    });
    const label = `${c.q}`;
    if (!result.ok) {
      if (result.failure === "contract_rejected") { rejected += 1; reasons.push(`${label} → contract_rejected: ${result.detail}`); }
      else { transport += 1; reasons.push(`${label} → ${result.failure}: ${result.detail}`); }
      continue;
    }
    const parsed = dynamicArtifactSpecV1Schema.safeParse(result.spec);
    if (!parsed.success) { shape += 1; reasons.push(`${label} → 合同不合`); continue; }
    if (!artifactCompletionSatisfiedV1(result.spec, nodes)) { rejected += 1; reasons.push(`${label} → 完成判据未达成`); continue; }

    ok += 1;
    forms[result.spec.form] = (forms[result.spec.form] ?? 0) + 1;
    // 模型输出里出现数字的那几句（顺序号是允许的，读数不是——这里只是**列出来给人看**）。
    const fields: Array<[string, string]> = [
      ["title", result.spec.title], ["subject", result.spec.subject], ["caution", result.spec.caution],
      ...result.spec.steps.map((s, index) => [`step${index}`, s.narration] as [string, string]),
    ];
    for (const [key, value] of fields) {
      if (/\d/.test(value)) digitHits.push(`${label} · ${key}: ${value}`);
    }

    const built = buildDynamicArtifactHtmlV1({
      spec: result.spec, nodes,
      snapshotHash: "726f6b03d3d48cc646abd3b370ce97e8",
      generatorRef: `${DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1} (${config.model})`,
    });
    console.log(`── ${label}`);
    console.log(`   模型选的形式：${result.spec.form}    步数 ${result.spec.steps.length}/${nodes.length}    模型调用 ${result.modelCalls}`);
    console.log(`   服务端读数（模型拿不到）：${nodes.map((n) => `${n.title}=${computeArtifactNodeReadoutV1(n).value}字`).join("  ")}`);
    if (built.ok) {
      console.log(`   渲染：ok，${[...built.html].length} 字符`);
      writeFileSync(`/tmp/real-artifact-${result.spec.form}-${i}.html`, built.html);
    } else {
      console.log(`   渲染：被拒（${built.reason}）${built.detail}`);
    }
  }
}

const total = SAMPLES * CASES.length;
console.log(`\n═══ 汇总（${total} 个真实样本）═══`);
console.log(`通过 ${ok}   判据未达成 ${rejected}   合同不合 ${shape}   传输失败 ${transport}`);
console.log(`形式分布（模型自己选的）：${Object.entries(forms).map(([k, v]) => `${k}=${v}`).join("  ") || "（无）"}`);
console.log(`声称实测被拦下的：${reasons.length ? reasons.join("; ") : "（无）"}`);
console.log(`\n模型输出里含数字的句子（顺序号允许；读数一律来自服务端）：${digitHits.length}`);
for (const hit of digitHits) console.log(`  · ${hit}`);
console.log(`\n判据自检：hasMeasurementClaimV1("这是实测结果，耗时 12 毫秒") = `
  + `${hasMeasurementClaimV1("这是实测结果，耗时 12 毫秒")}（应为 true）`);
console.log(`判据自检：hasMeasurementClaimV1("这不是对某次阅读行为的实测记录，仅示意") = `
  + `${hasMeasurementClaimV1("这不是对某次阅读行为的实测记录，仅示意")}（应为 false：诚实的免责）`);
