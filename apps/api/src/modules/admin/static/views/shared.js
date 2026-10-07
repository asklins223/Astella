/* ============================================================
   运维控制台 · 视图共享片段
   ------------------------------------------------------------
   待办卡片与队列动作同时出现在「总览」和「任务与队列」两页，
   动作语义（确认 → POST → 局部刷新）必须只有一份实现：两处各写一遍时，
   最容易漂的恰恰是确认文案里的数量与后果——那是不可逆操作的护栏。
   ============================================================ */

import { api } from "../api-client.js";
import { formatCount, formatBytes, formatLatency, formatRateValue } from "../format.js";
import { el, confirmDialog, toast } from "../ui.js";
import { areaChart } from "../charts.js";

export const SEVERITY_META = {
  block: { tone: "bad", dot: "var(--bad)" },
  warn: { tone: "warn", dot: "var(--warn)" },
  info: { tone: "info", dot: "var(--ink-4)" },
};

/**
 * 图表序列配色（浅色纸面）。
 *
 * 判据是**同一张纸上彼此可辨、且不抢读数**：请求用墨蓝（与强调色同族），
 * 失败用红，其余取低饱和度的紫/琥珀/绿/青/棕/灰——它们在 --series-* 里
 * 统一登记，图表、图例与徽标引用同一处，不各写一份色值。
 */
export const SERIES_COLORS = {
  requestsPerMinute: "var(--series-1)",
  errorsPerMinute: "var(--series-2)",
  p95Seconds: "var(--series-3)",
  eventLoopLagSeconds: "var(--series-4)",
  heapUsedBytes: "var(--series-5)",
  poolActive: "var(--series-6)",
  queuePending: "var(--series-7)",
  outboxPending: "var(--series-8)",
};

/** 取一条曲线的原始值序列（缺失点保留 null，图表据此断开）。 */
export function seriesValues(points, key) {
  return points.map((point) => (typeof point[key] === "number" ? point[key] : null));
}

/**
 * 一条时序曲线（供总览/指标共用）。
 * 标题与"当前值"由调用方排版——这里只负责图和悬停读数。
 */
export function seriesChart({ points, key, label = key, color, unit, tall = false, onHover = null }) {
  const values = seriesValues(points, key);
  const last = values.filter((value) => value !== null).at(-1) ?? null;
  const valueText = unit === "duration" ? formatLatency(last) : unit === "bytes" ? formatBytes(last)
    : unit === "rate" ? `${formatRateValue(last)} 次/分` : formatCount(last);
  return areaChart({
    values,
    label,
    valueText,
    times: points.map((point) => point.t ?? null),
    color,
    unit,
    tall,
    onHover,
    emptyHint: "这段时间没有采样",
  });
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
export async function performJobAction({ jobType, label, action, count, onPending }) {
  const isPurge = action === "purge";
  const limit = Math.max(1, Math.min(500, Math.floor(count)));
  const ok = await confirmDialog({
    title: isPurge ? "清理这些任务？" : "重试这些任务？",
    body: isPurge
      ? `按任务类型处理「${label}」中最多 ${formatCount(limit)} 条死信，将永久删除且不可恢复，失败原因也会消失。这个操作覆盖该类型的所有失败原因。`
      : `按任务类型处理「${label}」中最多 ${formatCount(limit)} 条失败任务，重新排队后会再次调用模型服务，产生新的费用。这个操作覆盖该类型的所有失败原因。`,
    confirmLabel: isPurge ? "永久删除" : "重新排队",
    tone: isPurge ? "danger" : "primary",
  });
  if (!ok) return false;
  onPending?.();

  try {
    const result = await api("/jobs/actions", {
      method: "POST",
      body: JSON.stringify({ jobType, action, limit }),
    });
    toast(`${isPurge ? "已清理" : "已重新排队"} ${formatCount(result.affected)} 条`);
    return true;
  } catch (error) {
    toast(error.message, "bad");
    return false;
  }
}

/** 待办行：色点 → 文字 → 动作（细线行，不是卡片）。 */
export function todoItemCard(item, { onAction }) {
  const meta = SEVERITY_META[item.severity] ?? SEVERITY_META.info;
  return el("div", { class: "task", dataset: { todoId: item.id } },
    el("span", { class: "task__dot", style: `--c:${meta.dot}` }),
    el("div", {},
      el("div", { class: "task__title", text: item.title }),
      el("div", { class: "task__detail", text: item.detail }),
    ),
    el("div", { class: "task__actions" },
      el("button", {
        class: "link-btn", type: "button", text: item.actionLabel,
        onclick: () => onAction(item),
      }),
    ),
  );
}
