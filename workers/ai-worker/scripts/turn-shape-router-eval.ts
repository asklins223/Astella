/**
 * 形状路由离线评测（2026-10-13）。
 *
 * 要回答的问题只有一个：**用一次便宜的嵌入判断"这一轮是不是干净提问"，
 * 精确度够不够 99%**——够，才值得把双投机收缩成"有把握就只发一条"；
 * 不够就留着今天的双发。判错的代价只是那一轮退回原等待（放行权仍在 LLM 解释那边），
 * 但判错率高到一定程度，省下的那点成本就不值得多一次网络往返。
 *
 * 标签是**库里已经落地的权威解释**（`companion_turn_runs.turn_interpretation`），
 * 不是人工标的：路由要预测的就是"解释会不会让这条草稿被留下"。
 * 同一条用户原文只算一次（探针账号把同样的题重复了很多轮，不去重会把分数抬假）。
 *
 * 隐私口径：产物只写聚合计数与分数分布，**不写用户原文**。
 * 注意嵌入打到 SiliconFlow（`platforms.siliconflow`，远程 API，dev 实测 121–634ms）：
 * 这条评测会把去重后的 dev 原文各发一次嵌入请求，不是本地推理。
 *
 * 运行（从 workers/ai-worker）：
 *   node --env-file=../../.env --import tsx scripts/turn-shape-router-eval.ts
 */
import process from "node:process";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { createEmbeddingProvider } from "../src/lib/ai-provider.ts";

const outDir = resolve(import.meta.dirname, "../../../outputs/audits/2026-10-07-live");
mkdirSync(outDir, { recursive: true });
const empty = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

interface Row { text: string; keepQuestion: boolean; keepCasual: boolean }

function labelOf(interpretation: Record<string, unknown> | null): { keepQuestion: boolean; keepCasual: boolean } | null {
  if (!interpretation || typeof interpretation.intent !== "string") return null;
  const clean = empty(interpretation.subjects) && empty(interpretation.ambiguities)
    && empty(interpretation.candidateOperations) && empty(interpretation.pendingOfferIndexes)
    && interpretation.goalRelation === "unrelated"
    && (interpretation.voiceStyle as { decision?: string } | undefined)?.decision !== "clarify";
  if (!clean) return { keepQuestion: false, keepCasual: false };
  return {
    keepQuestion: interpretation.intent === "question" && interpretation.toolUse === "none",
    keepCasual: interpretation.intent === "conversation" && interpretation.toolUse === "none",
  };
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map(value => value / norm) : vector;
}

const dot = (a: number[], b: number[]): number => a.reduce((sum, value, i) => sum + value * b[i], 0);

/** 类内原型 + 近邻均值两路分数取高，避免"某类样本聚成一团才认得出"的偏窄判据。 */
function scoreAgainst(label: (row: Row) => boolean, samples: { row: Row; vector: number[] }[], held: { row: Row; vector: number[] }): { prototype: number; neighbors: number } {
  const train = samples.filter(sample => label(sample.row) && sample !== held);
  const dimensions = held.vector.length;
  const centroid = new Array<number>(dimensions).fill(0);
  for (const sample of train) for (let i = 0; i < dimensions; i += 1) centroid[i] += sample.vector[i];
  const prototype = normalize(centroid);
  const similarities = train.map(sample => dot(held.vector, sample.vector)).sort((a, b) => b - a).slice(0, 5);
  return {
    prototype: train.length ? dot(held.vector, prototype) : 0,
    neighbors: similarities.length ? similarities.reduce((a, b) => a + b, 0) / similarities.length : 0,
  };
}

