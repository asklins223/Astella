/* ============================================================
   面板图表基元
   ------------------------------------------------------------
   全部用 createElementNS 画 SVG，没有图表库，也没有构建步骤。

   为什么不用库：面板要能被一个 Fastify 静态托管、零依赖启动；而
   这里需要的只有「平滑折线 + 面积渐变 + 柱条」三种形状，为它们引入
   一个几百 KB 的运行时并不划算。顺带一提，用 SVG 而不是 <canvas>
   是有意的——曲线是 DOM，可以被读屏软件读出数值，也可以被 CSS 动效
   直接接管。

   所有形状都遵守同一条规矩：**没有数据就不画**。空窗口画一条平线
   等于说「一直是 0」，而事实是「还不知道」——那是两件事。
   ============================================================ */

const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/** viewBox 坐标 → 像素坐标。图表按固定 viewBox 画，由 CSS 拉伸到容器宽。 */
const VIEW_W = 600;
const VIEW_H = 180;

/**
 * Catmull-Rom → 三次贝塞尔，得到一条穿过所有点的平滑曲线。
 *
 * 为什么不用直线连接：15 秒一个采样点、总共几十个点，直线段会让图看起来
 * 像锯齿而不是趋势。平滑曲线的代价是它暗示了"点之间是连续的"——对速率
 * 这种本来就是连续量来说没问题。
 */
function smoothPath(points, tension = 0.32) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
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

/** 在 viewBox 里把 (index, value) 映射成像素坐标。 */
function project(values, index) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  const max = Math.max(...finite, 0);
  // 全部相等时（常见于"一直是 0"）给一个人为的量程，
  // 否则分母为 0 会得到 NaN，图直接消失。
  const span = max === 0 ? 1 : max;
  const pad = VIEW_H * 0.12;
  const usable = VIEW_H - pad * 2;
  const x = values.length === 1 ? VIEW_W / 2 : (index / (values.length - 1)) * VIEW_W;
  const y = pad + usable - (Math.max(0, values[index] ?? 0) / span) * usable;
  return { x, y };
}

let gradientSeq = 0;

/**
 * 面积折线图。
 *
 * @param values 数值序列；`null` 表示该采样点**没有值**（不是 0）。
 * @returns <figure>；无有效数据时返回带说明的占位，不返回空图。
 */
export function areaChart({ values, color = "var(--accent)", label = "", valueText = "", emptyHint = "正在积累数据…" }) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const figure = document.createElement("figure");
  figure.className = "chart";

  if (finite.length < 2) {
    figure.append(
      Object.assign(document.createElement("div"), {
        className: "chart__empty",
        textContent: emptyHint,
      }),
    );
    return figure;
  }

  const gradientId = `chart-grad-${++gradientSeq}`;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    preserveAspectRatio: "none",
    class: "chart__svg",
    role: "img",
    "aria-label": `${label}：${valueText}`,
  });

  const defs = svgEl("defs");
  const gradient = svgEl("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
  gradient.append(
    svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": "0.28" }),
    svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": "0" }),
  );
  defs.append(gradient);
  svg.append(defs);

  // 横向参考线：给"高/低"一个视觉锚点，而不是只有曲线孤零零地飘着。
  for (const ratio of [0, 0.5, 1]) {
    const y = VIEW_H * 0.12 + (VIEW_H * 0.76) * (1 - ratio);
    svg.append(svgEl("line", { x1: 0, x2: VIEW_W, y1: y, y2: y, class: "chart__grid" }));
  }

  const points = [];
  const valueAt = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = typeof values[i] === "number" && Number.isFinite(values[i]) ? values[i] : null;
    valueAt.push(value);
    const projected = project(values, i);
    if (value !== null && projected) points.push(projected);
  }

  const line = smoothPath(points);
  if (!line) return figure;

  const areaPath = `${line} L ${points[points.length - 1].x.toFixed(2)} ${VIEW_H} L ${points[0].x.toFixed(2)} ${VIEW_H} Z`;

  svg.append(
    svgEl("path", { d: areaPath, fill: `url(#${gradientId})`, stroke: "none" }),
    svgEl("path", {
      d: line,
      fill: "none",
      stroke: color,
      "stroke-width": "2.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      class: "chart__line",
    }),
  );

  // 末点标记：一眼看出"现在在哪"。
  const last = points[points.length - 1];
  svg.append(
    svgEl("circle", { cx: last.x, cy: last.y, r: 4.5, fill: color, class: "chart__dot" }),
    svgEl("circle", { cx: last.x, cy: last.y, r: 9, fill: color, opacity: "0.18" }),
  );

  figure.append(svg);

  const caption = document.createElement("figcaption");
  caption.className = "chart__caption";
  caption.textContent = valueText;
  figure.append(caption);

  // 供调用方拿到"数据为空"这件事（例如决定要不要显示"采样中"提示）。
  figure.dataset.points = String(points.length);
  figure.dataset.missing = String(values.length - valueAt.filter((v) => v !== null).length);
  return figure;
}

/**
 * 迷你走势线——嵌在统计砖里，宽度自适应，不占独立卡片。
 */
export function sparkline({ values, color = "var(--accent)" }) {
  const svg = svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} 60`,
    preserveAspectRatio: "none",
    class: "spark",
    "aria-hidden": "true",
  });
  const points = [];
  for (let i = 0; i < values.length; i += 1) {
    if (typeof values[i] !== "number" || !Number.isFinite(values[i])) continue;
    const max = Math.max(...values.filter((v) => typeof v === "number"), 0);
    const span = max === 0 ? 1 : max;
    const x = values.length === 1 ? VIEW_W / 2 : (i / (values.length - 1)) * VIEW_W;
    points.push({ x, y: 56 - (Math.max(0, values[i]) / span) * 50 });
  }
  if (points.length >= 2) {
    svg.append(svgEl("path", {
      d: smoothPath(points),
      fill: "none",
      stroke: color,
      "stroke-width": "3",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      opacity: "0.75",
    }));
  }
  return svg;
}

/**
 * 水平堆叠条 —— 队列的构成（等待 / 执行中 / 失败 / 停止）。
 *
 * 用一条而不是四行数字：比例关系是这里真正要看的东西。
 */
export function stackedBar({ segments }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const bar = document.createElement("div");
  bar.className = "stack";

  if (total <= 0) {
    bar.classList.add("stack--empty");
    return bar;
  }

  for (const segment of segments) {
    if (segment.value <= 0) continue;
    const piece = document.createElement("span");
    piece.className = "stack__piece";
    piece.style.setProperty("--w", `${(segment.value / total) * 100}%`);
    piece.style.setProperty("--c", segment.color);
    piece.title = `${segment.label} ${segment.value}`;
    bar.append(piece);
  }
  return bar;
}