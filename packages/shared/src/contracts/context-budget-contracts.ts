/**
 * 方案 44 §3.3／§4／§5 的共享合同：预算快照、完整请求计量、调用前压力判定与
 * 跨来源覆盖区间。
 *
 * 放在 shared 的理由（44 §7）：这些形状同时被 provider 能力快照（shared 契约）、
 * agent-core 的纯预算解析、worker 的真实调用面与数据库回执使用，是**共同合同**
 * 而不是某一个域的实现细节。agent-core 不导入 provider／数据库／handler，本文件
 * 也不含任何 node: 依赖（客户端可安全 import）。
 *
 * 三条口径（44 §4.1）是硬约定，重复实现它们就是重复引入已知的两个错误：
 *   - 80% 只作用在**触发线**上，不允许先对 B_hard 乘一次 0.8 再乘一次；
 *   - 系统协议、人格与工具定义已计入 P，不得再作为固定 RESERVED_TOKENS 扣一遍；
 *   - 供应商**独立**声明的输入硬上限与「窗口 − 最大输出」的派生值必须可区分，
 *     否则同一个约束会被当三个互不相关的数字重复扣减。
 */

import { z } from "zod";

/** 计量方法。优先级从高到低，与 44 §4.2「优先使用适配当前模型的计数能力」一致。 */
export const contextMeasurementMethodV1Schema = z.enum([
  /** 适配当前模型的 tokenizer 精确计数。 */
  "tokenizer",
  /** provider 自带的计数能力（count_tokens 之类）。 */
  "provider_count",
  /** 以相匹配请求的真实 usage 为锚点，只计新增内容。 */
  "usage_anchor",
  /** 保守估算——必须同时给出误差余量。 */
  "heuristic",
]);
export type ContextMeasurementMethodV1 = z.infer<typeof contextMeasurementMethodV1Schema>;

/** 能力本身的可信程度：预算的口径由谁担保。 */
export const contextBudgetConfidenceV1Schema = z.enum([
  /** provider／平台对本次路由的显式声明。 */
  "declared",
  /** 使用已登记的保守默认（能力不可获知时的兜底）。 */
  "registered_default",
]);
export type ContextBudgetConfidenceV1 = z.infer<typeof contextBudgetConfidenceV1Schema>;

/**
 * 输入硬上限 I 的来源。
 *
 * `derived` 是绝大多数 provider 的现状（maxInputTokens = 窗口 − 最大输出）。
 * 两者在 §4.1 的公式里取 min 即可，不构成重复扣减；但回执必须能说清**哪一个是派生值**，
 * 否则无法判断「迁移到独立硬限制后」会不会突然放宽。
 */
export const contextInputLimitSourceV1Schema = z.enum([
  "independent",
  "derived",
  "none",
]);
export type ContextInputLimitSourceV1 = z.infer<typeof contextInputLimitSourceV1Schema>;

/**
 * 预算快照：一次模型请求的容量读数。
 *
 * 它是**一次请求**的读数，不是用户级水位。多个后台调用的 token 消耗不会累加成本
 * 快照（44 §3.1）——调用成本按 turn／目标／维护作业另行累计。
 */
