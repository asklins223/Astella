/**
 * 指标的**时序**快照 —— 运维面板图表的数据源。
 *
 * ## 为什么不能直接画 registry
 *
 * `registry` 里只有**进程启动以来的累计值**（counter）与**此刻的瞬时值**（gauge）。
 * 累计值画成折线是一条单调上升的直线：它看起来有"形状"，但读不出任何速率
 * ——「一分钟内涨了 300」和「一小时才涨了 300」在这条线上长得一模一样。
 * 而「现在有没有 run 卡在 assessing」这类问题问的恰恰是**变化**。
 *
 * 所以这里按固定节奏采样，把累计值差分成速率、把 gauge 记成点值，
 * 存成一个**有界的最近窗口**，供面板画趋势。
 *
 * ## 边界
 *
 * 与日志缓冲同理：进程内、不落盘、重启即清空、窗口只有 {@link DEFAULT_WINDOW_MS}。
 * 它回答「最近这段时间怎么样」，不回答「昨天傍晚那次抖动是怎么回事」——
 * 后者属于 Prometheus 保留的历史序列，面板不与它竞争。
 *
 * ## 采样代价
 *
 * registry 采样是纯内存读取（prom-client 的 metrics 已经在进程里），不碰 IO；
 * 队列深度需要一次跨租户函数调用，频率因此**更慢**。两个节奏分开的原因就在这里：
 * 为了多画几个点而每 5 秒打一次库不划算。
 */

import { parseBucketBound, registry } from "./metrics.ts";
import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";

/** 默认窗口：30 分钟。12 个点 × 15 秒够看趋势，再密也不会让人读出更多。 */
export const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

/** 默认采样间隔。 */
export const SAMPLE_INTERVAL_MS = 15 * 1000;

/** 队列深度的采样间隔（更慢——这一条要打一次库）。 */
export const QUEUE_SAMPLE_INTERVAL_MS = 30 * 1000;

