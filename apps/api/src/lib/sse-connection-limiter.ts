/**
 * SSE 长连接并发上限（2026-10-03）。
 *
 * ─── 为什么需要它 ───────────────────────────────────────────────────────
 * SSE 连接被 `reply.hijack()` 之后就不再经过 Fastify 的请求生命周期：它不占
 * worker 槽位、不受任何请求超时约束，一个用户可以开出任意多条。对桌面端这种
 * 单用户多窗口的场景，一个客户端重连失败留下的半开连接就足以长期占住一条。
 *
 * 实测这个缺口是真实存在的：`companion/deliveries/inbox/stream` 自己写了每用户
 * 5 槽的上限（内联在路由文件里），而另外两条长连事件流——
 *   `GET /learning-runs/:runId/events`  （run-routes.ts）
 *   `GET /card-generation-v2/runs/:runId/events`（card-generation-v2/routes.ts）
 * ——校验完 Last-Event-ID 就直接 `hijack()`，**一个上限都没有**。
 *
 * 于是本模块把 inbox 那套内联模式收成公共层，让三条路由共用，并补上一个它
 * 原本没有的维度：**进程级总上限**。每用户上限挡住"一个用户开爆"，总上限挡住
 * "很多用户各开几条"的加总——后者才是真正吃内存、吃文件描述符的那个。
 *
 * ─── 作用域的诚实说明 ───────────────────────────────────────────────────
 * 计数是**单进程内存态**。多副本部署时每个副本各自持有上限，真实总上限是
 * `副本数 × 本上限`；这与 inbox 原有的部署标注是同一条纪律。横向扩展前需要
 * 换成共享存储（Redis/Postgres）才能得到全局上限——本模块的接口按"换存储"
 * 的形状设计（acquire/release 对称、可注入上限），但不在此处假装解决它。
 */
import { sseActiveStreams, sseRejectedTotal } from "./metrics.ts";

/** 每用户默认上限。原 inbox 路由用的是 5，沿用它作为默认值。 */
export const DEFAULT_SSE_MAX_STREAMS_PER_USER = 5;

/**
 * 进程级默认总上限。
 *
 * 取 200：单进程实测稳定并发请求约 850 rps，而 SSE 连接几乎不干活（等 NOTIFY
 * 或心跳）。200 条常驻流对事件循环是可忽略的负载，却足以让"连接泄漏"这件事
 * 在监控上立刻可见（gauge 一路涨到上限并贴平），而不是悄悄吃掉几千个 fd。
 */
export const DEFAULT_SSE_MAX_STREAMS_TOTAL = 200;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSseMaxStreamsPerUser(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_SSE_MAX_STREAMS_PER_USER);
}

export function resolveSseMaxStreamsTotal(raw: string | undefined): number {
  return resolvePositiveInt(raw, DEFAULT_SSE_MAX_STREAMS_TOTAL);
}

export type SseSlotRejection = "per_user" | "total";

export type SseSlotDecision =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: SseSlotRejection };

interface Limiters {
  /** `namespace:key` → 该主体当前的流数。namespace 让三条路由各用各的桶。 */
  readonly perSubject: Map<string, number>;
  /** namespace → 该命名空间当前占用的流数（gauge 的分维度来源）。 */
  readonly perNamespace: Map<string, number>;
  total: number;
}

/**
 * 每命名空间的限流状态。生产只有 `defaultLimiter` 一个实例；测试用
 * `createSseLimiter()` 拿隔离的一份，避免用例之间互相污染计数。
 */
function newLimiterState(): Limiters {
  return { perSubject: new Map(), perNamespace: new Map(), total: 0 };
}

const defaultLimiter = newLimiterState();

/** 供测试注入隔离实例。 */
export function createSseLimiter(): Limiters {
  return newLimiterState();
}

function resolveLimits(overrides?: {
  maxPerUser?: number;
  maxTotal?: number;
}): { maxPerUser: number; maxTotal: number } {
  return {
    maxPerUser: overrides?.maxPerUser ?? resolveSseMaxStreamsPerUser(process.env.SSE_MAX_STREAMS_PER_USER),
    maxTotal: overrides?.maxTotal ?? resolveSseMaxStreamsTotal(process.env.SSE_MAX_STREAMS_TOTAL),
  };
}

/**
 * 取一条流槽位。成功时必须调用返回的 `release()`；它是幂等的，
 * 所以在 `close`/`error`/`hijack 失败`等多条路径上重复调用是安全的。
 *
 * @param namespace 路由命名空间（如 `"inbox"` / `"run"` / `"card-v2"`），
 *                  让每用户桶在不同流类型之间彼此独立。
 * @param key 主体标识，通常是 `userId` 或 `userId:workspaceId`。
 */
export function acquireSseSlot(
  namespace: string,
  key: string,
  overrides?: { maxPerUser?: number; maxTotal?: number },
): SseSlotDecision {
  return acquireSseSlotIn(defaultLimiter, namespace, key, overrides);
}

/** 与 `acquireSseSlot` 相同，但作用在指定的限流实例上（测试用）。 */
export function acquireSseSlotIn(
  limiter: Limiters,
  namespace: string,
  key: string,
  overrides?: { maxPerUser?: number; maxTotal?: number },
): SseSlotDecision {
  const { maxPerUser, maxTotal } = resolveLimits(overrides);
  const subjectKey = `${namespace}:${key}`;

  if (limiter.total >= maxTotal) {
    sseRejectedTotal.inc({ namespace, reason: "total" });
    return { ok: false, reason: "total" };
  }
  const current = limiter.perSubject.get(subjectKey) ?? 0;
  if (current >= maxPerUser) {
    sseRejectedTotal.inc({ namespace, reason: "per_user" });
    return { ok: false, reason: "per_user" };
  }

  limiter.perSubject.set(subjectKey, current + 1);
  limiter.total += 1;
  const namespaceCount = (limiter.perNamespace.get(namespace) ?? 0) + 1;
  limiter.perNamespace.set(namespace, namespaceCount);
  sseActiveStreams.set({ namespace }, namespaceCount);

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const count = limiter.perSubject.get(subjectKey) ?? 0;
      if (count <= 1) limiter.perSubject.delete(subjectKey);
      else limiter.perSubject.set(subjectKey, count - 1);
      limiter.total -= 1;
      const namespaceRemaining = (limiter.perNamespace.get(namespace) ?? 1) - 1;
      if (namespaceRemaining <= 0) {
        limiter.perNamespace.delete(namespace);
        // 归零时把该 label 从 /metrics 上摘掉，否则会留下一串常驻的 0。
        sseActiveStreams.remove({ namespace });
      } else {
        limiter.perNamespace.set(namespace, namespaceRemaining);
        sseActiveStreams.set({ namespace }, namespaceRemaining);
      }
    },
  };
}

/** 当前进程占用的流总数（gauge 与测试共用）。 */
export function sseActiveStreamCount(): number {
  return defaultLimiter.total;
}

/** 测试用：把默认限流器清零。生产代码不应调用。 */
export function resetSseSlotsForTest(): void {
  defaultLimiter.perSubject.clear();
  defaultLimiter.perNamespace.clear();
  defaultLimiter.total = 0;
  sseActiveStreams.reset();
}
