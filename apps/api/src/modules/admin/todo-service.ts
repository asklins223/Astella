/**
 * 首屏待办 —— 面板里唯一回答「我现在该做什么」的地方。
 *
 * ## 为什么不是再来一组数字
 *
 * 面板第一版的概览是 6 个数字 + 3 张图。它告诉你「死信 46」「失败 7」，
 * 但**没有给出下一步**——看完数字的人仍然得自己判断要不要开 psql、
 * 以及开进去敲什么。
 *
 * 待办清单把这件事反过来做：每个条目都必须**带一个能点的动作**。
 * 点不动的东西（比如一个纯展示的统计）不进这个列表，它属于下面的图表区。
 *
 * ## 严重度的判据（不是拍脑袋排序）
 *
 *   block —— 功能**已经不可用**：模型密钥没配、配置校验没过。
 *            用户会撞上明确的失败，所以排第一。
 *   warn  —— 有东西**没按预期完成**：失败任务、队列堵久了。
 *            用户可能已经感觉到异常，但还能工作。
 *   info  —— 需要**人工决定**的残留：死信清理。
 *            系统不会自己动它（删数据是运维的决定，不是队列消费者的事）。
 *
 * 同一级内按数量降序：积压 400 条比积压 2 条更该先看。
 */

import { readConfigSnapshot, type ConfigSnapshot } from "./config-service.ts";
import { readQueueBacklog, type QueueBacklogRow, type QueueSummary } from "./ops-service.ts";

export type TodoSeverity = "block" | "warn" | "info";

/** 待办能给出的动作。只有这四种——每一种都对应一个真实可执行的行为。 */
export type TodoAction =
  | { kind: "retry_failed"; jobType: string }
  | { kind: "purge_dead"; jobType: string }
  | { kind: "goto_config" }
  | { kind: "goto_queues" };

export interface TodoItem {
  /** 稳定 id，供前端做差异对比与动画。 */
  id: string;
  severity: TodoSeverity;
  title: string;
  detail: string;
  action: TodoAction;
  actionLabel: string;
  /** 涉及数量（0 时不显示）。 */
  count?: number;
}

export interface TodoSnapshot {
  items: TodoItem[];
  counts: { total: number; block: number; warn: number; info: number };
}

/** 队列等待超过多久开始算「堵住了」。5 分钟是拍的，但**写在这里可调**，不是散在判断里。 */
const QUEUE_STALL_SECONDS = 300;

const SEVERITY_ORDER: Record<TodoSeverity, number> = { block: 0, warn: 1, info: 2 };

/**
 * 把「队列/配置的当前状态」折成待办清单。
 *
 * 纯函数（收数据、返回清单、不碰 IO）——真正的数据读取在 {@link readTodo} 里，
 * 这样每条判据都能被单测直接喂数据验证，不用起数据库。
 */
export function buildTodo(input: {
  backlog: QueueSummary;
  config: ConfigSnapshot;
}): TodoSnapshot {
  const items: TodoItem[] = [];

  // ── block：功能已经不可用 ──
  if (input.config.unresolvedEnvRefs.length > 0) {
    items.push({
      id: "config.unresolved_env",
      severity: "block",
      title: `${input.config.unresolvedEnvRefs.length} 个模型密钥没配置`,
      detail: `${input.config.unresolvedEnvRefs.slice(0, 3).join("、")}${input.config.unresolvedEnvRefs.length > 3 ? " 等" : ""} 未设置，对应功能会直接调用失败。`,
      action: { kind: "goto_config" },
      actionLabel: "去配置",
      count: input.config.unresolvedEnvRefs.length,
    });
  }

  const blockingIssues = input.config.issues.filter((issue) => issue.blocking);
  if (blockingIssues.length > 0) {
    items.push({
      id: "config.blocking_issues",
      severity: "block",
      title: `配置有 ${blockingIssues.length} 处错误`,
      detail: blockingIssues[0].message,
      action: { kind: "goto_config" },
      actionLabel: "去看",
      count: blockingIssues.length,
    });
  }

  // ── warn：有东西没按预期完成 ──
  const failedTypes = input.backlog.byType.filter((row) => row.failedRecent > 0);
  for (const row of failedTypes) {
    items.push({
      id: `queue.failed.${row.jobType}`,
      severity: "warn",
      title: `${row.label} 失败 ${row.failedRecent} 次`,
      detail: "这些任务 24 小时内失败了。重试会给它们一轮全新的尝试次数。",
      action: { kind: "retry_failed", jobType: row.jobType },
      actionLabel: "重试",
      count: row.failedRecent,
    });
  }

  if (input.backlog.totals.oldestPendingSeconds > QUEUE_STALL_SECONDS) {
    items.push({
      id: "queue.stalled",
      severity: "warn",
      title: "后台任务排了太久",
      detail: `排最久的那条已经等了 ${Math.round(input.backlog.totals.oldestPendingSeconds / 60)} 分钟。队列里当前有 ${input.backlog.totals.pending} 条在排队。`,
      action: { kind: "goto_queues" },
      actionLabel: "查看队列",
      count: input.backlog.totals.pending,
    });
  }

  // ── info：需要人工决定的残留 ──
  const deadTypes = input.backlog.byType.filter((row) => row.deadTotal > 0);
  for (const row of deadTypes) {
    items.push({
      id: `queue.dead.${row.jobType}`,
      severity: "info",
      title: `${row.label} 有 ${row.deadTotal} 条重试用尽`,
      detail: "重试次数已用完，系统不会再碰它们。确认没有价值后可以清理掉。",
      action: { kind: "purge_dead", jobType: row.jobType },
      actionLabel: "清理",
      count: row.deadTotal,
    });
  }

  // 同级内按数量降序；没有 count 的排在有 count 的后面。
  items.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.count ?? 0) - (a.count ?? 0);
  });

  return {
    items,
    counts: {
      total: items.length,
      block: items.filter((item) => item.severity === "block").length,
      warn: items.filter((item) => item.severity === "warn").length,
      info: items.filter((item) => item.severity === "info").length,
    },
  };
}

/** 读数据 + 折清单。两个来源都失败时降级为"读不到"，而不是抛出整页错误。 */
export async function readTodo(): Promise<TodoSnapshot> {
  const [backlog, config] = await Promise.all([
    readQueueBacklog().catch(() => null),
    readConfigSnapshot().catch(() => null),
  ]);

  if (!backlog || !config) {
    return {
      items: [{
        id: "todo.unavailable",
        severity: "block",
        title: "读取状态失败",
        detail: "队列或配置状态读不出来，这本身就是需要处理的事。看日志页确认服务是否正常。",
        action: { kind: "goto_queues" },
        actionLabel: "看日志",
      }],
      counts: { total: 1, block: 1, warn: 0, info: 0 },
    };
  }

  return buildTodo({ backlog, config });
}

export type { QueueBacklogRow };