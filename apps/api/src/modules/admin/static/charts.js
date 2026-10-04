/* ============================================================
   运维面板 · 图表基元
   ------------------------------------------------------------
   全部用 createElementNS 画 SVG，没有图表库：面板由 Fastify 静态托管、
   零依赖启动，需要的又只有三种形状，为它们引入一个几百 KB 的运行时
   并不划算。SVG 而不是 canvas：曲线是 DOM，读屏能读、CSS 动效接管。

   三条读图规矩（第一版踩过的坑）：
   1. **没有数据就不画**。空窗口画平线等于说「一直是 0」，而事实是
      「还不知道」——那是两件事。
   2. **null 是断点，不是 0**。两点之间缺采样时断开曲线，而不是连一条
      直线过去假装当时有读数。
   3. **给量程留头**，且只按**窗口内**的最大值缩放——一个尖峰把其余
      全部压成贴底直线，是"图在撒谎"最常见的形态。悬停读数补足精度。
   ============================================================ */

import { formatByUnit } from "./format.js";
import { el, svg } from "./ui.js";

const VIEW_W = 600;
const VIEW_H = 170;
const PAD_Y = 14;

/** 平滑曲线：Catmull-Rom → 三次贝塞尔，只作用于连续段内部。 */
function smoothPath(points, tension = 0.3) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.01} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** 窗口内有效值的统计（峰值/末值），供标题与读数使用。 */
export function summarize(values) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return { count: 0, last: null, peak: null, min: null };
  return {
    count: finite.length,
    last: finite[finite.length - 1],
    peak: Math.max(...finite),
    min: Math.min(...finite),
  };
}

let gradientSeq = 0;

/**
 * 面积折线图（带时间轴与悬停读数）。
 *
 * @param values 数值序列（null = 该时刻没有采样）
 * @param times  与 values 等长的 epoch ms 序列（null 时退化为纯索引轴）
 * @param onHover 悬停回调 `(index | null) => void`。用来做**跨图共享时间光标**：
 *               指标页在任一图上悬停时，其余图同步显示同一点的竖线。
 */
