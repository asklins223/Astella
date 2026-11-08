/* ============================================================
   视图 · 指标（异常优先 + 分段 + 可视化读数）
   ------------------------------------------------------------
   这一版改的是**信息位置**，不是视觉语言：仍是玻璃卡 + 发丝线，
   配色只取既有 --bad / --warn / --ok / --series-*，没有新的标题样式。

   旧版 5502px 的成因有三个，逐个处理：
   1. 12 个「名称 + 数字」竖排读数——现在按**量的性质**分三种画法：
      有上限的（成功率、连接池、堆、事件循环）用仪表条，计数积压用
      量级条，纯吞吐量放一行事实带。数字不再平铺成一列。
   2. 8 张图一次平铺——现在按「请求 / 资源 / 数据库」分段，一次只画一组。
      跨图同步光标保留：同一组内悬停任一图，其余图落在同一时刻。
   3. 62 个原始指标家族通栏——移进「原始值」子页，默认全部收起。
      「慢路由」从底部通栏表格改成子页里的耗时构成条 + p95 量级条。

   异常读数的判据写在 ABNORMAL 里（错误率>0、p95>1s、事件循环>100ms、
   连接池>80%、堆>85%、事务失败/RLS 拒绝>0），正常时给一行好消息而不是
   一片空白。点异常行进抽屉：那里写清「当前值 / 阈值 / 该看哪张图」。
   ============================================================ */

import { api } from "../api-client.js";
import {
  formatBytes, formatCount, formatDuration, formatLatency, formatMs,
  formatNumber, formatPercent, formatRateValue,
} from "../format.js";
import { el, section, table, emptyState, badge, icon, openDrawer, drawerFacts, drawerSection } from "../ui.js";
import {
  SERIES_COLORS, seriesChart, compositionBar, meterRow, barList,
} from "./shared.js";
import { summarize } from "../charts.js";

export const view = {
  title: "指标", eyebrow: "PERFORMANCE",
  lede: "先看有没有异常，再看过去半小时哪里在变差。",
  load: loadMetrics,
};

const RANGES = [
  { label: "10 分钟", value: 10 * 60 * 1000 },
  { label: "30 分钟", value: 30 * 60 * 1000 },
];

const TABS = [
  { id: "overview", label: "指标" },
  { id: "raw", label: "原始值" },
  { id: "slow", label: "慢路由" },
];

/** 图墙分组：一次只画一组，避免 8 张图平铺。 */
const CHART_GROUPS = [
  { id: "request", label: "请求", keys: ["requestsPerMinute", "p95Seconds"] },
  { id: "resource", label: "资源", keys: ["eventLoopLagSeconds", "heapUsedBytes"] },
  { id: "database", label: "数据库与积压", keys: ["poolActive", "outboxPending"] },
];

/**
 * 跨刷新保留：45 秒自动刷新会重建视图，时间窗 / 分段 / 搜索 / 分组
 * 都不能跳回默认值——否则正在看的图突然换成另一组。
 */
const state = { rangeMs: 30 * 60 * 1000, tab: "overview", group: "request", rawSearch: "" };