export const contextBudgetSnapshotV1Schema = z.object({
  version: z.literal(1),
  /** C：当前路由的有效上下文窗口。 */
  contextWindowTokens: z.number().int().nonnegative(),
  /** O：本轮实际采用的输出预留（含该路由计入输出的 reasoning）。 */
  outputReservationTokens: z.number().int().nonnegative(),
  /** I：provider 独立的输入硬上限；未单独声明时为 null。 */
  providerInputLimitTokens: z.number().int().nonnegative().nullable(),
  inputLimitSource: contextInputLimitSourceV1Schema,
  /** M：未完全可计量的协议开销与估算误差余量。 */
  overheadTokens: z.number().int().nonnegative(),
  /** B_hard = max(0, min(C - O, I) - M)。 */
  hardInputTokens: z.number().int().nonnegative(),
  /** T = floor(B_hard × 0.80)：默认压缩触发线。 */
  triggerTokens: z.number().int().nonnegative(),
  /** G = floor(B_hard × 0.60)：初始压缩目标。 */
  targetTokens: z.number().int().nonnegative(),
  triggerRatio: z.number().min(0).max(1),
  targetRatio: z.number().min(0).max(1),
  confidence: contextBudgetConfidenceV1Schema,
  /** 变更来源可追溯（44 §4.1）。只记字段来源，不记内容。 */
  provenance: z.array(z.object({
    field: z.enum(["C", "O", "I", "M", "trigger", "target"]),
    source: z.string().min(1).max(80),
  }).strict()).min(1).max(12),
}).strict();
export type ContextBudgetSnapshotV1 = z.infer<typeof contextBudgetSnapshotV1Schema>;

/**
 * 完整请求的输入计量 P。
 *
 * `parts` 是给回执看的：哪一部分被计入了、哪一部分只是保守地板。`unmeasured`
 * 非空表示存在**已知无法精确计量**的载荷（多模态、provider 不透明字段）——
 * 它们不能被记作零，也不能因为「反正记不下来」就不出现在回执里（44 §4.2）。
 */
export const contextRequestMeasurementV1Schema = z.object({
  version: z.literal(1),
  /** P：最终完整请求的输入 token 计量／估算。 */
  inputTokens: z.number().int().nonnegative(),
  method: contextMeasurementMethodV1Schema,
  parts: z.object({
    system: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
    /** 多模态等不透明载荷的保守地板成本（不为零，但也不假装精确）。 */
    multimodal: z.number().int().nonnegative(),
  }).strict(),
  /** 已知无法精确计量的载荷种类（"image" / "reasoning_handle" / …）。 */
  unmeasured: z.array(z.string().min(1).max(40)).max(12),
  /** 估算误差余量（token）。exact 方法下为 0。 */
  errorMarginTokens: z.number().int().nonnegative(),
  /** 计量口径版本。provider 序列化规则变化后旧锚点必须失效。 */
  measurementVersion: z.string().min(1).max(60),
}).strict();
export type ContextRequestMeasurementV1 = z.infer<typeof contextRequestMeasurementV1Schema>;

/** 压力判定的原因。区分「需要压缩」「压不动」「放不下」，处置完全不同。 */
export const contextPressureReasonV1Schema = z.enum([
  /** 在触发线以内，正常发送。 */
  "within_budget",
  /** 超过触发线但仍在硬上限内；压不动就带着有效上下文继续（44 §5.4）。 */
  "over_trigger_line",
  /** 超过硬上限，且本轮没有可用的压缩路径。 */
  "over_hard_limit",
  /** 超过触发线且有压缩端口，但压缩已在本轮用过一次（44 §5.4 默认至多一次）。 */
  "compaction_budget_spent",
  /** 必要内容自身就超过硬上限——如实报出限制，不能静默切掉问题尾部。 */
  "required_content_overflows",
  /** 预算无法解析（能力不可获知且无登记兜底）。 */
  "budget_unresolved",
]);
export type ContextPressureReasonV1 = z.infer<typeof contextPressureReasonV1Schema>;

/**
 * 调用前判定。
 *
 * `outcome = "compact"` 表示**本次请求先不发送**，由持有工作上下文的调用方执行
 * 一次有界压缩后重新装配并重新计量（44 §4.3）。core 只做判定，不替调用方删内容。
 */
export const contextPressureDecisionV1Schema = z.object({
  version: z.literal(1),
  outcome: z.enum(["send", "compact", "reject"]),
  reason: contextPressureReasonV1Schema,
  inputTokens: z.number().int().nonnegative(),
  hardInputTokens: z.number().int().nonnegative(),
  triggerTokens: z.number().int().nonnegative(),
  targetTokens: z.number().int().nonnegative(),
  /** 可行动的下一步。reject 时必须给出真实限制而不是空话。 */
  detail: z.string().max(500).nullable(),
}).strict();
export type ContextPressureDecisionV1 = z.infer<typeof contextPressureDecisionV1Schema>;

