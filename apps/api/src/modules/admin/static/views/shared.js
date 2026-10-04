/* ============================================================
   运维控制台 · 视图共享片段
   ------------------------------------------------------------
   待办卡片与队列动作同时出现在「总览」和「任务与队列」两页，
   动作语义（确认 → POST → 局部刷新）必须只有一份实现：两处各写一遍时，
   最容易漂的恰恰是确认文案里的数量与后果——那是不可逆操作的护栏。
   ============================================================ */

import { api } from "../api-client.js";
import { formatCount } from "../format.js";
import { el, confirmDialog, toast } from "../ui.js";

export const SEVERITY_META = {
  block: { tone: "bad", dot: "var(--red)" },
  warn: { tone: "warn", dot: "var(--amber)" },
  info: { tone: "info", dot: "var(--blue)" },
};

/**
 * 序列配色。判据是**深色仪表上的可区分度**，不是配色好看：
 *  - 请求/错误是并排的两张主图，必须一眼分得开 → 青 vs 红。
 *  - 延迟用紫、积压用琥珀、内存用薄荷：同屏最多同时出现三张图，
 *    彼此在深底上都拉得开。
 */
export const SERIES_COLORS = {
  requestsPerMinute: "var(--cyan)",
  errorsPerMinute: "var(--red)",
  p95Seconds: "var(--violet)",
  eventLoopLagSeconds: "var(--gold)",
  heapUsedBytes: "var(--mint)",
  poolActive: "var(--blue)",
  queuePending: "var(--amber)",
  outboxPending: "var(--mint)",
};

/** 取一条曲线的原始值序列（缺失点保留 null，图表据此断开）。 */
export function seriesValues(points, key) {
  return points.map((point) => (typeof point[key] === "number" ? point[key] : null));
}

/**
 * 执行一个队列动作（retry / purge）并给出确认。
 *
 * 两种都要求确认，理由不同：
 *  - `purge` 是**不可逆**的删除；
 *  - `retry` 不可逆，且会重新触发一批模型调用——400 条重试就是 400 次
 *    对外部模型服务的调用，那是实打实的费用。
 * 确认文案里都带上**具体数量**，不含糊。
 *
 * @returns 是否真的执行了（用于调用方决定要不要刷新）
 */
export async function performJobAction({ jobType, label, action, count }) {
  const isPurge = action === "purge";
  const ok = await confirmDialog({
    title: isPurge ? "清理这些任务？" : "重试这些任务？",
    body: isPurge
      ? `「${label}」中的 ${formatCount(count)} 条将被永久删除，不可恢复。它们的失败原因也会一并消失。`
      : `「${label}」中的 ${formatCount(count)} 条会被重新排队，每个都会再次调用模型服务（产生新的调用费用）。`,
    confirmLabel: isPurge ? "永久删除" : "重新排队",
    tone: isPurge ? "danger" : "primary",
  });
  if (!ok) return false;

  try {
    const result = await api("/jobs/actions", {
      method: "POST",
      body: JSON.stringify({ jobType, action }),
    });
    toast(`${isPurge ? "已清理" : "已重新排队"} ${formatCount(result.affected)} 条`);
    return true;
  } catch (error) {
    toast(error.message, "bad");
    return false;
  }
}

/** 待办卡片：色点 → 文字 → 动作。id 供差异对比与测试锚点。 */
export function todoItemCard(item, { onAction }) {
  const meta = SEVERITY_META[item.severity] ?? SEVERITY_META.info;
  return el("div", { class: `todo todo--${meta.tone}`, dataset: { todoId: item.id } },
    el("span", { class: "todo__dot", style: `--c:${meta.dot}` }),
    el("div", { class: "todo__text" },
      el("div", { class: "todo__title", text: item.title }),
      el("div", { class: "todo__detail", text: item.detail }),
    ),
    el("button", {
      class: "btn btn--row",
      type: "button",
      text: item.actionLabel,
      onclick: () => onAction(item),
    }),
  );
}