/** 从原始家族里读一个 gauge 值（headline 不含上限口径时用它补齐）。 */
function gaugeOf(families, name) {
  const family = families.find((item) => item.name === name);
  const value = family?.samples?.find((sample) => Object.keys(sample.labels ?? {}).length === 0)?.value
    ?? family?.samples?.[0]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function byUnit(unit, value) {
  switch (unit) {
    case "rate": return `${formatRateValue(value)} 次/分`;
    case "duration": return formatLatency(value);
    case "bytes": return formatBytes(value);
    default: return formatCount(value);
  }
}

/**
 * 异常判据。阈值集中在这里，抽屉里的「阈值」文案与这里的判断同源，
 * 不会出现"页面说超了、抽屉写另一个数"。
 */
function abnormalReadings({ h, last, poolMax, heapTotal }) {
  const readings = [];
  const add = (severity, key, label, valueText, capacity, group) => {
    readings.push({ severity, key, label, valueText, capacity, group });
  };

  if (h.httpSuccessRate !== null && h.httpSuccessRate < 1) {
    add("bad", "success", "成功率下降", formatPercent(h.httpSuccessRate), "目标是 100%；任何非 2xx/3xx 都会拉低它", "request");
  }
  if ((last?.errorsPerMinute ?? 0) > 0) {
    add("bad", "errors", "服务端错误在发生", `${formatRateValue(last.errorsPerMinute)} 次/分`, "阈值是 0 次/分：每分钟都在失败就要看", "request");
  }
  if ((last?.p95Seconds ?? 0) > 1) {
    add("bad", "p95", "响应耗时 p95 超过 1 秒", formatLatency(last.p95Seconds), "阈值 1 秒（超过就是交互明显变慢）", "request");
  } else if ((last?.p95Seconds ?? 0) > 0.5) {
    add("warn", "p95", "响应耗时 p95 偏高", formatLatency(last.p95Seconds), "预警线 500ms，故障线 1 秒", "request");
  }
  if ((h.eventLoopLagSeconds ?? 0) > 0.1) {
    add("bad", "lag", "事件循环被占住", `${Math.round(h.eventLoopLagSeconds * 1000)} ms`, "阈值 100ms：主线程阻塞时请求在排队等 CPU", "resource");
  } else if ((h.eventLoopLagSeconds ?? 0) > 0.05) {
    add("warn", "lag", "事件循环延迟偏高", `${Math.round(h.eventLoopLagSeconds * 1000)} ms`, "预警线 50ms", "resource");
  }
  if (h.dbPoolActive !== null && poolMax) {
    const ratio = h.dbPoolActive / poolMax;
    if (ratio > 0.8) {
      add(ratio > 0.95 ? "bad" : "warn", "pool", "数据库连接接近上限", `${formatCount(h.dbPoolActive)} / ${formatCount(poolMax)}`, "超过 80% 就会开始排队，95% 是故障线", "database");
    }
  }
  if (h.dbTransactionFailures > 0) {
    add("bad", "txfail", "有数据库事务失败", formatCount(h.dbTransactionFailures), "阈值是 0：事务失败会丢业务写入", "database");
  }
  if (h.dbRlsDenied > 0) {
    add("warn", "rls", "有越权访问被拦截", formatCount(h.dbRlsDenied), "阈值是 0：被 RLS 拒绝说明有代码在越界取数", null);
  }
  if (h.heapUsedBytes !== null && heapTotal) {
    const ratio = h.heapUsedBytes / heapTotal;
    if (ratio > 0.85) {
      add(ratio > 0.95 ? "bad" : "warn", "heap", "堆内存接近上限", `${formatPercent(ratio)}`, "超过 85% 会频繁 GC，95% 后可能 OOM", "resource");
    }
  }
  if ((last?.queuePending ?? 0) > 0) {
    add("warn", "queue", "后台任务有积压", formatCount(last.queuePending), "阈值是 0：积压说明 worker 跟不上", "database");
  }
  if (h.outboxPendingTotal > 0) {
    add("warn", "outbox", "学习结算有积压", formatCount(h.outboxPendingTotal), "阈值是 0：结算没跑完，学员会看到旧进度", "database");
  }

  return readings;
}

async function loadMetrics(ctx) {
  const [data, series] = await Promise.all([
    api("/metrics"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
  ]);
  if (!ctx.isActive()) return el("div");

  const allPoints = series.points ?? [];
  const last = allPoints.length ? allPoints[allPoints.length - 1] : null;
  const h = data.headline;
  const families = [...data.business, ...data.process];
  const routes = data.slowestRoutes ?? [];
  const poolMax = gaugeOf(families, "astella_db_pool_max_connections");
  const heapTotal = gaugeOf(families, "nodejs_heap_size_total_bytes");

  const wrap = el("div", {});

  /* ── 工具条：分段 + 时间窗 ── */
  const tabs = el("div", { class: "seg", role: "group", "aria-label": "视图" });
  const rangeChips = el("div", { class: "chips", role: "group", "aria-label": "时间窗" });
  const toolsNote = el("span", { class: "queue-tools__note" });
  const tools = el("div", { class: "queue-tools" }, tabs, rangeChips, toolsNote);
  const body = el("div", {});
  wrap.append(tools, body);

  function renderChrome() {
    tabs.replaceChildren(...TABS.map((tab) => el("button", {
      class: "seg__item", type: "button", text: tab.label,
      "aria-pressed": String(state.tab === tab.id),
      onclick: () => { state.tab = tab.id; renderChrome(); paint(); },
    })));
    rangeChips.replaceChildren(...RANGES.map((range) => el("button", {
      class: "chip", type: "button", text: range.label,
      "aria-pressed": String(range.value === state.rangeMs),
      onclick: () => {
        state.rangeMs = range.value;
        renderChrome();
        paint();
      },
    })));
    toolsNote.textContent = state.tab === "slow"
      ? `${routes.length} 条有流量的路由`
      : state.tab === "raw"
        ? `${families.length} 个家族 · 默认收起`
        : `最近 ${RANGES.find((range) => range.value === state.rangeMs)?.label ?? ""}采样`;
  }

  /* ── 指标分段：异常优先 → 读数 → 走势 ── */
  function overviewView() {
    const anomalies = abnormalReadings({ h, last, poolMax, heapTotal });
    const bad = anomalies.filter((item) => item.severity === "bad");
    const warn = anomalies.filter((item) => item.severity === "warn");

    const anomalyBlock = anomalies.length === 0
      ? emptyState("没有异常读数", "错误率、p95、事件循环、连接池、内存、积压都在阈值内。", "good")
      : el("div", {}, ...[...bad, ...warn].map((item) => anomalyRow(item)));

    /* 有上限的量：仪表条。比率只在这里有意义，所以只给这几项。
       成功率不放进仪表：仪表的语义是「越高越差」，而成功率越高越好——
       放进来会把 100% 画成红色。它改放在下面的一行事实带里。 */
    const capacity = el("div", {},
      meterRow({
        label: "数据库连接",
        value: h.dbPoolActive !== null && poolMax ? h.dbPoolActive / poolMax : null,
        detail: `${formatCount(h.dbPoolActive)} / ${formatCount(poolMax)}`,
        warnAt: 0.8,
        badAt: 0.95,
      }),
      meterRow({
        label: "堆内存",
        value: h.heapUsedBytes !== null && heapTotal ? h.heapUsedBytes / heapTotal : null,
        detail: `${formatBytes(h.heapUsedBytes)} / ${formatBytes(heapTotal)}`,
        warnAt: 0.85,
        badAt: 0.95,
      }),
      meterRow({
        label: "事件循环延迟",
        value: h.eventLoopLagSeconds === null ? null : Math.min(1, h.eventLoopLagSeconds / 0.1),
        detail: `${Math.round((h.eventLoopLagSeconds ?? 0) * 1000)} ms / 阈值 100 ms`,
        warnAt: 0.5,
        badAt: 1,
      }),
    );

    /* 计数类积压：量级条；全是 0 时给一句结论，不画一排空条。 */
    const backlogs = [
      { key: "queuePending", label: "排队任务", value: last?.queuePending ?? 0 },
      { key: "outboxPending", label: "学习结算积压", value: h.outboxPendingTotal ?? 0 },
      { key: "txfail", label: "事务失败", value: h.dbTransactionFailures ?? 0 },
      { key: "rls", label: "RLS 拒绝", value: h.dbRlsDenied ?? 0 },
    ];
    const backlogBlock = backlogs.some((item) => item.value > 0)
      ? barList(backlogs.map((item) => ({
          ...item,
          color: item.key === "queuePending" || item.key === "outboxPending" ? "var(--series-7)" : "var(--bad)",
        })), { max: Math.max(1, ...backlogs.map((item) => item.value)) })
      : el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0", text: "队列、结算、事务、越权拦截都是 0——没有需要排队的活。" });

    /* 无上限的吞吐量：一行事实带（不是一列读数）。 */
    const throughput = el("div", { class: "k-strip k-strip--lead" },
      stripFact("成功率", h.httpSuccessRate === null ? "—" : formatPercent(h.httpSuccessRate), h.httpSuccessRate !== null && h.httpSuccessRate < 1 ? "is-bad" : "is-ok"),
      stripFact("请求速率", `${formatRateValue(last?.requestsPerMinute ?? null)} 次/分`, ""),
      stripFact("响应耗时 p95", formatLatency(last?.p95Seconds ?? null), (last?.p95Seconds ?? 0) > 1 ? "is-bad" : (last?.p95Seconds ?? 0) > 0.5 ? "is-warn" : ""),
      stripFact("请求累计", formatNumber(h.httpRequestsTotal), ""),
      stripFact("常驻内存", formatBytes(h.rssBytes), ""),
    );

    return el("div", { class: "metrics-stage" },
      el("div", { class: "metrics-stage__lead" },
        section("异常读数", bad.length > 0 ? `${bad.length} 项需要立刻处理` : warn.length > 0 ? `${warn.length} 项预警` : "按判据逐项检查过",
          anomalyBlock),
        section("此刻读数", "有上限的用仪表，没有积压就只留一句结论",
          capacity,
          el("div", { class: "u-mt-14" }, backlogBlock),
          throughput),
      ),
      chartsSection(),
    );
  }

  function anomalyRow(item) {
    return el("button", {
      class: "queue-row", type: "button",
      onclick: () => openAnomalyDrawer(item),
    },
      el("span", { style: "display:block;min-width:0" },
        el("span", { class: "queue-row__name" },
          el("span", { class: "dot", dataset: { tone: item.severity === "bad" ? "bad" : "warn" } }),
          item.label),
        el("span", { class: "queue-row__meta", text: item.capacity }),
      ),
      el("span", {
        class: `queue-row__num${item.severity === "bad" ? " queue-row__num--bad" : ""}`,
        text: item.valueText,
      }),
      el("span", { class: "queue-row__go" }, icon(["M9 5l7 7-7 7"], { size: 14 })),
    );
  }

  function openAnomalyDrawer(item) {
    const group = CHART_GROUPS.find((entry) => entry.id === item.group);
    const foot = item.group
      ? el("button", {
          class: "btn btn--sm", type: "button", text: `看「${group?.label ?? ""}」走势`,
          onclick: () => {
            state.tab = "overview";
            state.group = item.group;
            renderChrome();
            paint();
            drawer.close();
          },
        })
      : null;

    const drawer = openDrawer({
      title: item.label,
      eyebrow: item.severity === "bad" ? "异常读数" : "预警读数",
      sub: `${item.valueText} · 当前值`,
      body: [
        drawerFacts([
          ["当前值", item.valueText],
          ["判据", item.capacity],
          ["级别", item.severity === "bad" ? "异常（超故障线）" : "预警（超预警线）"],
        ]),
        drawerSection("接下来看什么", null,
          el("p", { class: "dim", style: "font-size:12px;line-height:1.8;margin:8px 0 0", text: item.group
            ? `这张读数在「${group?.label ?? ""}」组里有对应曲线：看它是尖峰（一时的）还是台阶（持续变差）。如果是尖峰，等一两分钟再刷新；如果是台阶，去「慢路由」分段看是哪条路由在拖。`
            : "这条读数没有对应曲线（原始指标里的累计值）。去「原始值」分段按名字搜，需要精确数值时以那里为准。" }),
        ),
      ],
      foot: foot ? [foot] : [],
    });
  }

  /* ── 走势：分组图墙，组内共享时间光标 ── */
  function chartsSection() {
    const cutoff = Date.now() - state.rangeMs;
    const points = allPoints.filter((point) => point.t >= cutoff);
    const metaByKey = new Map((series.series ?? []).map((meta) => [meta.key, meta]));
    const group = CHART_GROUPS.find((entry) => entry.id === state.group) ?? CHART_GROUPS[0];

    const groupSeg = el("div", { class: "seg", role: "group", "aria-label": "图墙分组" });
    function paintGroupSeg() {
      groupSeg.replaceChildren(...CHART_GROUPS.map((entry) => el("button", {
        class: "seg__item", type: "button", text: entry.label,
        "aria-pressed": String(state.group === entry.id),
        onclick: () => { state.group = entry.id; paint(); },
      })));
    }
    paintGroupSeg();

    const chartsArea = el("div", {});
    if (points.length < 2) {
      chartsArea.replaceChildren(el("div", { class: "chart__empty", text: "这个窗口里点还不够——把窗口放宽到 30 分钟，或等几分钟再看。" }));
    } else {
      const figureEls = [];
      const cells = group.keys.map((key) => {
        const meta = metaByKey.get(key);
        if (!meta) return null;
        const stats = summarize(points.map((point) => (typeof point[key] === "number" ? point[key] : null)));
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
          key, label: meta.label,
          color: SERIES_COLORS[key],
          unit: meta.unit,
          tall: true,
          onHover: (index) => {
            // 跨图共享：这个点在哪，同组所有图的竖线就都画在哪。
            for (const other of figureEls) {
              if (other !== figureEl) other.applyCursor?.(index);
            }
          },
        });
        cell.append(figureEl);
        figureEls.push(figureEl);
        return cell;
      }).filter(Boolean);
      chartsArea.replaceChildren(el("div", { class: "chart-wall" }, ...cells));
    }

    return section("走势", "缺口 = 那段没有采样，不是 0",
      el("div", { class: "row row--between", style: "gap:12px" },
        groupSeg,
        el("span", { class: "section__note", text: "悬停任一图，同组所有图同步同一点" }),
      ),
      el("div", { class: "u-mt-10" }, chartsArea),
    );
  }

  /* ── 原始值分段：62 个家族，默认全部收起 ── */
  function rawView() {
    const rawSearch = el("input", {
      class: "field__input", type: "search", value: state.rawSearch,
      placeholder: "按指标名过滤，比如 astella_http 或 nodejs_heap",
      "aria-label": "过滤原始指标",
    });
    const rawBody = el("div", {});
    const rawCount = el("span", { class: "queue-tools__note" });

    function renderRaw() {
      const needle = rawSearch.value.trim().toLowerCase();
      const visible = families.filter((family) =>
        !needle
        || family.name.toLowerCase().includes(needle)
        || (family.label ?? "").toLowerCase().includes(needle));
      const withData = visible.filter((family) => (family.samples?.length ?? 0) > 0 || (family.histograms?.length ?? 0) > 0);
      rawCount.textContent = `${visible.length} 个家族 · ${withData.length} 个有样本`;
      if (visible.length === 0) {
        rawBody.replaceChildren(emptyState("没有匹配的指标", "换个关键词，或清空过滤框。"));
        return;
      }
      rawBody.replaceChildren(...visible.map((family) => {
        // 默认不展开：62 个家族全摊开就是旧版 5502px 的主因。
        const item = el("details", { class: "disclosure" });
        const summary = el("summary", {},
          el("span", { text: family.label ?? family.name }),
          el("span", {
            class: "badge badge--neutral badge--mono",
            title: family.name,
            text: `${family.type} · ${family.samples?.length ?? 0} 条`,
          }),
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
          const samples = (family.samples ?? []).slice(0, 30);
          body.append(table(
            ["标签", "值"],
            samples.map((sample) => [
              el("span", { class: "mono", text: Object.entries(sample.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ") || "—" }),
              formatNumber(sample.value),
            ]),
            { numericColumns: [1] },
          ));
          if ((family.samples?.length ?? 0) > samples.length) {
            body.append(el("p", { class: "figure__hint", text: `只显示前 ${samples.length} 条，共 ${family.samples.length} 条。` }));
          }
        }
        item.append(summary, body);
        return item;
      }));
    }

    rawSearch.addEventListener("input", () => { state.rawSearch = rawSearch.value; renderRaw(); });
    renderRaw();

    return section("原始指标", "给告警集成与深挖用 · 点开才读样本",
      el("div", { class: "queue-tools" },
        el("div", { class: "queue-tools__search" }, rawSearch),
        rawCount),
      el("div", { class: "u-mt-10" }, rawBody),
    );
  }

  /* ── 慢路由分段：耗时构成条 + p95 量级条（点开抽屉）── */
  function slowView() {
    if (routes.length === 0) {
      return section("最慢的路由", "按 p95 排序",
        emptyState("还没有带流量的路由", "有请求打到服务之后，这里会按 p95 从慢到快排出前 8 条。"));
    }

    // 构成条的口径：p95 × 样本数 ≈ 这条路由占用的「慢时间」。
    const weighted = routes.map((route) => ({
      key: `${route.method} ${route.route}`,
      label: `${route.method} ${route.route}`,
      value: (route.p95 ?? 0) * route.count,
      route,
    }));
    const total = weighted.reduce((sum, item) => sum + item.value, 0);
    const distribution = compositionBar({
      items: weighted.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        hint: `${item.label} · p95 ${item.route.p95 === null ? "—" : formatMs(item.route.p95 * 1000)} · ${formatCount(item.route.count)} 次`,
      })),
      limit: 5,
      restLabel: "其余",
      ariaLabel: `慢路由耗时构成，合计约 ${formatDuration(total)}`,
      onLocate: (key) => {
        const hit = weighted.find((item) => item.key === key);
        if (hit) openRouteDrawer(hit.route);
      },
    });

    const ranked = [...routes].sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
    const list = barList(ranked.map((route) => ({
      key: `${route.method} ${route.route}`,
      label: `${route.method} ${route.route}`,
      value: route.p95 ?? 0,
      note: `${route.p95 === null ? "—" : formatMs(route.p95 * 1000)} · ${formatCount(route.count)} 次`,
    })), { max: Math.max(0.001, ...ranked.map((route) => route.p95 ?? 0)), onSelect: (key) => {
      const hit = ranked.find((route) => `${route.method} ${route.route}` === key);
      if (hit) openRouteDrawer(hit);
    } });

    return section("最慢的路由", "按 p95 排序 · 样本数为 0 的路由不参与",
      el("div", { style: "margin-bottom:22px" },
        el("div", { class: "dist__caption" },
          el("div", {},
            el("div", { class: "dist__total", text: `≈ ${formatDuration(total)}` }),
            el("div", { class: "dist__note", text: `${routes.length} 条路由按 p95 × 样本数估算的耗时占比` }),
          ),
          el("div", { class: "dist__note", style: "text-align:right" },
            `最重的 3 条占 ${total > 0 ? Math.round((weighted.slice().sort((a, b) => b.value - a.value).slice(0, 3).reduce((sum, item) => sum + item.value, 0) / total) * 100) : 0}%`),
        ),
        distribution.node,
      ),
      list,
    );
  }

  function openRouteDrawer(route) {
    const share = (() => {
      const total = routes.reduce((sum, item) => sum + (item.p95 ?? 0) * item.count, 0);
      return total > 0 ? ((route.p95 ?? 0) * route.count) / total : 0;
    })();
    const drawer = openDrawer({
      title: `${route.method} ${route.route}`,
      eyebrow: "最慢路由",
      sub: `p95 ${route.p95 === null ? "—" : formatMs(route.p95 * 1000)} · ${formatCount(route.count)} 次请求`,
      body: [
        drawerFacts([
          ["方法", route.method, { mono: true }],
          ["路由", route.route, { mono: true }],
          ["p95", route.p95 === null ? "—" : formatMs(route.p95 * 1000)],
          ["样本数", formatCount(route.count)],
          ["估算总耗时", `≈ ${formatDuration((route.p95 ?? 0) * route.count)}`],
          ["占慢时间", formatPercent(share)],
        ]),
        drawerSection("怎么读这条", null,
          el("p", { class: "dim", style: "font-size:12px;line-height:1.8;margin:8px 0 0", text:
            "p95 是估算值（按直方图桶插值），只用于看趋势与排序；要精确数值去「原始值」里看 astella_http_request_duration_seconds 的 p95 桶。样本数小于 10 的路由，p95 容易被单个慢请求抬高。" }),
        ),
      ],
      foot: [el("button", {
        class: "btn btn--sm", type: "button", text: "在原始值里查耗时桶",
        onclick: () => {
          state.tab = "raw";
          state.rawSearch = "duration";
          renderChrome();
          paint();
          drawer.close();
        },
      })],
    });
  }

  function paint() {
    body.replaceChildren(
      state.tab === "raw" ? rawView()
        : state.tab === "slow" ? slowView()
          : overviewView(),
    );
    renderChrome();
  }

  renderChrome();
  paint();
  return wrap;
}

/** 一行事实带里的一个片段（`.k-strip__item` 已存在，不新增类）。 */
function stripFact(label, value, tone) {
  return el("div", { class: "k-strip__item" },
    el("em", { text: label }),
    el("strong", { class: tone || null, text: value }),
  );
}
