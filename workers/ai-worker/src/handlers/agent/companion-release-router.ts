/**
 * L1 放行路由的**影子模式**（2026-10-17，默认关；`COMPANION_RELEASE_ROUTER=shadow` 打开）。
 *
 * 为什么是影子：L1 的阈值和"漏放率"只能从生产分布里校准出来。这一步对 100% 流量
 * 计算 L1 判断，但**不改变放行**——结果只写进 `companion_turn_runs.route.l1`，
 * 和同一轮的 L2 解释比对，离线出"覆盖率—漏放率"曲线。曲线达标前不允许它真的放行。
 *
 * L1 只回答一个问题（用户 2026-10-17 的裁决）：这一轮是不是 `intent ∈ {conversation,
 * question}` 且 `toolUse = none` 的安全轮。其余字段（subjects/ambiguities/
 * candidateOperations/pendingOfferIndexes）不从近邻里猜。
 *
 * 三条硬约束：
 * 1. **状态门优先**：上一句是她的追问/邀请、或本轮很短或带指代 → 直接弃权（等 L2）。
 *    那类话术恰恰是 embedding 最不可靠的地方，也是 6 个带确认工具的高发区。
 * 2. **OOD 弃权**：top1 相似度不够（没见过这种说法）就不放行，不用 margin——
 *    90.7% 的 none 会让 kNN 投票天然偏向 none，margin 恰好在最不安全的一侧虚高。
 * 3. **索引在线生长**：每条 L2 解释成功后把（原话向量，intent，toolUse）记进进程内
 *    有界索引；冷启动时弃权，跑得越久覆盖越高。不读历史库、不预训练。
 */

import { randomUUID } from "node:crypto";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { createEmbeddingProvider, type EmbeddingProviderLike } from "../../lib/ai-provider.ts";
import { createGovernedEmbeddingProvider, resolveAIGovernanceContext } from "../../lib/governance.ts";

export type CompanionReleaseRouterMode = "off" | "shadow" | "enforce";

/**
 * `COMPANION_RELEASE_ROUTER`：
 * - 缺省/`off`：关闭；
 * - `shadow`：对全部流量计算并记录，**不改变放行**（出覆盖率—漏放率曲线）；
 * - `enforce`：L1 判断真的可以提前打开投机首步的放行闸（仍需曲线达标后再开）。
 */
export function resolveCompanionReleaseRouterMode(
  raw: string | undefined = process.env.COMPANION_RELEASE_ROUTER,
): CompanionReleaseRouterMode {
  const mode = raw?.trim().toLowerCase();
  if (mode === "shadow") return "shadow";
  if (mode === "enforce") return "enforce";
  return "off";
}

export interface CompanionReleaseThresholds {
  /** 安全意图（conversation/question）的加权概率下限。 */
  readonly safeProbability: number;
  /** toolUse=none 的加权概率下限。 */
  readonly toolNoneProbability: number;
  /** 最近邻相似度下限（OOD 弃权线）。 */
  readonly topSimilarity: number;
  readonly neighbors: number;
  /** 少于这么多样本时整轮弃权（冷启动）。 */
  readonly minSamples: number;
  /** 每个账号索引的样本上限（进程内，掉电即失；影子期的定位是采集，不是持久化）。 */
  readonly maxSamples: number;
}

