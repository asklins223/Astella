/* ============================================================
   视图 · 指标（左读数常驻 + 右图墙）
   ------------------------------------------------------------
   布局：左边一列**一眼读数**（sticky，滚动曲线时数字不离开视线），
   右边是图墙——任一图上悬停，所有图同步同一点的时间竖线：
   「同一时刻各处发生了什么」是这个页面唯一要回答的问题。

   最慢路由与原始指标在页面底部通栏：前者是离散事实（表格），后者是深挖入口
   （折叠）。分位数是估算（直方图插值），只用于看趋势；告警仍以 /metrics
   原始序列为准。
   ============================================================ */

import { api } from "../api-client.js";
import {
  formatBytes, formatCount, formatLatency, formatMs,
  formatNumber, formatPercent, formatRateValue,
} from "../format.js";
import { el, section, table, emptyState } from "../ui.js";
import { SERIES_COLORS, seriesChart } from "./shared.js";
import { summarize } from "../charts.js";

export const view = {
  title: "指标",
  lede: "左边是此刻的读数（滚动时保持可见），右边是曲线。耗时按直方图插值估算，看趋势足够，精确告警仍以原始指标为准。",
  load: loadMetrics,
};

const state = { rangeMs: 30 * 60 * 1000 };

const RANGES = [
  { label: "10 分钟", value: 10 * 60 * 1000 },
  { label: "30 分钟", value: 30 * 60 * 1000 },
];

function readoutRow(key, value, { tone = "", empty = false, id, sub = null } = {}) {
  return el("div", { class: "readout-row" },
    el("span", { class: "readout-row__k" }, key, sub ? el("span", { class: "dim", text: ` · ${sub}` }) : null),
    el("span", {
      class: `readout-row__v${tone ? ` readout-row__v--${tone}` : ""}${empty ? " readout-row__v--empty" : ""}`,
      dataset: id ? { statId: id } : {},
      text: value,
    }),
  );
}

function byUnit(unit, value) {
  switch (unit) {
    case "rate": return `${formatRateValue(value)} 次/分`;
    case "duration": return formatLatency(value);
    case "bytes": return formatBytes(value);
    default: return formatCount(value);
  }
}

