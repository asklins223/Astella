/**
 * 跨进程共享的指标**定义**（P1-20）。
 *
 * ## 为什么只有定义、没有实例
 *
 * 这 3 个指标此前在 `apps/api/src/lib/metrics.ts` 与
 * `workers/ai-worker/src/lib/metrics.ts` 里**各写一遍**，且经逐字节比对确认
 * 两个进程里的声明块**完全相同**（含 help 文本与 Histogram 的桶）。
 * 两个进程各有各的 `Registry`（不能共用一个——那是两个独立进程的内存），
 * 所以**实例**天然要各建一份；但**定义**没有理由写两遍。
 *
 * 这里刻意不 import `prom-client`：契约包不该为了三个指标常量而多一个运行时
 * 依赖（那会把 shared 从"数据与契约"推向"运行时框架"，与 P2 计划里
 * contracts / db-schema / domain 的切分方向相反）。
 * 所以本模块只导出**纯定义**，各进程自己 `new Counter({ ...def, registers: [registry] })`。
 *
 * ## 定义漂移会怎样
 *
 * `help` 或 `labelNames` 不一致时，Prometheus 端表现为同一个指标名下
 * 两套元数据——聚合时 label 对不上，告警规则静默少算。
 * 这类差异**不会**让任何现有测试变红，所以两个进程各自都有一条守卫
 * （`companion-metrics-guard.test.ts`）盯住"本进程不得重新声明这些名字"。
 *
 * ## help 与桶的文本是照抄原声明的
 *
 * 它们不是新写的描述。改 help 会让告警面板上的图例与既有 runbook 对不上，
 * 改桶会改变直方图的分位数——两者都属于"看起来是措辞、实际上是数据契约"。
 */

/** `astella_companion_summary_total` —— 伴星日摘要产出，按结果。Counter。 */
export const COMPANION_SUMMARY_TOTAL_DEF = Object.freeze({
  kind: "counter" as const,
  name: "astella_companion_summary_total",
  help: "Companion summarizer task results",
  labelNames: ["status"] as const,
});

/**
 * `astella_companion_memory_used_count` —— 单次伴星对话轮里用到的长期记忆条数。
 *
 * **Histogram 而不是 Gauge**：名字里的 `_count` 是 prom-client 对 histogram
 * 输出的后缀（`<name>_count` / `<name>_sum` / `<name>_bucket`），
 * 改成 Gauge 会让这三个时间序列凭空消失。桶 `[0..8]` 是原样搬过来的。
 */
export const COMPANION_MEMORY_USED_COUNT_DEF = Object.freeze({
  kind: "histogram" as const,
  name: "astella_companion_memory_used_count",
  help: "Number of memories used per companion dialogue turn",
  buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8] as const,
  labelNames: [] as const,
});

/** `astella_companion_memory_retrieval_mode_total` —— 记忆检索走了哪条路。Counter。 */
export const COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF = Object.freeze({
  kind: "counter" as const,
  name: "astella_companion_memory_retrieval_mode_total",
  help: "Companion memory retrieval mode (vector or keyword_fallback)",
  labelNames: ["mode"] as const,
});

/**
 * 上面三个定义的名字列表——给两侧的守卫用。
 * 守卫判据是「本进程不得再声明这些名字」，所以这张表本身就是判据。
 */
export const SHARED_COMPANION_METRIC_NAMES: readonly string[] = Object.freeze([
  COMPANION_SUMMARY_TOTAL_DEF.name,
  COMPANION_MEMORY_USED_COUNT_DEF.name,
  COMPANION_MEMORY_RETRIEVAL_MODE_TOTAL_DEF.name,
]);