export const COMPANION_RELEASE_THRESHOLD_DEFAULTS: CompanionReleaseThresholds = Object.freeze({
  /**
   * 安全概率下限（2026-10-18 按共享语料池重标定）。
   *
   * 手定的 0.85 在真实 259 轮上实测：整套门只覆盖 14.3%，而**放出去的 18.9% 是错的**，
   * 其中 5 条落在硬错面（act/task/mixed）。共享去标识语料进池后（AUC 0.882→0.944），
   * 同一套分数扫阈值的表是：
   *
   *   τ_safe 0.70 → 覆盖 29.7%，硬错 6；0.80 → 27.8%，硬错 4；
   *   **0.90 → 19.7%，硬错 0，软错 1**（占全部轮次）。
   *
   * 取 0.90：宁可少放（每轮多等一次分类器），也不能在"该写入"的轮次上先说出来。
   * 软错面（read/uncertain）1 条属降级不属作废，符合"一次判错只能降级"的裁决。
   */
  safeProbability: 0.9,
  toolNoneProbability: 0.9,
  /**
   * OOD 近邻下限（2026-10-18 按真实分布重设）。
   *
   * 原来是 0.90，按「同一句话换个说法算同一类」的直觉定的。实测不成立：
   * BGE-M3 上两条自然问句（"我接下来该先做什么" vs "我最近学了多久"）余弦只有
   * 0.56，连毫不相干的两句也有 0.53 —— 0.90 在这套向量里几乎只对**逐字相同**
   * 成立，于是 L1 在生产上从来没放过一轮（近七天真值：`reason` 全是 gated/
   * similarity，`waitedMs` 每轮 4.9–5.7 秒全白等）。
   *
   * 0.62 取在"真实同义改写"与"毫不相干"之间：实测同义改写 0.75–0.88、
   * 无关问句 0.50–0.60。仍然配 `safeProbability` 与 `toolNoneProbability`
   * 两道概率门，以及 `anaphora/pendingOffer` 两道状态门——近邻只是
   * "见没见过这类说法"，不是"这句话安全"。
   *
   * 2026-10-18 复测：0.55 与 0.62 在零硬错那一档给出同样的覆盖（19.7%），
   * 说明这一档已经不是相似度在挡；保留 0.62 作为"确实见过同类说法"的最低证据。
   */
  topSimilarity: 0.62,
  neighbors: 8,
  minSamples: 8,
  maxSamples: 256,
});

