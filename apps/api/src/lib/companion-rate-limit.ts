/**
 * 伴星侧固定窗口限流（P1-18：改用 identity 侧已抽象好的 `RateLimitStore`）。
 *
 * ## 收口前是什么
 *
 * 本文件此前**自己维护一个进程内 `Map`**（`buckets`），带自己的惰性清理、
 * 阈值整批清理与 50k 内存护栏——和 `identity/rate-limit.ts` 的
 * `MemoryRateLimitStore` 是同一件事的两份实现。
 *
 * 代价不是"重复代码"这么轻：Map 是**进程内**的，所以多副本部署时
 * 同一个用户在不同实例上有各自的桶，**限额被按实例数放大**。
 * 文件头自己写着"当前部署为单 API 实例"——那句话是这条缺陷的
 * 前提条件，一旦扩副本就失效，而失效方式是**静默地放过超额请求**。
 *
 * ## 收口后是什么
 *
 * 计数交给 `RateLimitStore`。identity 侧已经有两个实现：
 *   - `MemoryRateLimitStore`   —— 进程内，默认值，测试与单实例开发用
 *   - `PostgresRateLimitStore` —— 共享桶，**多副本下限额才正确**
 *
 * 所以现在 companion 的限额和 identity 的限额走**同一套抽象**，
 * 换共享存储是换构造参数而不是重写。
 *
 * ## 判据没变
 *
 * `allowed` 的语义、`retryAfterSeconds` 的取整（向上取整、至少 1 秒）、
 * 以及 429 envelope 都与收口前逐字一致——被搬走的是**状态存哪**，
 * 不是**怎么判**。`companion-rate-limit.test.ts` 里的既有用例继续适用。
 */

import { MemoryRateLimitStore, type RateLimitStore } from "./rate-limit-store.ts";

/**
 * 进程内默认 store。**只建一次**——每次调用 new 一个会让计数归零，
 * 那等于没有限流。
 */
const defaultStore: RateLimitStore = new MemoryRateLimitStore();

export type CompanionRateLimitStore = RateLimitStore;

/**
 * 判定一次请求是否超额。
 *
 * **从同步变成 async**：共享 store 的 `increment` 是 IO（Postgres 实现就是一次
 * 往返）。调用方必须 `await`——这也是为什么本函数的返回类型标注成 `Promise`，
 * 让漏 await 变成编译错误而不是"拿到一个 Promise 对象当成真值"。
 */
export async function companionRateLimit(args: {
  /** 稳定 scope 键，通常 `${workspaceId}:${userId}:${bucketName}`。 */
  key: string;
  limit: number;
  windowMs: number;
  /**
   * 计数存哪。默认进程内；**多副本部署必须传 `createRateLimitStoreFromEnv()`
   * 的结果**，否则限额按实例数放大。
   */
  store?: RateLimitStore;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const store = args.store ?? defaultStore;
  const now = Date.now();
  const entry = await store.increment(args.key, args.windowMs, now);

  // 维护钩子交给 store 自己的实现决定（MemoryRateLimitStore 有惰性 sweep，
  // PostgresRateLimitStore 不需要——过期行由 DB 侧或 TTL 处理）。
  await store.sweep?.(now);

  if (entry.count > args.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 429 响应构造（envelope 与 §6.9 一致）。 */
export function companionRateLimitReply(
  reply: { code(statusCode: number): { send(body: unknown): unknown }; send(body: unknown): unknown },
  requestId: string,
  retryAfterSeconds: number,
): unknown {
  reply.code(429);
  return reply.send({
    version: 1,
    error: "RATE_LIMITED",
    message: "操作太频繁，请稍后再试",
    recoverable: true,
    requestId,
    retryAfterSeconds,
  });
}

// §6.10 固定限额（全部按 (workspace,user)）。
export const COMPANION_RATE_LIMITS = Object.freeze({
  createTurnPerMinute: { limit: 12, windowMs: 60_000 },
  createTurnPerHour: { limit: 120, windowMs: 3_600_000 },
  createConversationPerMinute: { limit: 10, windowMs: 60_000 },
  // bootstrap + conversation list/snapshot/messages/proposal snapshot 合并
  readQueriesPerMinute: { limit: 120, windowMs: 60_000 },
  mutateConversationPerMinute: { limit: 20, windowMs: 60_000 }, // PATCH/DELETE
  inboxEnsurePerMinute: { limit: 30, windowMs: 60_000 },
  cancelPerMinute: { limit: 30, windowMs: 60_000 },
  deliveryViewDismissPerMinute: { limit: 60, windowMs: 60_000 },
  proposalDecisionPerMinute: { limit: 20, windowMs: 60_000 },
  learningContextPerMinute: { limit: 30, windowMs: 60_000 },
  // menu-proposal 与 create turn 共用 12/min 写预算（§6.10）
  menuProposalPerMinute: { limit: 12, windowMs: 60_000 },
  asrPerMinute: { limit: 10, windowMs: 60_000 },
  asrPerHour: { limit: 60, windowMs: 3_600_000 },
  ttsPerMinute: { limit: 60, windowMs: 60_000 },
  exportPerHour: { limit: 3, windowMs: 3_600_000 },
  // companion bridge context 发布/续租/撤销（§14.2）：与其余 companion 路由
  // 一致的 per-(workspace,user) 内存固定窗口限流，防认证客户端滥用端点。
  bridgeContextPerMinute: { limit: 60, windowMs: 60_000 },
} as const);
