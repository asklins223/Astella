/* ============================================================
   视图 · 指标（图墙）
   ------------------------------------------------------------
   这一页刻意**不用 3D**：连续时序要的是精确读数，空间化只会伤害它。
   构图是仪表盘的另一面——车站牌式的数字横带 + 大尺度图墙：

     · 横带：headline 里那些"一眼值"（成功率、速率、p95、池、RLS…）
     · 图墙：精选曲线，无卡片壳；任一图上悬停，所有图同步同一点的时间
       竖线——"同一时刻各处发生了什么"是这个页面唯一要回答的问题
     · 最慢路由：p95 排序的前 N 条（服务端算好）
     · 原始指标：折叠在最后，给告警集成与深挖
   ============================================================ */

import { api } from "../api-client.js";
import {
  formatBytes, formatCount, formatLatency, formatMs,
  formatNumber, formatPercent, formatRateValue,
} from "../format.js";
import { el, section, table, emptyState } from "../ui.js";
import { SERIES_COLORS, seriesValues } from "./shared.js";
import { areaChart, summarize } from "../charts.js";

export const view = {
  title: "指标",
  lede: "先给结论，再给曲线，原始转储在最后。耗时是估算值（按直方图分桶插值），看趋势足够，精确告警仍以原始指标为准。",
  load: loadMetrics,
};

const state = { rangeMs: 30 * 60 * 1000 };

const RANGES = [
  { label: "10 分钟", value: 10 * 60 * 1000 },
  { label: "30 分钟", value: 30 * 60 * 1000 },
];

function tickerItem(key, value, { tone = "", unit = "", empty = false } = {}) {
  return el("div", { class: "ticker__item" },
    el("span", { class: "ticker__k", text: key }),
    el("span", {
      class: `ticker__v${tone ? ` ticker__v--${tone}` : ""}${empty ? " ticker__v--empty" : ""}`,
      dataset: { statId: `ticker-${key}` },
      text: value,
    }),
    unit ? el("span", { class: "ticker__unit", text: unit }) : null,
  );
}

