/**
 * 运维面板的指标视图（`/admin/metrics`）。
 *
 * ## 为什么不是把 `/metrics` 的文本塞进一个 <pre>
 *
 * `/metrics` 是给 Prometheus 抓的：PromQL 能查询、能在告警里用、能保留全标签。
 * 人打开面板时想要的是另一组东西——「有没有 5xx」「最慢的三个接口是哪几个」
 * 「outbox 堵在哪一类命令上」。这些答案要么需要跨指标做算术，要么需要排序与
 * 取前 N，都是 Prometheus **不提供**的（它是存储，不是查询引擎）。
 *
 * 所以这里读同一个 `registry`，把它变成**已经算好的答案**。数据源不新增：
 * 面板与 `/metrics` 永远说的是同一批数字，不会出现两处不一致。
 *
 * ## 分位数是估算
 *
 * 直方图分位数由累计桶插值得出（与 Prometheus `histogram_quantile` 同一口径），
 * 因此是**估算值**。面板上标 `estimated`，并且不把估算值用于任何判定——
 * 告警仍然建在 `/metrics` 的原始序列上。桶边界之外的样本会被归到最高桶，
 * 这会让 p99 偏小，所以最高桶（+Inf）不参与插值，只用来算"超出最高桶的比例"，
 * 由 {@link MetricSeries.overflowRatio} 单独暴露。
 *
 * ## 隐私
 *
 * 指标本身已经是低基数 allowlist（ADR-0006 §4：绝不记录正文、密钥、完整
 * query）。本服务**不新增**任何维度——路由模板已经过 `normalizeRouteTemplate`
 * 把 UUID/数字换成 `:id`，所以回传给浏览器的 `route` 标签里不含路径参数。
 */

import { parseBucketBound, registry } from "../../lib/metrics.ts";
import { METRIC_FAMILY_LABELS } from "./labels.ts";

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSummary {
  /** 分组键：除 `__name__` / `le` 外的真实标签（method、route、…）。 */
  labels: Record<string, string>;
  count: number;
  sum: number;
  /** 桶内插值估算。样本落在最高桶（+Inf）之外时不计入，故可能偏小。 */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** 样本落在最高有限桶之上的比例。这是分位数被压低的真实程度。 */
  overflowRatio: number | null;
  max: number | null;
}

export interface MetricSeries {
  /** 原始标识（指标名）。保留是因为告警集成与排查仍然需要它。 */
  name: string;
  /** 人话名；未收录时为 null，前端据此决定回落到 name。 */
  label: string | null;
  help: string;
  type: "counter" | "gauge" | "histogram";
  samples: MetricSample[];
  /** type === "histogram" 时按 labels 分组后的分位数摘要。 */
  histograms?: HistogramSummary[];
}