export function areaChart({
  values,
  times = null,
  color = "var(--cyan)",
  label = "",
  unit = "count",
  valueText = "",
  emptyHint = "正在积累数据…",
  onHover = null,
  tall = false,
}) {
  const figure = el("figure", { class: `chart${tall ? " chart--tall" : ""}` });
  const stats = summarize(values);

  if (stats.count < 2) {
    figure.append(el("div", { class: "chart__empty", text: emptyHint }));
    return figure;
  }

  const max = Math.max(stats.peak ?? 0, 0);
  const span = max === 0 ? 1 : max * 1.12; // 留 12% 头，峰值不贴顶
  const usable = VIEW_H - PAD_Y * 2;
  const xAt = (index) => (values.length === 1 ? VIEW_W / 2 : (index / (values.length - 1)) * VIEW_W);
  const yAt = (value) => PAD_Y + usable - (Math.max(0, value) / span) * usable;
  // 全 0 时把线压在底部稍上一点，避免和坐标轴重叠成"没有数据"。
  const yZero = yAt(0);

  const gradientId = `chart-grad-${++gradientSeq}`;
  const chartSvg = svg("svg", {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    preserveAspectRatio: "none",
    class: "chart__svg",
    role: "img",
    "aria-label": `${label}：${valueText}`,
  });

  const defs = svg("defs");
  const gradient = svg("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
  gradient.append(
    svg("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.32" }),
    svg("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }),
  );
  defs.append(gradient);
  chartSvg.append(defs);

  // 横向参考线：0 / 中 / 顶，给高低一个锚。
  for (const ratio of [0, 0.5, 1]) {
    chartSvg.append(svg("line", {
      x1: 0, x2: VIEW_W,
      y1: yAt(span * ratio), y2: yAt(span * ratio),
      class: "chart__grid",
    }));
  }

  // 按连续段切分：null 即断点，不在缺口上连线。
  const segments = [];
  let current = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = typeof values[i] === "number" && Number.isFinite(values[i]) ? values[i] : null;
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ x: xAt(i), y: yAt(value), index: i, value });
  }
  if (current.length > 0) segments.push(current);

  let animationDelay = 0;
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const line = smoothPath(segment);
    if (!line) continue;
    const baseY = Math.min(VIEW_H, Math.max(yZero, ...segment.map((p) => p.y)));
    const area = `${line} L ${segment[segment.length - 1].x.toFixed(2)} ${baseY} L ${segment[0].x.toFixed(2)} ${baseY} Z`;
    chartSvg.append(svg("path", { d: area, fill: `url(#${gradientId})`, stroke: "none" }));
    const path = svg("path", {
      d: line,
      fill: "none",
      stroke: color,
      "stroke-width": "2.2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      class: "chart__line",
    });
    // 每段依次展开，读起来像"数据正在流过来"；reduced-motion 下由 CSS 瞬时完成。
    path.style.setProperty("--delay", `${animationDelay}ms`);
    animationDelay += 90;
    chartSvg.append(path);
  }

  // 末点标记：一眼看出"现在在哪"。
  const lastIndex = values.length - 1 - [...values].reverse().findIndex((v) => typeof v === "number" && Number.isFinite(v));
  if (lastIndex >= 0 && lastIndex < values.length) {
    const lastValue = values[lastIndex];
    chartSvg.append(
      svg("circle", { cx: xAt(lastIndex), cy: yAt(lastValue), r: 4, fill: color, class: "chart__dot" }),
      svg("circle", { cx: xAt(lastIndex), cy: yAt(lastValue), r: 9, fill: color, opacity: "0.16" }),
    );
  }

  // 悬停层：竖线 + 点 + 浮动读数。
  const hoverLine = svg("line", { class: "chart__crosshair", x1: 0, x2: 0, y1: PAD_Y, y2: VIEW_H - PAD_Y, visibility: "hidden" });
  const hoverDot = svg("circle", { class: "chart__hoverdot", r: 4, fill: color, visibility: "hidden" });
  chartSvg.append(hoverLine, hoverDot);
  figure.append(chartSvg);

  const tip = el("div", { class: "chart__tip", hidden: true });
  figure.append(tip);

  const axis = el("div", { class: "chart__axis" },
    el("span", { text: times ? clockOf(times[0]) : "起点" }),
    el("span", { text: times ? clockOf(times[Math.floor(times.length / 2)]) : "" }),
    el("span", { text: times ? clockOf(times[times.length - 1]) : "现在" }),
  );
  figure.append(axis);

  const hideCursor = () => {
    hoverLine.setAttribute("visibility", "hidden");
    hoverDot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };

  /**
   * 画出某索引处的光标。`withTip=false` 时只画竖线与点——
   * 跨图联动时，别的图不该弹自己的读数气泡。
   */
  const paintCursor = (index, { withTip = true } = {}) => {
    if (index === null || index === undefined) {
      hideCursor();
      return;
    }
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      hideCursor();
      return;
    }
    const x = xAt(index);
    hoverLine.setAttribute("x1", String(x));
    hoverLine.setAttribute("x2", String(x));
    hoverLine.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", String(x));
    hoverDot.setAttribute("cy", String(yAt(value)));
    hoverDot.setAttribute("visibility", "visible");
    if (!withTip) return;

    tip.hidden = false;
    tip.textContent = times?.[index]
      ? `${formatByUnit(value, unit)} · ${clockOf(times[index])}`
      : formatByUnit(value, unit);
    // 让提示贴住指针、靠边时自动收进容器内。
    const figureRect = figure.getBoundingClientRect();
    const xPercent = (x / VIEW_W) * figureRect.width;
    tip.style.setProperty("--x", `${Math.min(Math.max(xPercent, 40), figureRect.width - 40)}px`);
  };

  // 供跨图联动调用（指标页的共享时间光标）。
  figure.applyCursor = (index) => paintCursor(index, { withTip: false });

  const indexAt = (event) => {
    const rect = chartSvg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.round(ratio * (values.length - 1));
  };
  chartSvg.addEventListener("pointermove", (event) => {
    const index = indexAt(event);
    paintCursor(index);
    onHover?.(index);
  });
  chartSvg.addEventListener("pointerleave", () => {
    paintCursor(null);
    onHover?.(null);
  });

  figure.dataset.points = String(stats.count);
  return figure;
}

function clockOf(epochMs) {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
  return new Date(epochMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