async function loadMetrics(ctx) {
  const [data, series] = await Promise.all([
    api("/metrics"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
  ]);
  const wrap = el("div", {});
  const allPoints = series.points ?? [];
  const lastPoint = allPoints.length ? allPoints[allPoints.length - 1] : null;
  const h = data.headline;
  ctx.onMetrics?.(h, lastPoint);

  /* ── 数字横带 ── */
  const successRate = h.httpSuccessRate;
  wrap.append(el("div", { class: "ticker" },
    tickerItem("成功率", successRate === null ? "—" : formatPercent(successRate), {
      tone: successRate === null ? "" : successRate < 0.99 ? "bad" : "ok",
      empty: successRate === null,
    }),
    tickerItem("请求", formatRateValue(lastPoint?.requestsPerMinute ?? null), { unit: "次/分", empty: lastPoint?.requestsPerMinute == null }),
    tickerItem("失败", formatRateValue(lastPoint?.errorsPerMinute ?? null), {
      unit: "次/分",
      tone: (lastPoint?.errorsPerMinute ?? 0) > 0 ? "bad" : "ok",
      empty: lastPoint?.errorsPerMinute == null,
    }),
    tickerItem("p95", formatLatency(lastPoint?.p95Seconds ?? null), { tone: (lastPoint?.p95Seconds ?? 0) > 1 ? "warn" : "", empty: lastPoint?.p95Seconds == null }),
    tickerItem("排队", formatCount(lastPoint?.queuePending ?? null), { empty: lastPoint?.queuePending == null }),
    tickerItem("结算积压", formatCount(h.outboxPendingTotal), { tone: (h.outboxOldestPendingSeconds ?? 0) > 120 ? "warn" : "" }),
    tickerItem("数据库连接", h.dbPoolActive === null ? "—" : formatCount(h.dbPoolActive), { empty: h.dbPoolActive === null }),
    tickerItem("RLS 拒绝", formatCount(h.dbRlsDenied), { tone: h.dbRlsDenied > 0 ? "warn" : "ok" }),
    tickerItem("事务失败", formatCount(h.dbTransactionFailures), { tone: h.dbTransactionFailures > 0 ? "warn" : "" }),
    tickerItem("事件循环", h.eventLoopLagSeconds === null ? "—" : `${Math.round(h.eventLoopLagSeconds * 1000)}`, { unit: "ms", tone: (h.eventLoopLagSeconds ?? 0) > 0.5 ? "warn" : "", empty: h.eventLoopLagSeconds === null }),
    tickerItem("堆内存", formatBytes(h.heapUsedBytes), { empty: h.heapUsedBytes === null }),
    tickerItem("常驻", formatBytes(h.rssBytes), { empty: h.rssBytes === null }),
    tickerItem("请求累计", formatNumber(h.httpRequestsTotal)),
  ));

  /* ── 图墙（共享时间光标）── */
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
    const times = points.map((point) => point.t ?? null);
    const figures = [];

    const cells = (series.series ?? []).map((meta) => {
      const values = seriesValues(points, meta.key);
      const stats = summarize(values);
      const cell = el("div", { class: "chart-cell" },
        el("div", { class: "chart-cell__head" },
          el("span", { class: "chart-cell__title", title: meta.hint, text: meta.label }),
          el("span", {
            class: "chart-cell__now",
            text: stats.last === null ? "暂无读数" : `当前 ${formatByUnitFor(meta.unit, stats.last)}${stats.peak > Math.max(stats.last, 0.0001) ? ` · 峰值 ${formatByUnitFor(meta.unit, stats.peak)}` : ""}`,
          }),
        ),
      );
      const figure = areaChart({
        values,
        times,
        color: SERIES_COLORS[meta.key],
        label: meta.label,
        unit: meta.unit,
        valueText: meta.hint,
        emptyHint: "这段时间没有采样",
        tall: true,
        onHover: (index) => {
          // 跨图共享：这个点在哪，所有图的竖线就都画在哪。
          for (const other of figures) {
            if (other !== figure) other.applyCursor?.(index);
          }
        },
      });
      cell.append(figure);
      figures.push(figure);
      return cell;
    });

    chartsArea.replaceChildren(el("div", { class: "chart-wall" }, ...cells));
  }

  renderRangeChips();
  renderCharts();
  wrap.append(section("走势", "缺口 = 那段没有采样，不是 0", el("div", { class: "row row--between" },
    chips,
    el("span", { class: "section__note", text: "悬停任一图，所有图同步同一点" }),
  ), el("div", { class: "u-mt-10" }, chartsArea)));

  /* ── 最慢路由 ── */
  const routes = data.slowestRoutes ?? [];
  wrap.append(section("最慢的路由", "按 p95 排序 · 样本数为 0 的路由不参与",
    routes.length === 0
      ? el("div", { class: "table" }, emptyState("还没有带流量的路由", "有请求打到服务之后，这里会按 p95 从慢到快列出前 8 条。"))
      : el("div", { class: "table" },
          table(
            ["方法", "路由", "p95", "样本数"],
            routes.map((row) => [
              el("span", { class: "badge badge--info badge--mono", text: row.method }),
              el("span", { class: "mono", text: row.route }),
              row.p95 === null ? "—" : formatMs(row.p95 * 1000),
              formatCount(row.count),
            ]),
            { numericColumns: [2, 3] },
          ),
        )));

  /* ── 原始指标（折叠在最后）── */
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
      const card = el("details", { class: "disclosure" });
      const summary = el("summary", {},
        el("span", { text: family.label ?? family.name }),
        el("span", { class: "badge badge--mono", title: family.name, text: `${family.type} · ${family.samples.length}` }),
      );
      const body = el("div", { class: "disclosure__body" });
      body.append(el("p", { class: "disclosure__help", text: family.help }));

      if (family.histograms?.length) {
        body.append(table(
          ["标签", "条数", "p50", "p95", "溢出"],
          family.histograms.map((item) => [
            el("span", { class: "mono", text: Object.entries(item.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—" }),
            formatCount(item.count),
            item.p50 === null ? "—" : formatMs(item.p50 * 1000),
            item.p95 === null ? "—" : formatMs(item.p95 * 1000),
            (item.overflowRatio ?? 0) > 0.001 ? formatPercent(item.overflowRatio) : "0%",
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
          body.append(el("p", { class: "stat__hint", text: `只显示前 ${samples.length} 条，共 ${family.samples.length} 条。` }));
        }
      }
      card.append(summary, body);
      return card;
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

function formatByUnitFor(unit, value) {
  switch (unit) {
    case "rate": return formatRateValue(value) === "—" ? "—" : `${formatRateValue(value)} 次/分`;
    case "duration": return formatLatency(value);
    case "bytes": return formatBytes(value);
    default: return formatCount(value);
  }
}
