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

/* ═══════════════════════════════════════════════════════════════
   可视化基元（v6，各页共用）
   ---------------------------------------------------------------
   这些是**数据形状**的画法，不是装饰：每一种都必须让读者在两秒内
   回答一个具体问题（"总量压在谁身上"、"这个容器有多满"、"哪段时间
   在变差"）。所以：
     · 颜色带含义——同一族事物用同一色相的深浅，不撒彩虹；
       只有"性质不同"的序列才用 --series-* 的异色。
     · 细条不是信息——占比过小的项合并成"其余 N"，别糊一墙碎块。
     · 没有数据不画线（`null` 是断点，不是 0）。
   ═══════════════════════════════════════════════════════════════ */

/** 同族色阶：用于"同一类事物的严重程度"，由深到浅。 */
export const ESCALATION_SHADES = ["#9e2b38", "#b73543", "#c8505c", "#d76a74", "#e2858d", "#eba3a9"];

/**
 * 构成条：把总量按占比切成一条横带。
 *
 * @param {object} options
 * @param {Array<{key:string,label:string,value:number,color?:string,hint?:string}>} options.items
 * @param {number} [options.limit] 最多画几段，其余并成"其余 N 项"（默认 6）
 * @param {string} [options.ariaLabel]
 * @param {(key:string|null)=>void} [options.onLocate] 点某段/图例时回调（null = 取消选中）
 * @param {boolean} [options.locatable] 是否允许点选定位
 * @param {string} [options.restLabel] "其余"那段的文案前缀
 * @returns {{node:Node, clear:()=>void}}
 */
export function compositionBar({ items, limit = 6, ariaLabel = "构成", onLocate = null, locatable = true, restLabel = "其余" }) {
  const positive = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  const head = positive.slice(0, limit);
  const tail = positive.slice(limit);
  const tailTotal = tail.reduce((sum, item) => sum + item.value, 0);

  const bar = el("div", { class: "dist", "aria-label": ariaLabel });
  const legend = el("div", { class: "dist__legend" });
  const segments = [];
  const keys = [];
  let selected = null;

  const colorOf = (item, index) => item.color ?? ESCALATION_SHADES[Math.min(index, ESCALATION_SHADES.length - 1)];

  function clear() {
    selected = null;
    bar.dataset.dim = "false";
    segments.forEach((node) => node.setAttribute("aria-pressed", "false"));
    keys.forEach((node) => { node.style.color = ""; });
    onLocate?.(null);
  }

  function locate(key) {
    if (!locatable) return;
    if (selected === key) { clear(); return; }
    selected = key;
    bar.dataset.dim = "true";
    segments.forEach((node, index) => node.setAttribute("aria-pressed", String(head[index]?.key === key)));
    keys.forEach((node, index) => { node.style.color = head[index]?.key === key ? "var(--accent)" : ""; });
    onLocate?.(key);
  }

  head.forEach((item, index) => {
    const share = total === 0 ? 0 : item.value / total;
    const color = colorOf(item, index);
    const percent = Math.round(share * 100);
    const segment = el("button", {
      class: "dist__seg", type: "button",
      style: `width:${(share * 100).toFixed(2)}%;background:${color}`,
      title: `${item.label} · ${formatCount(item.value)}（${percent}%）`,
      "aria-label": `${item.label}，${percent}%`,
      "aria-pressed": "false",
      onclick: () => locate(item.key),
    });
    const key = el("button", {
      class: "dist__key", type: "button",
      title: item.hint ?? `定位「${item.label}」`,
      onclick: () => locate(item.key),
    },
      el("span", { class: "dist__dot", style: `background:${color}` }),
      el("span", { text: item.label }),
      el("b", { text: formatCount(item.value) }),
      el("span", { text: `${percent}%` }),
    );
    segments.push(segment); keys.push(key);
    bar.append(segment); legend.append(key);
  });

  if (tail.length > 0) {
    const share = total === 0 ? 0 : tailTotal / total;
    const percent = Math.round(share * 100);
    const segment = el("button", {
      class: "dist__seg", type: "button",
      style: `width:${(share * 100).toFixed(2)}%;background:var(--line-strong)`,
      title: `${restLabel} ${tail.length} 项合计 ${formatCount(tailTotal)}（${percent}%）`,
      "aria-label": `${restLabel} ${tail.length} 项，${percent}%`,
      onclick: () => {
        if (!locatable) return;
        if (selected === "__rest__") { clear(); return; }
        selected = "__rest__";
        bar.dataset.dim = "true";
        segments.forEach((node) => node.setAttribute("aria-pressed", "false"));
        segment.setAttribute("aria-pressed", "true");
        onLocate?.("__rest__", tail.map((item) => item.key));
      },
    });
    bar.append(segment);
    legend.append(el("button", {
      class: "dist__key", type: "button",
      title: `${restLabel} ${tail.length} 项：${tail.map((item) => item.label).join("、")}`,
      onclick: () => segment.click(),
    },
      el("span", { class: "dist__dot", style: "background:var(--line-strong)" }),
      el("span", { text: `${restLabel} ${tail.length} 项` }),
      el("b", { text: formatCount(tailTotal) }),
      el("span", { text: `${percent}%` }),
    ));
  }

  return { node: el("div", {}, bar, legend), clear, head, tail };
}

/**
 * 仪表条：一个 0–1 的比例（CPU、内存、连接池占用）。
 * 只用于"有上限、且贴上限会出问题"的量。
 *
 * @param {{value:number|null, label:string, detail?:string, tone?:string, warnAt?:number, badAt?:number}} options
 */
export function meterRow({ value, label, detail = "", warnAt = 0.75, badAt = 0.9 }) {
  const ratio = value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
  const tone = ratio === null ? "" : ratio >= badAt ? "bad" : ratio >= warnAt ? "warn" : "";
  return el("div", { class: "meter-row", dataset: { tone } },
    el("div", { class: "meter-row__head" },
      el("span", { class: "meter-row__label", text: label }),
      el("span", { class: "meter-row__value" }, ratio === null ? "—" : `${Math.round(ratio * 100)}%`,
        detail ? el("span", { class: "meter-row__detail", text: detail }) : null),
    ),
    el("div", { class: "meter-row__track" },
      el("i", { style: `width:${ratio === null ? 0 : Math.max(1, ratio * 100).toFixed(1)}%` })),
  );
}

/**
 * 横向条形列表（代替"数字列"）：条长 = 相对量级，右侧给读数。
 * 用于"哪几项最重"这种排序问题。
 *
 * @param {Array<{key:string,label:string,value:number,color?:string,note?:string}>} items
 */
export function barList(items, { max = null, onSelect = null } = {}) {
  const peak = max ?? Math.max(1, ...items.map((item) => item.value));
  return el("div", { class: "barlist" }, ...items.map((item) => el("button", {
    class: "barlist__row", type: "button",
    disabled: onSelect === null,
    onclick: () => onSelect?.(item.key),
  },
    el("span", { class: "barlist__label", text: item.label }),
    el("span", { class: "barlist__track" },
      el("i", { style: `width:${Math.max(1.5, (item.value / peak) * 100).toFixed(1)}%;background:${item.color ?? "var(--accent)"}` })),
    el("span", { class: "barlist__value", text: item.note ?? formatCount(item.value) }),
  )));
}