/** 采样口径里关心的那几条曲线。 */
export interface MetricsPoint {
  /** 采样时刻（epoch ms）。 */
  t: number;
  /** 每分钟请求数（由累计值差分得到，秒级换算）。
   *  **首个采样点为 null**：没有"上一次"可差分。面板据此把曲线起点留空，
   *  而不是画一条从 0 起的假直线。 */
  requestsPerMinute: number | null;
  /** 每分钟 5xx 数。与 requestsPerMinute 同口径（同为 null 起步）。 */
  errorsPerMinute: number | null;
  /** HTTP p95 延迟（秒）。由直方图桶插值，与 /metrics 同口径。 */
  p95Seconds: number | null;
  /** 事件循环延迟（秒）。 */
  eventLoopLagSeconds: number | null;
  /** 堆内存（字节）。 */
  heapUsedBytes: number | null;
  /** 连接池活跃连接数。 */
  poolActive: number | null;
  /** 就绪状态（1/0）。 */
  ready: number | null;
  /** 结算 outbox 待处理总量。 */
  outboxPending: number | null;
  /** 队列 pending 总量；**仅队列节奏的采样点有值**，其余为 null。
   *  刻意用 null 而不是沿用上次值：一条按 30 秒节奏更新的曲线，
   *  混进 15 秒节奏的曲线里会让人误读它的分辨率。 */
  queuePending: number | null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 由累计桶插值 p95，与 metrics-service 的 estimateQuantile 同一口径。 */
function p95FromBuckets(buckets: Array<{ le: number; count: number }>): number | null {
  const finite = buckets.filter((b) => Number.isFinite(b.le)).sort((a, b) => a.le - b.le);
  if (finite.length === 0) return null;
  const total = buckets.reduce((max, b) => Math.max(max, b.count), 0);
  if (total <= 0) return null;
  const target = total * 0.95;
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
  return finite[finite.length - 1].le;
}

interface RegistrySample {
  t: number;
  requestsTotal: number;
  errors5xxTotal: number;
  p95Seconds: number | null;
  eventLoopLag: number | null;
  heapUsed: number | null;
  outboxPending: number | null;
  poolActive: number | null;
  ready: number | null;
}

async function readRegistrySample(): Promise<RegistrySample> {
  const families = await registry.getMetricsAsJSON();
  let requestsTotal = 0;
  let errors5xxTotal = 0;
  let eventLoopLag: number | null = null;
  let heapUsed: number | null = null;
  let outboxPending = 0;
  let poolActive: number | null = null;
  let ready: number | null = null;
  let p95Seconds: number | null = null;

  // 全站 p95：把该族所有 (method, route) 分组的桶按 le 合并后再算，
  // 否则算出来的是"最后一个路由的 p95"——而面板上它标的是"全站"。
  const latencyBuckets = new Map<number, number>();

  for (const family of families) {
    switch (family.name) {
      case "astella_http_requests_total":
        for (const sample of family.values) requestsTotal += toNumber(sample.value);
        break;
      case "astella_http_errors_5xx_total":
        for (const sample of family.values) errors5xxTotal += toNumber(sample.value);
        break;
      case "nodejs_eventloop_lag_seconds":
        eventLoopLag = toNumber(family.values[0]?.value);
        break;
      case "nodejs_heap_size_used_bytes":
        heapUsed = toNumber(family.values[0]?.value);
        break;
      case "astella_learning_run_processing_outbox_depth":
        for (const sample of family.values) outboxPending += toNumber(sample.value);
        break;
      case "astella_db_pool_active_connections":
        poolActive = toNumber(family.values[0]?.value);
        break;
      case "astella_readiness_status":
        ready = toNumber(family.values[0]?.value);
        break;
      case "astella_http_request_duration_seconds": {
        let count = 0;
        for (const sample of family.values) {
          const labels = (sample.labels ?? {}) as Record<string, string>;
          // **聚合种类在 `metricName` 上，不在 `labels.__name__` 上。**
          // prom-client v15 的形状是 `{ value, metricName, exemplar, labels }`，
          // 而 `labels` 里只有真实标签（le / method / route）。
          // 读错字段的后果不报错：三种聚合全部分类失败，p95 恒为 null，
          // 面板上"响应耗时"那条线永远是空的。
          const name = String((sample as { metricName?: string }).metricName ?? "");
          if (name.endsWith("_bucket")) {
            const le = parseBucketBound(labels.le);
            latencyBuckets.set(le, (latencyBuckets.get(le) ?? 0) + toNumber(sample.value));
          } else if (name.endsWith("_count")) {
            count += toNumber(sample.value);
          }
        }
        if (count > 0) {
          p95Seconds = p95FromBuckets(
            [...latencyBuckets.entries()].map(([le, c]) => ({ le, count: c })),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return { t: Date.now(), requestsTotal, errors5xxTotal, p95Seconds, eventLoopLag, heapUsed, outboxPending, poolActive, ready };
}

export class MetricsSeriesBuffer {
  readonly windowMs: number;
  #points: MetricsPoint[] = [];

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  push(point: MetricsPoint): void {
    this.#points.push(point);
    const cutoff = point.t - this.windowMs;
    while (this.#points.length > 0 && this.#points[0].t < cutoff) this.#points.shift();
  }

  recent(): MetricsPoint[] {
    return [...this.#points];
  }

  get size(): number {
    return this.#points.length;
  }

  /** 实际覆盖的时间跨度。窗口没攒满时用它替代标称窗口，避免图看起来"很短"。 */
  get spanMs(): number {
    if (this.#points.length < 2) return 0;
    return this.#points[this.#points.length - 1].t - this.#points[0].t;
  }

  clear(): void {
    this.#points = [];
  }
}

export const adminMetricsSeries = new MetricsSeriesBuffer();

let previous: RegistrySample | null = null;

/**
 * 采一个点。
 *
 * 速率由**相邻两次**累计值差分得到，所以第一个点必然是 null（没有"上一次"）。
 * 面板据此把速率图的起点留空，而不是画一条从 0 起的假直线。
 */
export async function sampleMetricsSeries(includeQueue = false): Promise<MetricsPoint | null> {
  const now = Date.now();
  let sample: RegistrySample;
  try {
    sample = await readRegistrySample();
  } catch {
    // 采样失败不抛：它是一个后台周期任务，抛出去只会打崩进程或刷屏。
    return null;
  }

  const intervalSeconds = previous ? Math.max(1, (now - previous.t) / 1000) : null;
  const requestsPerMinute = previous && intervalSeconds
    ? Math.max(0, ((sample.requestsTotal - previous.requestsTotal) / intervalSeconds) * 60)
    : null;
  const errorsPerMinute = previous && intervalSeconds
    ? Math.max(0, ((sample.errors5xxTotal - previous.errors5xxTotal) / intervalSeconds) * 60)
    : null;

  let queuePending: number | null = null;
  if (includeQueue) {
    try {
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n
        FROM public.jobs
        WHERE status = 'pending'
      `)) as unknown as Array<Record<string, unknown>>;
      queuePending = toNumber(rows[0]?.n);
    } catch {
      queuePending = null;
    }
  }

  const point: MetricsPoint = {
    t: now,
    requestsPerMinute: requestsPerMinute ?? null,
    errorsPerMinute: errorsPerMinute ?? null,
    p95Seconds: sample.p95Seconds,
    eventLoopLagSeconds: sample.eventLoopLag,
    heapUsedBytes: sample.heapUsed,
    poolActive: sample.poolActive,
    ready: sample.ready,
    outboxPending: sample.outboxPending,
    queuePending,
  };

  previous = sample;
  adminMetricsSeries.push(point);
  return point;
}

/** 重置差分基准（测试与热重启用）。 */
export function resetMetricsSeries(): void {
  previous = null;
  adminMetricsSeries.clear();
}