export interface MetricsSnapshot {
  collectedAt: string;
  business: MetricSeries[];
  process: MetricSeries[];
  /** 面板顶部那几个大数，直接算好，前端不重复算一遍。 */
  headline: {
    httpRequestsTotal: number;
    httpErrors5xxTotal: number;
    httpSuccessRate: number | null;
    dbPoolActive: number | null;
    dbTransactionFailures: number;
    dbRlsDenied: number;
    outboxPendingTotal: number;
    outboxOldestPendingSeconds: number | null;
    /** event_loop_lag 的当前值（秒）。nodejs 默认指标里才有。 */
    eventLoopLagSeconds: number | null;
    heapUsedBytes: number | null;
    rssBytes: number | null;
  };
  /** 最慢的 HTTP 路由（按 p95 降序，取前 N）。 */
  slowestRoutes: Array<{ method: string; route: string; p95: number | null; count: number }>;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 由累计桶插值估算分位数。
 *
 * 与 Prometheus `histogram_quantile` 同口径：在命中桶内**线性插值**，并跳过
 * `+Inf` 桶（最后一个桶只用于判断是否溢出）。返回值 null 表示"样本不足，
 * 别假装有 p95"——面板上画一条 p95=0 的线比不画更糟。
 */
export function estimateQuantile(
  buckets: Array<{ le: number; count: number }>,
  quantile: number,
): number | null {
  const finite = buckets
    .filter((bucket) => Number.isFinite(bucket.le))
    .sort((a, b) => a.le - b.le);
  if (finite.length === 0) return null;

  // **分母必须是样本总数，不是最高有限桶的累计数**。
  // 累计桶里 `+Inf` 那一条才是总样本量；用它之前那个值会得到一个
  // 严重偏小的分母，于是「很多样本超过最高有限桶」时 p95 会被压到
  // 最高桶的下沿——看起来像"接口很快"，实际是桶不够用。
  const total = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  if (total <= 0) return null;

  const target = total * quantile;
  let previousCount = 0;
  let previousLe = finite[0].le;
  for (const bucket of finite) {
    if (bucket.count >= target) {
      const span = bucket.count - previousCount;
      const within = span > 0 ? (target - previousCount) / span : 0;
      return previousLe + (bucket.le - previousLe) * within;
    }
    previousCount = bucket.count;
    previousLe = bucket.le;
  }
  // 目标分位落在最高有限桶之上：如实返回最高桶上界，由 overflowRatio 补充说明。
  return finite[finite.length - 1].le;
}

/** 把 prom-client 的一族 histogram 拆成按 labels 分组的分位数摘要。 */
function summarizeHistogram(familyName: string, values: RawMetricSample[]): HistogramSummary[] {
  interface Group {
    labels: Record<string, string>;
    buckets: Array<{ le: number; count: number }>;
    count: number;
    sum: number;
  }
  const groups = new Map<string, Group>();

  for (const item of values) {
    const labels = item.labels ?? {};
    // prom-client 用**合成标签**区分同一条时间序列的三种聚合：
    // `<name>_bucket`（额外带 le）、`<name>_sum`、`<name>_count`。
    // 分组键必须排除 __name__ 与 le——它们标识的是"哪一种聚合"，不是"哪条序列"。
    const seriesLabels: Record<string, string> = {};
    for (const [name, value] of Object.entries(labels)) {
      if (name === "__name__" || name === "le") continue;
      seriesLabels[name] = String(value);
    }
    const key = Object.entries(seriesLabels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${value}`)
      .join(",");

    let group = groups.get(key);
    if (!group) {
      group = { labels: seriesLabels, buckets: [], count: 0, sum: 0 };
      groups.set(key, group);
    }

    // **聚合种类在 `metricName` 上**（`<name>_bucket` / `_sum` / `_count`），
    // 不在 `labels.__name__` 上——后者在 prom-client v15 里根本不存在。
    // 读错的后果是三种聚合全部分类失败，count/分位数恒为 0 或 null。
    const suffix = String(item.metricName ?? familyName);
    if (suffix.endsWith("_bucket")) {
      group.buckets.push({ le: parseBucketBound(labels.le), count: toNumber(item.value) });
    } else if (suffix.endsWith("_sum")) {
      group.sum = toNumber(item.value);
    } else if (suffix.endsWith("_count")) {
      group.count = toNumber(item.value);
    }
  }

  return [...groups.values()].map((group) => {
    const finiteBuckets = group.buckets.filter((bucket) => Number.isFinite(bucket.le));
    const highestFinite = finiteBuckets.length > 0 ? Math.max(...finiteBuckets.map((b) => b.le)) : null;
    // 落在最高有限桶**之内**（含）的样本数；超出部分才计入溢出。
    const withinHighest = highestFinite === null
      ? 0
      : group.buckets.find((bucket) => bucket.le === highestFinite)?.count ?? 0;
    const overflow = group.count > 0 ? Math.max(0, (group.count - withinHighest) / group.count) : 0;
    return {
      labels: group.labels,
      count: group.count,
      sum: group.sum,
      p50: estimateQuantile(group.buckets, 0.5),
      p95: estimateQuantile(group.buckets, 0.95),
      p99: estimateQuantile(group.buckets, 0.99),
      overflowRatio: overflow,
      max: highestFinite,
    };
  });
}


/**
 * prom-client 的 `MetricValue` 类型里**没有** `metricName`，
 * 但运行时对象上确实有（直方图靠它区分 bucket/sum/count）。
 *
 * 这是上游类型窄于实际形状，不是我们漏声明字段。做法是在这一个边界上
 * 显式扩一次形状，而不是在每一处读它的地方各写一个 cast——
 * 否则下一次升级 prom-client 时，这个偏差会散成七个断言。
 */
type RawMetricSample = {
  value: number | string;
  labels?: Record<string, string>;
  metricName?: string;
};

function findSeries(all: MetricSeries[], name: string): MetricSeries | undefined {
  return all.find((series) => series.name === name);
}

function sumSamples(series: MetricSeries | undefined, labelMatch?: Record<string, string>): number {
  if (!series) return 0;
  return series.samples.reduce((acc, sample) => {
    const matches = Object.entries(labelMatch ?? {}).every(([key, value]) => sample.labels[key] === value);
    return matches ? acc + toNumber(sample.value) : acc;
  }, 0);
}

export async function readMetricsSnapshot(): Promise<MetricsSnapshot> {
  // 人话名从 labels.ts 注入（下面单独 import，避免这里出现文案逻辑）。
  // prom-client v15 的 `getMetricsAsJSON()` 直接返回**数组**（v12 及更早是
  // `{ version, metrics }` 包装）。这里按 v15 的形状读。
  const families = await registry.getMetricsAsJSON();
  const business: MetricSeries[] = [];
  const process: MetricSeries[] = [];

  for (const family of families) {
    const series: MetricSeries = {
      name: family.name,
      /** 人话名。没有收录的家族**原样留空**（前端回落到标识），
       *  不猜——猜错的解释比裸露的标识更糟。 */
      label: METRIC_FAMILY_LABELS[family.name] ?? null,
      help: family.help,
      // prom-client 的 MetricType 与我们的窄联合不同名同义，走一次显式桥接。
      type: family.type as unknown as MetricSeries["type"],
      samples: family.values.map((item) => ({
        labels: Object.fromEntries(
          Object.entries((item.labels ?? {}) as Record<string, string>).filter(([name]) => name !== "__name__"),
        ),
        value: toNumber(item.value),
      })),
    };
    if (series.type === "histogram") {
      series.histograms = summarizeHistogram(
        family.name,
        (family.values as unknown as RawMetricSample[]).map((item) => ({
          labels: item.labels ?? {},
          // metricName 决定这是桶 / 和 / 条数哪一种聚合，必须原样带过来。
          metricName: String(item.metricName ?? family.name),
          value: toNumber(item.value),
        })),
      );
    }
    if (family.name.startsWith("ailearn_")) business.push(series);
    else process.push(series);
  }

  const all = [...business, ...process];
  const httpRequests = sumSamples(findSeries(all, "ailearn_http_requests_total"));
  const http5xx = sumSamples(findSeries(all, "ailearn_http_errors_5xx_total"));

  const latencySeries = findSeries(all, "ailearn_http_request_duration_seconds");
  const slowestRoutes = (latencySeries?.histograms ?? [])
    .filter((histogram) => typeof histogram.labels.method === "string" && typeof histogram.labels.route === "string")
    .map((histogram) => ({
      method: histogram.labels.method,
      route: histogram.labels.route,
      p95: histogram.p95,
      count: histogram.count,
    }))
    // 只看真的有流量的路由：样本为 0 的 p95 是插值算出来的假数字。
    .filter((row) => row.count > 0)
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .slice(0, 8);

  const outboxDepth = findSeries(all, "ailearn_learning_run_processing_outbox_depth");
  const outboxAge = findSeries(all, "ailearn_learning_run_processing_outbox_oldest_pending_age_seconds");

  return {
    collectedAt: new Date().toISOString(),
    business: business.sort((a, b) => a.name.localeCompare(b.name)),
    process: process.sort((a, b) => a.name.localeCompare(b.name)),
    headline: {
      httpRequestsTotal: httpRequests,
      httpErrors5xxTotal: http5xx,
      // 只有发出过请求时才算比率；0 请求时给 null 而不是 100%——
      // "成功率 100%" 在没有任何请求时是个误导性的好消息。
      httpSuccessRate: httpRequests > 0 ? (httpRequests - http5xx) / httpRequests : null,
      dbPoolActive: findSeries(all, "ailearn_db_pool_active_connections")?.samples[0]?.value ?? null,
      dbTransactionFailures: sumSamples(findSeries(all, "ailearn_db_transaction_failures_total")),
      dbRlsDenied: sumSamples(findSeries(all, "ailearn_db_rls_denied_total")),
      outboxPendingTotal: sumSamples(outboxDepth),
      outboxOldestPendingSeconds: outboxAge?.samples.length
        ? Math.max(...outboxAge.samples.map((sample) => sample.value))
        : null,
      eventLoopLagSeconds: findSeries(all, "nodejs_eventloop_lag_seconds")?.samples[0]?.value ?? null,
      heapUsedBytes: findSeries(all, "nodejs_heap_size_used_bytes")?.samples[0]?.value ?? null,
      rssBytes: findSeries(all, "process_resident_memory_bytes")?.samples[0]?.value ?? null,
    },
    slowestRoutes,
  };
}