async function main(): Promise<number> {
  const url = (process.env.DATABASE_URL ?? "").replace("@postgres:", "@127.0.0.1:");
  if (!url) throw new Error("DATABASE_URL required");
  const sql = postgres(url, { max: 1 });
  const rows = await sql`
    SELECT r.turn_interpretation AS interpretation,
           (SELECT b->>'text' FROM jsonb_array_elements(u.blocks) b WHERE b->>'type' = 'text' LIMIT 1) AS text
    FROM companion_turn_runs r
    JOIN companion_messages u ON u.id = r.user_message_id
    WHERE r.turn_interpretation IS NOT NULL AND u.role = 'user'`;

  const seen = new Set<string>();
  const labeled: Row[] = [];
  let unusable = 0;
  for (const row of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const label = labelOf(row.interpretation as Record<string, unknown> | null);
    if (!text || text.length < 2 || !label) { unusable += 1; continue; }
    if (seen.has(text)) continue;
    seen.add(text);
    labeled.push({ text, ...label });
  }

  const platform = resolveSystemPlatform("embedding");
  if (!platform?.apiKey) throw new Error("embedding route is not configured");
  const provider = await createEmbeddingProvider();
  if (!provider) throw new Error("embedding provider unavailable");
  const embed = provider.embed?.bind(provider);
  if (!embed) throw new Error("embedding provider does not implement embed");
  const embedOne = (text: string, timeoutMs: number): Promise<number[] | null> => embed(text, AbortSignal.timeout(timeoutMs));

  /**
   * 并发实测（2026-10-13 用户提醒：这个嵌入账号的并发很低，可能只有 1）。
   * 路由能不能上关键路径，取决于"同时在飞的嵌入会不会互相排队"——排队就说明
   * 它只能做成"到有界超时为止，没答案就照旧两条都发"，不能让它挡起跑线。
   */
  const probeText = "形状路由并发探测，与任何真实内容无关。";
  const concurrencyProbe: Record<string, unknown> = {};
  const solo = await (async () => { const at = Date.now(); await embedOne(probeText, 30_000); return Date.now() - at; })();
  concurrencyProbe.单发基准ms = solo;
  for (const width of [2, 4]) {
    const started = Date.now();
    const each = await Promise.all(Array.from({ length: width }, async () => {
      const one = Date.now();
      await embedOne(probeText, 30_000);
      return Date.now() - one;
    }));
    concurrencyProbe[`并行${width}`] = { 整体墙钟ms: Date.now() - started, 单次最慢ms: Math.max(...each),
      相对单发倍数: +((Date.now() - started) / (solo || 1)).toFixed(2) };
  }

  const embedded: { row: Row; vector: number[] }[] = [];
  const latencies: number[] = [];
  for (const row of labeled) {
    const started = Date.now();
    const vector = await embedOne(row.text, 20_000);
    latencies.push(Date.now() - started);
    if (vector && vector.length > 0) embedded.push({ row, vector: normalize(vector) });
  }

  const classes = {
    question: (row: Row) => row.keepQuestion,
    casual: (row: Row) => row.keepCasual,
  } as const;
  const thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    model: platform.model,
    egress: "SiliconFlow 远程嵌入 API（非本地推理）；产物不含用户原文",
    totalRuns: rows.length,
    unusableRows: unusable,
    distinctTexts: labeled.length,
    embedded: embedded.length,
    truthCounts: {
      keepQuestion: labeled.filter(row => row.keepQuestion).length,
      keepCasual: labeled.filter(row => row.keepCasual).length,
      neither: labeled.filter(row => !row.keepQuestion && !row.keepCasual).length,
    },
    concurrencyProbe,
    embedLatencyMs: {
      min: Math.min(...latencies), median: latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
      max: Math.max(...latencies),
    },
    leaveOneOut: {},
  };

  for (const [className, label] of Object.entries(classes)) {
    const perThreshold = thresholds.map(threshold => {
      let truePositive = 0, falsePositive = 0, falseNegative = 0, abstained = 0;
      for (const held of embedded) {
        const other = className === "question" ? classes.casual : classes.question;
        const own = scoreAgainst(label, embedded, held);
        const rival = scoreAgainst(other, embedded, held);
        const score = Math.max(own.prototype, own.neighbors);
        const rivalScore = Math.max(rival.prototype, rival.neighbors);
        const predicts = score >= threshold && score > rivalScore;
        if (!predicts) { if (label(held.row)) falseNegative += 1; else abstained += 1; continue; }
        if (label(held.row)) truePositive += 1; else falsePositive += 1;
      }
      const decided = truePositive + falsePositive;
      return {
        threshold,
        召回率: +(truePositive / (truePositive + falseNegative || 1)).toFixed(3),
        判中数: decided,
        精确度: decided ? +(truePositive / decided).toFixed(4) : null,
        弃权数: abstained,
        漏判数: falseNegative,
      };
    });
    (report.leaveOneOut as Record<string, unknown>)[className] = perThreshold;
  }

  await sql.end();
  const file = `${outDir}/turn-shape-router-eval-${Date.now()}.json`.replace(/-\d{3}$/,"");
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`written: ${file}`);
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

process.exitCode = await main();