async function loadMetrics(ctx) {
  const [data, series] = await Promise.all([
    api("/metrics"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
  ]);
  const wrap = el("div", {});
  const allPoints = series.points ?? [];
  const last = allPoints.length ? allPoints[allPoints.length - 1] : null;
  const h = data.headline;

  /* ── 布局：左读数（sticky）+ 右图墙 ── */
  const layout = el("div", { class: "metric-layout" });

  const successRate = h.httpSuccessRate;
  layout.append(
    el("div", { class: "metric-readout" },
      el("div", { class: "section__head", style: "border-bottom:0;padding-bottom:6px" },
        el("span", { class: "section__label", text: "一眼读数" }),
        el("span", { class: "section__note", text: "实时" }),
      ),
      el("div", { class: "readout" },
        readoutRow("成功率", successRate === null ? "—" : formatPercent(successRate), {
          tone: successRate === null ? "" : successRate < 0.99 ? "bad" : "ok",
          empty: successRate === null, id: "m-success",
          sub: h.httpErrors5xxTotal > 0 ? `5xx ${formatCount(h.httpErrors5xxTotal)}` : null,
        }),
        readoutRow("请求速率", formatRateValue(last?.requestsPerMinute ?? null), {
          sub: "次/分", empty: last?.requestsPerMinute == null, id: "m-rate",
        }),
        readoutRow("响应耗时 p95", formatLatency(last?.p95Seconds ?? null), {
          tone: (last?.p95Seconds ?? 0) > 1 ? "warn" : "",
          empty: last?.p95Seconds == null, id: "m-lat",
        }),
        readoutRow("失败速率", formatRateValue(last?.errorsPerMinute ?? null), {
          sub: "次/分", tone: (last?.errorsPerMinute ?? 0) > 0 ? "bad" : "ok",
          empty: last?.errorsPerMinute == null, id: "m-err",
        }),
        readoutRow("排队任务", formatCount(last?.queuePending ?? null), {
          empty: last?.queuePending == null, id: "m-queue",
        }),
        readoutRow("结算积压", formatCount(h.outboxPendingTotal), {
          tone: (h.outboxOldestPendingSeconds ?? 0) > 120 ? "warn" : "", id: "m-outbox",
          sub: h.outboxOldestPendingSeconds === null ? null : `最老 ${formatCount(Math.round(h.outboxOldestPendingSeconds))}s`,
        }),
        readoutRow("数据库连接", h.dbPoolActive === null ? "—" : formatCount(h.dbPoolActive), {
          empty: h.dbPoolActive === null, id: "m-pool",
        }),
        readoutRow("事务失败", formatCount(h.dbTransactionFailures), {
          tone: h.dbTransactionFailures > 0 ? "warn" : "ok", id: "m-txfail",
        }),
        readoutRow("RLS 拒绝", formatCount(h.dbRlsDenied), {
          tone: h.dbRlsDenied > 0 ? "warn" : "ok", id: "m-rls",
        }),
        readoutRow("事件循环", h.eventLoopLagSeconds === null ? "—" : `${Math.round(h.eventLoopLagSeconds * 1000)} ms`, {
          tone: (h.eventLoopLagSeconds ?? 0) > 0.5 ? "warn" : "",
          empty: h.eventLoopLagSeconds === null, id: "m-lag",
        }),
        readoutRow("堆内存", formatBytes(h.heapUsedBytes), {
          empty: h.heapUsedBytes === null, id: "m-heap",
          sub: h.rssBytes === null ? null : `常驻 ${formatBytes(h.rssBytes)}`,
        }),
        readoutRow("请求累计", formatNumber(h.httpRequestsTotal), { id: "m-total" }),
      ),
    ),
  );

  /* ── 右：图墙（共享时间光标）── */
  const right = el("div", {});
  const chartsArea = el("div", {});
  const chips = el("div", { class: "chips" });
  function renderRangeChips() {
    chips.replaceChildren(...RANGES.map((range) =>
      el("button", {
        class: "chip", type: "button",
        "aria-pressed": range.value === state.rangeMs ? "true" : "false",
        text: range.label,
        onclick: () => { state.rangeMs = range.value; renderRangeChips(); renderCharts(); },
      })));
  }

  function renderCharts() {
    const cutoff = Date.now() - state.rangeMs;
    const points = allPoints.filter((point) => point.t >= cutoff);
    if (points.length < 2) {
      chartsArea.replaceChildren(el("div", { class: "chart__empty", text: "这个窗口里点还不够——把窗口放宽到 30 分钟，或等几分钟再看。" }));
      return;
    }
    const figureEls = [];
    const cells = (series.series ?? []).map((meta) => {
      const stats = summarize(points.map((point) => (typeof point[meta.key] === "number" ? point[meta.key] : null)));
      const cell = el("div", { class: "chart-cell" },
        el("div", { class: "chart-cell__head" },
          el("span", { class: "chart-cell__title", title: meta.hint, text: meta.label }),
          el("span", {
            class: "chart-cell__now",
            text: stats.last === null
              ? "暂无读数"
              : `当前 ${byUnit(meta.unit, stats.last)}${stats.peak > Math.max(stats.last, 0.0001) ? ` · 峰值 ${byUnit(meta.unit, stats.peak)}` : ""}`,
          }),
        ),
      );
      const figureEl = seriesChart({
        points,
        key: meta.key,
        color: SERIES_COLORS[meta.key],
        unit: meta.unit,
        tall: true,
        onHover: (index) => {
          // 跨图共享：这个点在哪，所有图的竖线就都画在哪。
          for (const other of figureEls) {
            if (other !== figureEl) other.applyCursor?.(index);
          }
        },
      });
      cell.append(figureEl);
      figureEls.push(figureEl);
      return cell;
    });
    chartsArea.replaceChildren(el("div", { class: "chart-wall" }, ...cells));
  }

  renderRangeChips();
  renderCharts();
  right.append(section("走势", "缺口 = 那段没有采样，不是 0", el("div", { class: "row row--between" },
    chips,
    el("span", { class: "section__note", text: "悬停任一图，所有图同步同一点" }),
  ), el("div", { class: "u-mt-10" }, chartsArea)));
  layout.append(right);
  wrap.append(layout);

  /* ── 最慢路由（通栏）── */
  const routes = data.slowestRoutes ?? [];
  wrap.append(section("最慢的路由", "按 p95 排序 · 样本数为 0 的路由不参与",
    routes.length === 0
      ? emptyState("还没有带流量的路由", "有请求打到服务之后，这里会按 p95 从慢到快列出前 8 条。")
      : el("div", { class: "table" },
          table(
            ["方法", "路由", "p95", "样本数"],
            routes.map((row) => [
              el("span", { class: "badge badge--neutral badge--mono", text: row.method }),
              el("span", { class: "mono", text: row.route }),
              row.p95 === null ? "—" : formatMs(row.p95 * 1000),
              formatCount(row.count),
            ]),
            { numericColumns: [2, 3] },
          ),
        )));

  /* ── 原始指标（通栏，折叠）── */
  const families = [...data.business, ...data.process];
  const rawBody = el("div", {});
  const rawSearch = el("input", {
    class: "field__input", type: "search",
    placeholder: "按指标名过滤，比如 ailearn_http 或 nodejs_heap",
    "aria-label": "过滤原始指标",
  });
  function renderRaw() {
    const needle = rawSearch.value.trim().toLowerCase();
    const visible = families.filter((family) =>
      !needle
      || family.name.toLowerCase().includes(needle)
      || (family.label ?? "").toLowerCase().includes(needle));
    if (visible.length === 0) {
      rawBody.replaceChildren(emptyState("没有匹配的指标", "换个关键词，或清空过滤框。"));
      return;
    }
    rawBody.replaceChildren(...visible.map((family) => {
      const item = el("details", { class: "disclosure" });
      const summary = el("summary", {},
        el("span", { text: family.label ?? family.name }),
        el("span", { class: "badge badge--neutral badge--mono", title: family.name, text: `${family.type} · ${family.samples.length}` }),
      );
      const body = el("div", { class: "disclosure__body" });
      body.append(el("p", { class: "disclosure__help", text: family.help }));

      if (family.histograms?.length) {
        body.append(table(
          ["标签", "条数", "p50", "p95", "溢出"],
          family.histograms.map((histogram) => [
            el("span", { class: "mono", text: Object.entries(histogram.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—" }),
            formatCount(histogram.count),
            histogram.p50 === null ? "—" : formatMs(histogram.p50 * 1000),
            histogram.p95 === null ? "—" : formatMs(histogram.p95 * 1000),
            (histogram.overflowRatio ?? 0) > 0.001 ? formatPercent(histogram.overflowRatio) : "0%",
          ]),
          { numericColumns: [1, 2, 3, 4] },
        ));
      } else {
        const samples = family.samples.slice(0, 30);
        body.append(table(
          ["标签", "值"],
          samples.map((sample) => [
            el("span", { class: "mono", text: Object.entries(sample.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—" }),
            formatNumber(sample.value),
          ]),
          { numericColumns: [1] },
        ));
        if (family.samples.length > samples.length) {
          body.append(el("p", { class: "figure__hint", text: `只显示前 ${samples.length} 条，共 ${family.samples.length} 条。` }));
        }
      }
      item.append(summary, body);
      return item;
    }));
  }
  rawSearch.addEventListener("input", renderRaw);
  renderRaw();
  wrap.append(section("原始指标", `${families.length} 个家族 · 给告警集成与深挖用`,
    el("div", { class: "u-mt-10" }, rawSearch),
    el("div", { class: "u-mt-10" }, rawBody),
  ));

  return wrap;
}