function readRatio(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function readCount(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

export function resolveCompanionReleaseThresholds(
  env: Record<string, string | undefined> = process.env,
): CompanionReleaseThresholds {
  return {
    safeProbability: readRatio(env.COMPANION_RELEASE_TAU_SAFE, COMPANION_RELEASE_THRESHOLD_DEFAULTS.safeProbability),
    toolNoneProbability: readRatio(env.COMPANION_RELEASE_TAU_TOOL, COMPANION_RELEASE_THRESHOLD_DEFAULTS.toolNoneProbability),
    topSimilarity: readRatio(env.COMPANION_RELEASE_TAU_SIM, COMPANION_RELEASE_THRESHOLD_DEFAULTS.topSimilarity),
    neighbors: readCount(env.COMPANION_RELEASE_NEIGHBORS, COMPANION_RELEASE_THRESHOLD_DEFAULTS.neighbors, 1),
    minSamples: readCount(env.COMPANION_RELEASE_MIN_SAMPLES, COMPANION_RELEASE_THRESHOLD_DEFAULTS.minSamples, 1),
    maxSamples: readCount(env.COMPANION_RELEASE_MAX_SAMPLES, COMPANION_RELEASE_THRESHOLD_DEFAULTS.maxSamples, 16),
  };
}

/**
 * 指代词：出现即弃权（保守方向，只损失覆盖率）。
 *
 * 2026-10-17 生产实测收窄：原来的清单把「继续」「接下来」「之前」「上面」也算作指代，
 * 于是「我接下来该先做什么」这种本来就没有所指的问句被判成有歧义，L1 整轮弃权、
 * 白等一次 4.5 秒的分类。真正需要弃权的是**指向具体对象的词**（这个/那个/它/刚才），
 * 它们可能指上一轮她说过的话；而「接下来/继续」是时间与话轮的连接词，
 * 本身不带对象，L2 也从没因为它们把 toolUse 判成非 none。
 */
const ANAPHORA_PATTERN = /(这个|那个|这些|那些|它们|它|刚才|刚刚|第二个|第三个|上一个|下一个|前面那)/u;
/**
 * 她的追问/邀请的收尾形态：问号收尾就是"还在等回应"的最强信号；
 * 其余是省略问号的邀请句（"我随时接""需要我展开就说一声"）。
 *
 * 2026-10-17 生产实测补了两类漏判：`回我一句「继续」`、`说一声` 这种把球明确踢回去的
 * 收尾。L1 若把它们当成普通陈述放行，L2 回填的 `pendingOfferIndexes` 就会让正式步
 * 重写历史——而提前开闸时文字已经发出去了，重写必然变成两个答案。
 */
const OFFER_TAIL_PATTERN = /(?:[？?]\s*$)|(?:(?:吗|好不好|要不要|需要我|我随时|等你|告诉我|怎么样|可以吗|要我|想听|回我|回一句|说一声|说一声就行)[。.！!…\s」』"']*$)/u;

export interface CompanionReleaseGates {
  readonly pendingOffer: boolean;
  readonly anaphora: boolean;
  /** 进行中/暂停的学习任务或正式作答：这类轮次不该由 L1 放行。 */
  readonly learningTask: boolean;
}

export interface CompanionReleaseGateInput {
  readonly text: string;
  readonly recentMessages?: readonly { readonly role: string; readonly text: string }[];
  readonly activeLearningTask?: boolean;
}

/**
 * L2 之前就能算出来的状态门。
 *
 * 够不到的输入（进行中/暂停的学习任务、真正的 pendingOfferIndexes）**不在这里猜**：
 * 影子期只按"上一句是不是她的追问/邀请"+"本轮短/带指代"这两个可判的事实弃权，
 * 其余交还 L2。等影子曲线出来再决定要不要把学习任务态也接进来。
 */
/**
 * 短句（≤8 字）以前是第四道门，一律弃权。2026-10-18 去掉：
 * 真实 259 轮里 ≤8 字有 79 条、56 条本就安全，而共享去标识语料进索引后，
 * 短句的近邻安全概率 p90=1.0，τ=0.85 能放行 23/79 且硬错面 0、软错面 0。
 * 短句真正的风险是"她上一句在等你接话"，那条仍由 pendingOffer 与 anaphora 挡住。
 */
export function companionReleaseGates(input: CompanionReleaseGateInput): CompanionReleaseGates {
  const text = input.text.trim();
  const lastAssistant = [...(input.recentMessages ?? [])].reverse().find((message) => message.role === "assistant");
  const pendingOffer = lastAssistant !== undefined && OFFER_TAIL_PATTERN.test(lastAssistant.text.trim());
  return {
    pendingOffer,
    anaphora: ANAPHORA_PATTERN.test(text),
    learningTask: input.activeLearningTask === true,
  };
}

export type CompanionReleaseDecision = "release" | "wait";
export type CompanionReleaseReason =
  | "gated"
  | "cold"
  | "embedding_unavailable"
  | "similarity"
  | "probability"
  | "released";

export interface CompanionReleaseVerdict {
  readonly decision: CompanionReleaseDecision;
  readonly reason: CompanionReleaseReason;
  readonly intentGuess: "conversation" | "question" | null;
  readonly safeProbability: number | null;
  readonly toolNoneProbability: number | null;
  readonly topSimilarity: number | null;
  readonly samples: number;
  readonly gates: CompanionReleaseGates;
}

interface ReleaseSample {
  readonly vec: readonly number[];
  readonly intent: string;
  readonly toolUse: string;
}

interface ScopeIndex {
  readonly samples: ReleaseSample[];
  readonly seen: Set<string>;
  inflight: number;
}

const scopes = new Map<string, ScopeIndex>();

function scopeIndex(scopeKey: string): ScopeIndex {
  const existing = scopes.get(scopeKey);
  if (existing) return existing;
  const created: ScopeIndex = { samples: [], seen: new Set(), inflight: 0 };
  scopes.set(scopeKey, created);
  return created;
}

/** 测试用：清空所有账号的在线索引。 */
export function resetCompanionReleaseRouterForTests(): void {
  scopes.clear();
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function isSafeLabel(intent: string, toolUse: string): boolean {
  return (intent === "conversation" || intent === "question") && toolUse === "none";
}

/** 原话规范化：去首尾空白、折叠空白；embedding 与持久化用同一份，去重才成立。 */
export function normalizeCompanionReleaseText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `scopeKey` 的约定是 `${workspaceId}:${userId}`。只有两段都是 UUID 时才认——
 * 单测里用的可读 scope 名因此**不会**触发任何数据库读写。
 */
export function parseCompanionReleaseScopeKey(scopeKey: string): { workspaceId: string; userId: string } | null {
  const parts = scopeKey.split(":");
  if (parts.length !== 2) return null;
  const [workspaceId, userId] = parts as [string, string];
  return UUID_PATTERN.test(workspaceId) && UUID_PATTERN.test(userId) ? { workspaceId, userId } : null;
}

export interface CompanionReleaseEvaluationInput {
  readonly scopeKey: string;
  readonly text: string;
  readonly recentMessages?: readonly { readonly role: string; readonly text: string }[];
  /** 进行中/暂停的学习任务、正式作答；L2 之前就能从 read 上下文拿到。 */
  readonly activeLearningTask?: boolean;
  readonly embed: (text: string) => Promise<readonly number[] | null>;
  readonly thresholds?: CompanionReleaseThresholds;
}

/**
 * 算这一轮的 L1 判断（纯计算 + 一次 embedding 调用；**由调用方决定要不要 await**）。
 */
export async function evaluateCompanionRelease(
  input: CompanionReleaseEvaluationInput,
): Promise<CompanionReleaseVerdict> {
  const thresholds = input.thresholds ?? resolveCompanionReleaseThresholds();
  const gates = companionReleaseGates({ text: input.text, recentMessages: input.recentMessages, activeLearningTask: input.activeLearningTask });
  const wait = (reason: CompanionReleaseReason, samples: number): CompanionReleaseVerdict => ({
    decision: "wait", reason, intentGuess: null,
    safeProbability: null, toolNoneProbability: null, topSimilarity: null, samples, gates,
  });
  if (gates.pendingOffer || gates.anaphora || gates.learningTask) {
    return wait("gated", scopeIndex(input.scopeKey).samples.length);
  }
  const index = scopeIndex(input.scopeKey);
  if (index.samples.length < thresholds.minSamples) return wait("cold", index.samples.length);

  const query = await input.embed(input.text).catch(() => null);
  if (!query || query.length === 0) return wait("embedding_unavailable", index.samples.length);

  const scored = index.samples
    .map((sample) => ({ sample, similarity: cosine(query, sample.vec) }))
    .filter((entry) => entry.similarity >= 0)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, thresholds.neighbors);
  if (scored.length === 0) return wait("similarity", index.samples.length);
  const topSimilarity = scored[0]?.similarity ?? 0;
  const totalWeight = scored.reduce((sum, entry) => sum + entry.similarity, 0);
  if (totalWeight <= 0) return wait("similarity", index.samples.length);
  const safeWeight = scored.reduce((sum, entry) => sum + (isSafeLabel(entry.sample.intent, entry.sample.toolUse) ? entry.similarity : 0), 0);
  const noneWeight = scored.reduce((sum, entry) => sum + (entry.sample.toolUse === "none" ? entry.similarity : 0), 0);
  const conversationWeight = scored.reduce((sum, entry) => sum + (entry.sample.intent === "conversation" ? entry.similarity : 0), 0);
  const questionWeight = scored.reduce((sum, entry) => sum + (entry.sample.intent === "question" ? entry.similarity : 0), 0);
  const safeProbability = safeWeight / totalWeight;
  const toolNoneProbability = noneWeight / totalWeight;
  const intentGuess: "conversation" | "question" = conversationWeight >= questionWeight ? "conversation" : "question";

  const base = { intentGuess, safeProbability, toolNoneProbability, topSimilarity, samples: index.samples.length, gates };
  if (topSimilarity < thresholds.topSimilarity) return { decision: "wait", reason: "similarity", ...base };
  if (safeProbability < thresholds.safeProbability || toolNoneProbability < thresholds.toolNoneProbability) {
    return { decision: "wait", reason: "probability", ...base };
  }
  return { decision: "release", reason: "released", ...base };
}

/**
 * 把一条 L2 结果记进在线索引（fire-and-forget；调用方不必 await）。
 * 去重按规范化原话；同一账号最多两条在飞，超了直接跳过——影子期宁可少一条样本，
 * 也不在后台堆起一串没人等的 embedding 调用。
 */
export interface CompanionReleaseSampleWrite {
  readonly text: string;
  readonly intent: string;
  readonly toolUse: string;
  readonly embedding: readonly number[];
}

export async function rememberCompanionReleaseSample(input: {
  readonly scopeKey: string;
  readonly text: string;
  readonly intent: string;
  readonly toolUse: string;
  readonly embed: (text: string) => Promise<readonly number[] | null>;
  readonly thresholds?: CompanionReleaseThresholds;
  /** 测试注入口；缺省在 scopeKey 是真实账号键时自动落库。 */
  readonly persist?: (row: CompanionReleaseSampleWrite) => Promise<void>;
}): Promise<void> {
  const thresholds = input.thresholds ?? resolveCompanionReleaseThresholds();
  const normalized = normalizeCompanionReleaseText(input.text);
  if (normalized.length === 0) return;
  const index = scopeIndex(input.scopeKey);
  const key = `${input.intent}\u0000${input.toolUse}\u0000${normalized}`;
  if (index.seen.has(key) || index.inflight >= 2) return;
  index.seen.add(key);
  index.inflight += 1;
  try {
    const vec = await input.embed(normalized).catch(() => null);
    if (!vec || vec.length === 0) {
      index.seen.delete(key);
      return;
    }
    index.samples.push({ vec, intent: input.intent, toolUse: input.toolUse });
    while (index.samples.length > thresholds.maxSamples) index.samples.shift();
    const persist = input.persist
      ?? (parseCompanionReleaseScopeKey(input.scopeKey) === null
        ? undefined
        : (row: CompanionReleaseSampleWrite) => persistCompanionReleaseSample({ scopeKey: input.scopeKey, ...row }));
    if (persist) {
      void persist({ text: normalized, intent: input.intent, toolUse: input.toolUse, embedding: vec })
        .catch(() => undefined);
    }
  } finally {
    index.inflight -= 1;
  }
}

/**
 * 放行闸的合成（enforce 模式用）：L1 说"这一版可以放" → 立刻开闸；
 * 否则只在 L2 落定时按既有 `shouldKeep` 判据开闸。
 *
 * L1 判断不适用于这架航班（比如它猜 question 而这里是闲聊版）时，返回一个
 * **永不落定**的 promise——于是 race 只剩 L2 这一路，行为与从前一字不差。
 */
export function companionReleaseGateFor(
  verdict: Promise<CompanionReleaseVerdict | null>,
  kind: "conversation" | "question",
  fallback: () => Promise<boolean>,
): () => Promise<boolean> {
  const l1 = verdict.then((value) => (
    value?.decision === "release" && value.intentGuess === kind
      ? true
      : new Promise<boolean>(() => undefined)
  ));
  return () => Promise.race([l1, fallback()]);
}

export interface CompanionReleaseRouterPort {
  readonly mode: CompanionReleaseRouterMode;
  /** 本轮 L1 判断（memoized：一次 embedding，两架航班共用）。 */
  evaluate(): Promise<CompanionReleaseVerdict | null>;
}

/**
 * enforce 模式给 runtime 的端口：本轮只算一次，两架投机航班与 route 记录共用。
 * 冷启动时顺手用历史轮次给索引打底（后台、有界，绝不影响本轮）。
 */
export function createCompanionReleaseRouterPort(args: {
  readonly mode: CompanionReleaseRouterMode;
  readonly scopeKey: string;
  readonly text: string;
  readonly recentMessages?: readonly { readonly role: string; readonly text: string }[];
  readonly activeLearningTask?: boolean;
  readonly embed: (text: string) => Promise<readonly number[] | null>;
  readonly workspaceId?: string;
  readonly userId?: string;
}): CompanionReleaseRouterPort {
  let verdict: Promise<CompanionReleaseVerdict | null> | null = null;
  if (args.workspaceId && args.userId) {
    // 生产路径：共享去标识语料一起打底，并按模型 id 每进程只读一次。
    void seedCompanionReleaseIndex({
      scopeKey: args.scopeKey, workspaceId: args.workspaceId, userId: args.userId, embed: args.embed,
      withSharedCorpus: true,
    }).catch(() => undefined);
  }
  return {
    mode: args.mode,
    evaluate() {
      verdict ??= evaluateCompanionRelease({
        scopeKey: args.scopeKey,
        text: args.text,
        recentMessages: args.recentMessages,
        activeLearningTask: args.activeLearningTask,
        embed: args.embed,
      }).catch(() => null);
      return verdict;
    },
  };
}

/** 历史轮次抽出来的一条打底样本（只含原话与 L2 标签，不含任何展示文本）。 */
export interface CompanionReleaseSeedRow {
  readonly text: string;
  readonly intent: string;
  readonly toolUse: string;
}

/**
 * 从库里的历史轮次抽出打底样本（纯函数）：`blocks` 里的 text 段拼成原话，
 * `turn_interpretation` 里的 intent/toolUse 作标签；形状不合的整行跳过。
 */
export function extractCompanionReleaseSeedRows(
  rows: readonly { readonly blocks: unknown; readonly turnInterpretation: unknown }[],
): CompanionReleaseSeedRow[] {
  const out: CompanionReleaseSeedRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.blocks)) continue;
    const text = row.blocks
      .filter((block): block is { type: "text"; text: string } => (
        typeof block === "object" && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      ))
      .map((block) => block.text)
      .join(" ")
      .trim();
    const interpretation = row.turnInterpretation as { intent?: unknown; toolUse?: unknown } | null;
    if (text.length === 0 || typeof interpretation?.intent !== "string" || typeof interpretation.toolUse !== "string") continue;
    out.push({ text, intent: interpretation.intent, toolUse: interpretation.toolUse });
  }
  return out;
}

const seededScopes = new Set<string>();

/**
 * 冷启动打底：从最近的历史轮次取最多 `maxSamples` 条（默认 24），逐条 embedding 后
 * 写进在线索引。每个账号每个进程只做一次；失败静默放弃（影子/放行都只是增益）。
 */
export async function seedCompanionReleaseIndex(args: {
  readonly scopeKey: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly embed: (text: string) => Promise<readonly number[] | null>;
  readonly thresholds?: CompanionReleaseThresholds;
  /** 测试注入：读历史行（缺省查库）。 */
  readonly load?: () => Promise<CompanionReleaseSeedRow[]>;
  /** 测试注入：读持久样本（缺省查库）。 */
  readonly loadStored?: () => Promise<CompanionReleaseStoredSample[]>;
  /** 测试注入：读共享语料（缺省读全局表）。 */
  readonly loadShared?: () => Promise<CompanionGateCorpusSample[]>;
  /**
   * 是否装共享语料。缺省 `false`：只有真正要放行的路径才去读它。
   * 这样单测里的 `seedCompanionReleaseIndex` 不会因为读全局表而拉起数据库连接池
   * （那会让测试进程挂着不退）。
   */
  readonly withSharedCorpus?: boolean;
}): Promise<void> {
  if (seededScopes.has(args.scopeKey)) return;
  const thresholds = args.thresholds ?? resolveCompanionReleaseThresholds();
  const index = scopeIndex(args.scopeKey);
  if (index.samples.length >= thresholds.minSamples) { seededScopes.add(args.scopeKey); return; }
  seededScopes.add(args.scopeKey);
  try {
    /**
     * 共享语料先装：它让"第一次说话的账号"也有近邻可查。
     * 放前、账号自己的样本放后——`indexStoredCompanionReleaseSamples` 超上限时从头部
     * `shift()`，于是账号自己的样本天然排在更靠后、更晚被挤掉的位置。
     */
    const wantShared = args.withSharedCorpus === true || args.loadShared !== undefined;
    const shared = wantShared
      ? args.loadShared
        ? await args.loadShared().catch(() => [])
        : await loadCompanionGateCorpus().catch(() => [])
      : [];
    for (const row of shared) {
      if (row.embedding.length === 0) continue;
      const key = `shared:${row.textSha256}:${row.intent}:${row.toolUse}`;
      if (index.seen.has(key)) continue;
      index.seen.add(key);
      index.samples.push({ vec: row.embedding, intent: row.intent, toolUse: row.toolUse });
    }
    // 先装"已带向量"的持久样本（零 embedding 成本），不够再拿历史轮次补。
    const stored = args.loadStored
      ? await args.loadStored()
      : args.workspaceId && args.userId
        ? await loadStoredCompanionReleaseSamples(args.workspaceId, args.userId).catch(() => [])
        : [];
    indexStoredCompanionReleaseSamples(args.scopeKey, stored);
    if (index.samples.length >= thresholds.minSamples) return;
    const rows = args.load
      ? await args.load()
      : await loadCompanionReleaseSeedRows(args.workspaceId, args.userId).catch(() => []);
    for (const row of rows.slice(0, Math.min(thresholds.maxSamples, 24))) {
      const normalized = row.text.trim().replace(/\s+/gu, " ");
      if (normalized.length === 0) continue;
      const key = `${row.intent}\u0000${row.toolUse}\u0000${normalized}`;
      if (index.seen.has(key)) continue;
      index.seen.add(key);
      const vec = await args.embed(normalized).catch(() => null);
      if (!vec || vec.length === 0) { index.seen.delete(key); continue; }
      index.samples.push({ vec, intent: row.intent, toolUse: row.toolUse });
      while (index.samples.length > thresholds.maxSamples) index.samples.shift();
    }
  } catch {
    // 打底失败不影响本轮：索引继续按在线样本生长。
  }
}

/** 测试用：允许同一个 scope 重新打底。 */
export function resetCompanionReleaseSeedingForTests(): void {
  seededScopes.clear();
}

export interface CompanionReleaseStoredSample {
  readonly textSha256: string;
  readonly intent: string;
  readonly toolUse: string;
  readonly embedding: readonly number[];
}

/**
 * 共享去标识语料的样本（迁移 0444）：只带向量与标签，不与账号绑定。
 * 用它给每个账号的索引打底——否则新装用户 0 条样本，L1 永远冷启动、永远不放行。
 */
export interface CompanionGateCorpusSample {
  readonly textSha256: string;
  readonly intent: string;
  readonly toolUse: string;
  readonly embedding: readonly number[];
}

const sharedCorpusLoads = new Map<string, Promise<CompanionGateCorpusSample[]>>();

/**
 * 共享语料**每进程只读一次**（按 embedding 模型 id 分缓存）。
 * 它不随账号变化，按账号缓存只会把同一份几百行重复拉 N 遍。
 */
export function loadCompanionGateCorpusOnce(modelKey: string): Promise<CompanionGateCorpusSample[]> {
  const cached = sharedCorpusLoads.get(modelKey);
  if (cached) return cached;
  const pending = loadCompanionGateCorpus().catch(() => [] as CompanionGateCorpusSample[]);
  sharedCorpusLoads.set(modelKey, pending);
  return pending;
}

/** 测试用：清空共享语料缓存。 */
export function resetCompanionGateCorpusForTests(): void {
  sharedCorpusLoads.clear();
}

export async function loadCompanionGateCorpus(limit = 2_000): Promise<CompanionGateCorpusSample[]> {
  const [{ sql }, { db }] = await Promise.all([import("drizzle-orm"), import("../../db.ts")]);
  // 语料是**全局表**（无 workspace 绑定），所以不走带作用域的事务。
  const rows = await db.execute<{ text_sha256: string; intent: string; tool_use: string; embedding: unknown }>(sql`
    SELECT text_sha256, intent, tool_use, embedding
    FROM public.companion_gate_corpus
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return rows
    .map((row) => ({ textSha256: String(row.text_sha256), intent: String(row.intent),
      toolUse: String(row.tool_use), embedding: asVector(row.embedding) ?? [] }))
    .filter((row) => row.embedding.length > 0);
}

/** jsonb → number[]：pg 驱动可能给数组也可能给字符串，两种都认。 */
function asVector(value: unknown): readonly number[] | null {
  let source: unknown = value;
  if (typeof value === "string") {
    try { source = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(source) || source.length === 0) return null;
  const numbers = source.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return numbers.length === source.length ? numbers : null;
}

/**
 * 把**已经带向量**的持久样本装回在线索引（纯函数）：不调 embedding、不重复入索引。
 * 返回新装进去的条数。
 */
export function indexStoredCompanionReleaseSamples(
  scopeKey: string,
  rows: readonly CompanionReleaseStoredSample[],
): number {
  const index = scopeIndex(scopeKey);
  let added = 0;
  for (const row of rows) {
    const vec = asVector(row.embedding);
    if (!vec) continue;
    const key = `sha:${row.textSha256}:${row.intent}:${row.toolUse}`;
    if (index.seen.has(key)) continue;
    index.seen.add(key);
    index.samples.push({ vec, intent: row.intent, toolUse: row.toolUse });
    added += 1;
  }
  return added;
}

async function workerDb(): Promise<{
  sql: typeof import("drizzle-orm").sql;
  withWorkerWorkspaceTransaction: typeof import("../../db.ts").withWorkerWorkspaceTransaction;
}> {
  const [{ sql }, { withWorkerWorkspaceTransaction }] = await Promise.all([
    import("drizzle-orm"), import("../../db.ts"),
  ]);
  return { sql, withWorkerWorkspaceTransaction };
}

/** 读回这个账号最近 256 条持久样本（重启后零 embedding 冷启动）。 */
export async function loadStoredCompanionReleaseSamples(
  workspaceId: string,
  userId: string,
  limit = 256,
): Promise<CompanionReleaseStoredSample[]> {
  const { sql, withWorkerWorkspaceTransaction } = await workerDb();
  const rows = await withWorkerWorkspaceTransaction({ workspaceId, userId }, async (tx) => tx.execute<{
    text_sha256: string; intent: string; tool_use: string; embedding: unknown;
  }>(sql`
    SELECT text_sha256, intent, tool_use, embedding
    FROM public.companion_release_router_samples
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `));
  return rows
    .map((row) => ({
      textSha256: String(row.text_sha256),
      intent: String(row.intent),
      toolUse: String(row.tool_use),
      embedding: asVector(row.embedding) ?? [],
    }))
    .filter((row) => row.embedding.length > 0);
}

/**
 * 落一条持久样本（fire-and-forget）：`ON CONFLICT` 只更新向量与时间，
 * 随后把该账号的旧行清到 512 条以内（索引只读 256 条，余量留给历史）。
 */
export async function persistCompanionReleaseSample(args: {
  readonly scopeKey: string;
  readonly text: string;
  readonly intent: string;
  readonly toolUse: string;
  readonly embedding: readonly number[];
}): Promise<void> {
  const scope = parseCompanionReleaseScopeKey(args.scopeKey);
  if (!scope || args.embedding.length === 0) return;
  const { sql, withWorkerWorkspaceTransaction } = await workerDb();
  const textSha256 = sha256Utf8V1(normalizeCompanionReleaseText(args.text));
  const embedding = JSON.stringify(args.embedding.map((value) => Number(Number(value).toFixed(6))));
  await withWorkerWorkspaceTransaction(scope, async (tx) => {
    await tx.execute(sql`
      INSERT INTO public.companion_release_router_samples
        (id, workspace_id, user_id, text_sha256, intent, tool_use, embedding)
      VALUES
        (${randomUUID()}, ${scope.workspaceId}, ${scope.userId}, ${textSha256},
         ${args.intent}, ${args.toolUse}, ${embedding}::jsonb)
      ON CONFLICT (workspace_id, user_id, text_sha256, intent, tool_use)
      DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now()
    `);
    await tx.execute(sql`
      DELETE FROM public.companion_release_router_samples
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND id NOT IN (
          SELECT id FROM public.companion_release_router_samples
          WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          ORDER BY updated_at DESC
          LIMIT 512
        )
    `);
  });
}

async function loadCompanionReleaseSeedRows(workspaceId: string, userId: string): Promise<CompanionReleaseSeedRow[]> {
  const { sql, withWorkerWorkspaceTransaction } = await workerDb();
  return withWorkerWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const rows = await tx.execute<{ blocks: unknown; turn_interpretation: unknown }>(sql`
      SELECT m.blocks, r.turn_interpretation
      FROM companion_turn_runs r
      JOIN companion_messages m ON m.id = r.user_message_id
      WHERE r.workspace_id = ${workspaceId} AND r.user_id = ${userId}
        AND r.turn_interpretation IS NOT NULL
        AND r.status = 'succeeded'
      ORDER BY r.created_at DESC
      LIMIT 24
    `);
    return extractCompanionReleaseSeedRows(rows.map((row) => ({
      blocks: row.blocks, turnInterpretation: row.turn_interpretation,
    })));
  });
}

/**
 * 影子期的 embedding 出口：和记忆召回走同一条治理边界（同意 + 数据外发政策 + 审计），
 * 不绕开 `resolveAIGovernanceContext`。任一步失败都返回 null，影子计算据此弃权。
 */
export function createCompanionReleaseEmbeddingPort(args: {
  readonly workspaceId: string;
  readonly userId: string;
  /** 真实 jobs 行（`ctx`）；审计的 `job_id` 只认它，不认 run/outbox id。 */
  readonly job: { readonly id: string };
}): (text: string) => Promise<readonly number[] | null> {
  let port: Promise<((text: string) => Promise<readonly number[] | null>) | null> | null = null;
  const createPort = async (): Promise<((text: string) => Promise<readonly number[] | null>) | null> => {
    try {
      const govCtx = await resolveAIGovernanceContext(args.workspaceId, args.userId);
      if (!govCtx.consentOk) return null;
      const raw: EmbeddingProviderLike | null = await createEmbeddingProvider(govCtx);
      if (!raw) return null;
      const governed = createGovernedEmbeddingProvider(raw, govCtx, args.workspaceId, {
        userId: args.userId,
        operation: "companion_release_router_embedding",
        jobId: args.job.id,
        dataCategories: ["user_answer"],
      });
      return (text: string) => governed.embed(text);
    } catch {
      return null;
    }
  };
  return async (text: string) => {
    port ??= createPort();
    const resolved = await port.catch(() => null);
    if (!resolved) return null;
    return resolved(text).catch(() => null);
  };
}