/**
 * 跨来源覆盖区间（44 §3.3）。
 *
 * 沿用各源流的局部序号；跨源覆盖记录 (sourceKind, sourceId, revision, seq/range, hash)。
 * 不带 conversationId 的单一 fromSeq/throughSeq 假装覆盖所有来源——那种形状无法
 * 区分「两个会话的同号桶」。
 */
export const contextCoverageSpanV1Schema = z.object({
  sourceKind: z.string().min(1).max(60),
  sourceId: z.string().min(1).max(240),
  revision: z.number().int().nonnegative(),
  fromSeq: z.number().int().nonnegative().nullable(),
  throughSeq: z.number().int().nonnegative().nullable(),
  /** 来源哈希：提交前重查用，也是「同一区间重复触发只产生同一次提交」的前提。 */
  hash: z.string().min(1).max(128),
}).strict();
export type ContextCoverageSpanV1 = z.infer<typeof contextCoverageSpanV1Schema>;

/**
 * 覆盖清单：一条压缩结论到底盖住了哪些来源区间。
 *
 * 结构化覆盖只证明**源区间关系**，不证明语义完整（44 §5.1）；保留 uncovered 与
 * retrieve 入口，才能让「摘要短了」和「关键约束还在」不是同一件事。
 */
export const contextCoverageManifestV1Schema = z.object({
  version: z.literal(1),
  spans: z.array(contextCoverageSpanV1Schema).min(1).max(200),
  /** 已知未覆盖的区间；非空时调用方必须知道自己有盲区。 */
  uncovered: z.array(contextCoverageSpanV1Schema).max(200),
  /** 原文取回入口（按来源键，不预取全文）。 */
  retrieval: z.array(z.object({
    sourceKind: z.string().min(1).max(60),
    sourceId: z.string().min(1).max(240),
    locator: z.string().min(1).max(240),
  }).strict()).max(50),
}).strict();
export type ContextCoverageManifestV1 = z.infer<typeof contextCoverageManifestV1Schema>;
/**
 * 落库的完整请求预算回执（44 §3.3／§4）。
 *
 * 「窗口放大后触发变少」与「预算从来没接上」在日志里长得一样；落到 run 上之后才
 * 分得开。只记模型路由、三个水位、计量方法与判定，**不记任何请求内容**。
 */
export const contextPressureReceiptV1Schema = z.object({
  version: z.literal(1),
  providerId: z.string().min(1).max(80),
  modelId: z.string().min(1).max(120),
  operation: z.string().min(1).max(120),
  contextWindowTokens: z.number().int().nonnegative(),
  outputReservationTokens: z.number().int().nonnegative(),
  providerInputLimitTokens: z.number().int().nonnegative().nullable(),
  inputLimitSource: contextInputLimitSourceV1Schema,
  overheadTokens: z.number().int().nonnegative(),
  hardInputTokens: z.number().int().nonnegative(),
  triggerTokens: z.number().int().nonnegative(),
  targetTokens: z.number().int().nonnegative(),
  confidence: contextBudgetConfidenceV1Schema,
  inputTokens: z.number().int().nonnegative(),
  method: contextMeasurementMethodV1Schema,
  /** 已知无法精确计量的载荷种类；非空表示这条读数偏保守。 */
  unmeasured: z.array(z.string().min(1).max(40)).max(12),
  errorMarginTokens: z.number().int().nonnegative(),
  outcome: z.enum(["send", "compact", "reject"]),
  reason: contextPressureReasonV1Schema,
}).strict();
export type ContextPressureReceiptV1 = z.infer<typeof contextPressureReceiptV1Schema>;
