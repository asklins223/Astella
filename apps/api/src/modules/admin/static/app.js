/* ============================================================
   运维面板 · 应用逻辑
   ------------------------------------------------------------
   没有框架、没有构建步骤：一份 ES module，浏览器直接加载。

   结构：token 闸 → 路由 → 各视图渲染 → 少量自绘控件（确认框 / 提示条）。
   图表基元在 charts.js。动效里唯一的"非 CSS"部分是导航指示器的弹簧，见 spring()。

   ============================================================ */

import { areaChart, sparkline, stackedBar } from "./charts.js";

const TOKEN_KEY = "ailearn.admin.token";

/** 令牌只放内存（模块作用域），刷新页面即需重新输入。 */
let token = null;

/** 当前视图。切换立即生效，动画不参与"何时可用"的判定。 */
let currentView = "overview";

/** 各视图的缓存，避免切回来时重新取数。 */
const cache = new Map();

/** 定时器句柄：切视图时清掉上一个视图的轮询。 */
let pollTimer = null;

/* ── 工具 ──────────────────────────────────────────────── */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * 创建 DOM 元素。
 *
 * 两个刻意的限制：
 *
 * 1. **没有 `html` 属性**。面板渲染的是服务端数据，用字符串拼装等于把每一个
 *    字段都变成注入面。这里没有例外，全部走 textContent。
 *
 * 2. **`style` 走 CSSOM 而不是 setAttribute**。面板的 CSP 是
 *    `style-src 'self'`，它管的是**样式属性**与 `<style>` 块；CSSOM 的
 *    `element.style.setProperty()` 不在 CSP 管辖范围内。所以直接写
 *    `setAttribute("style", …)` 会被浏览器静默丢弃——表现为"样式莫名其妙没生效"，
 *    很难查。这条分支就是把那条路堵死。
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("el(): 不允许 html 属性（注入防线）");
    else if (key === "style") node.style.cssText = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 用 DOM 构造一个 SVG 图标（不用 innerHTML，与 el() 的注入防线保持一致）。 */
const SVG_NS = "http://www.w3.org/2000/svg";
function icon(paths, { width = 16, height = 16, viewBox = "0 0 24 24" } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.append(...paths.map((d) => {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    return path;
  }));
  return svg;
}

/* ── 数据层 ────────────────────────────────────────────── */

async function api(path, options = {}) {
  const response = await fetch(`/admin/api${path}`, {
    ...options,
    headers: {
      // Bearer 而不是自定义头：省掉一次 CORS 预检，也让 curl/脚本写法一致。
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401 || response.status === 404) {
    // 404 也当作"令牌不对"：面板未启用时所有端点都是 404，回退到闸是唯一合理动作。
    lockGate("令牌无效，或该部署未启用运维面板。");
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      const body = await response.json();
      if (body?.message) detail = body.message;
    } catch {
      /* 响应体不是 JSON，保留默认说明 */
    }
    throw new Error(detail);
  }
  return response.json();
}

function setConnection(state, text) {
  const pill = $("#conn-pill");
  const label = $("#conn-text");
  if (pill) pill.dataset.state = state;
  if (label) label.textContent = text;
}
/* ── 应用绘制的确认框（替代原生 confirm）───────────────── */

function confirmDialog({ title, body, confirmLabel = "确定", tone = "primary" }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    $("#modal-title").textContent = title;
    $("#modal-body").textContent = body;
    const confirm = $("#modal-confirm");
    confirm.className = `btn btn--${tone}`;
    confirm.textContent = confirmLabel;

    function close(result) {
      modal.hidden = true;
      confirm.removeEventListener("click", onConfirm);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onConfirm() {
      close(true);
    }
    function onKey(event) {
      if (event.key === "Escape") close(false);
    }

    confirm.addEventListener("click", onConfirm);
    // 只有 scrim 与取消键带 data-close；确认键**不能**带——否则它会先被
    // 这条"一律视为取消"的处理器 resolve(false)，再轮到 onConfirm 时 promise
    // 已经定死了，表现就是"点确定没反应"。
    $$("[data-close]", modal).forEach((node) => {
      node.onclick = () => close(false);
    });
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    confirm.focus();
  });
}

let toastTimer = null;
function toast(message, tone = "ok") {
  const node = $("#toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.dataset.show = "false";
  }, 3200);
}

/* ── 导航指示器的弹簧 ──────────────────────────────────── */

/**
 * 阻尼弹簧，按帧推进。
 *
 * 为什么不用 CSS transition：指示器在**快速连点不同标签**时需要保留当前位置
 * 与速度。CSS transition 一旦被新的目标值打断，就只能从当前计算值重新起一段
 * 缓动——快速往返时会出现"顿一下再走"的粘滞感。弹簧则天然可打断：
 * 改变目标只是改变加速度，位置与速度连续。
 *
 * 每帧写入 --rail-y（CSSOM 写入，不是内联样式属性，因此不受 CSP style-src 限制）。
 */
function spring({ stiffness = 220, damping = 26, mass = 1, onFrame, onDone }) {
  let position = 0;
  let velocity = 0;
  let target = 0;
  let running = false;
  let lastTime = 0;

  function step(time) {
    const dt = Math.min(0.032, (time - lastTime) / 1000) || 0.016;
    lastTime = time;
    // 半隐式欧拉：先更新速度再更新位置，比显式欧拉稳定得多。
    const force = -stiffness * (position - target);
    velocity += (force / mass) * dt;
    velocity *= Math.exp(-damping * dt);
    position += velocity * dt;

    if (Math.abs(position - target) < 0.4 && Math.abs(velocity) < 6) {
      position = target;
      velocity = 0;
      onFrame(position);
      running = false;
      onDone?.();
      return;
    }
    onFrame(position);
    requestAnimationFrame(step);
  }

  return {
    setTo(next) {
      target = next;
      if (!running) {
        running = true;
        lastTime = performance.now();
        requestAnimationFrame(step);
      }
    },
    snapTo(next) {
      target = next;
      position = next;
      velocity = 0;
      onFrame(position);
    },
  };
}

const railSpring = spring({
  onFrame(value) {
    document.documentElement.style.setProperty("--rail-y", `${value}px`);
  },
});

function updateRailIndicator(snap = false) {
  const item = $(`.rail__item[data-view="${currentView}"]`);
  if (!item) return;
  // `.rail` 是 position:relative，所以导航项的 offsetParent 就是它，
  // 而绝对定位的指示器同样以 `.rail` 的 padding box 原点为基准。
  // 两者原点相同，因此直接用 offsetTop——再减一次 rail.offsetTop 是减错了。
  //
  // 只写位移，不写高度：导航项的高度来自 CSS 常量（见 styles.css 的说明），
  // 在这里从 offsetHeight 反推会形成死循环，壳还没显示时量到 0 就再也回不来。
  const offset = item.offsetTop;
  if (snap) railSpring.snapTo(offset);
  else railSpring.setTo(offset);
}

/* ── 视图 ──────────────────────────────────────────────── */

/**
 * 各视图的说明。
 *
 * 同样一条规矩：**说明里不出现内部代号**。第一版这里写的是
 * 「pending 堆积与最老等待要一起看——depth=1 既可能是刚提交，也可能是卡了一小时」，
 * 而 `pending` / `depth=1` 是指标世界的坐标，一个看面板的人不认识它们，
 * 只会以为自己漏掉了什么。
 */
const VIEWS = {
  overview: {
    title: "概览",
    subtitle: "这个服务现在怎么样、有多少人在用、哪些功能开着。数字都是实时的，不用等。",
    load: loadOverview,
  },
  metrics: {
    title: "指标",
    subtitle: "最近一段时间的走势。耗时是估算值（按直方图分桶插值），看趋势足够，精确告警仍以原始指标为准。",
    load: loadMetrics,
  },
  logs: {
    title: "日志",
    subtitle: "服务最近说过的话。只保留内存里最近的一批，重启即清空；完整日志仍在容器里。",
    load: loadLogs,
  },
  queues: {
    title: "队列",
    subtitle: "服务在后台替用户做的事。排队数量要和「最久等待」一起看——只有 1 个却等了半小时，和有 500 个刚排进来，完全是两回事。",
    load: loadQueues,
  },
  config: {
    title: "配置",
    subtitle: "每种功能由哪家模型服务、哪个模型来回答。密钥不经过浏览器，这里只看它引用了哪个环境变量、有没有配好。",
    load: loadConfig,
  },
};

async function switchView(view, { force = false } = {}) {
  if (!VIEWS[view]) return;
  currentView = view;

  $$(".rail__item").forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  updateRailIndicator();

  const meta = VIEWS[view];
  const content = $("#content");
  content.replaceChildren(el("div", { class: "view", id: "view-root" }));
  const root = $("#view-root");

  root.append(
    el("div", { class: "view__head" },
      el("h1", { class: "view__title", text: meta.title }),
      el("p", { class: "view__sub", text: meta.subtitle }),
    ),
  );
  const body = el("div", { class: "view__body" });
  root.append(body);

  clearInterval(pollTimer);
  pollTimer = null;

  if (!force && cache.has(view)) {
    body.append(cache.get(view));
    return;
  }

  body.append(
    el("div", { class: "grid" },
      ...Array.from({ length: 4 }, () => el("div", { class: "skeleton" })),
    ),
  );

  try {
    setConnection("busy", "载入中");
    const rendered = await meta.load();
    body.replaceChildren(rendered);
    cache.set(view, rendered);
    setConnection("idle", "就绪");
    tickStats(body);
  } catch (error) {
    if (error.message !== "unauthorized") {
      setConnection("error", "出错");
      body.replaceChildren(
        el("div", { class: "card" },
          el("div", { class: "stat__label", text: "载入失败" }),
          el("div", { class: "stat__value stat__value--sm", text: error.message }),
        ),
      );
    }
  }
}

/** 跨数值变化时的一次提亮，让"这个数刚动过"被看见。 */
function tickStats(root) {
  $$(".stat__value[data-stat-id]", root).forEach((node) => {
    const previous = node.dataset.lastValue;
    if (previous !== undefined && previous !== node.textContent) {
      node.classList.remove("is-tick");
      void node.offsetWidth; // 强制重排，让动画可以重播
      node.classList.add("is-tick");
    }
    node.dataset.lastValue = node.textContent;
  });
}

/* ── 概览 ──────────────────────────────────────────────── */

/* ── 格式化 ────────────────────────────────────────────── */

/** 速率：读数按"每分钟多少次"给，标题里已经写明了口径。 */
function formatRate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (n === 0) return "0 次/分";
  if (n < 1) return `${n.toFixed(2)} 次/分`;
  if (n < 10) return `${n.toFixed(1)} 次/分`;
  return `${Math.round(n)} 次/分`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const s = Math.max(0, Number(seconds));
  if (s < 1) return "<1 秒";
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时`;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return "—";
  const n = Number(bytes);
  if (n <= 0) return "0";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return "—";
  const n = Number(ratio);
  return `${(n * 100).toFixed(n >= 0.9995 ? 0 : 2)}%`;
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString("zh-CN");
}

function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN");
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 按图表的 unit 口径把数值说成人话。 */
/**
 * 延迟的读数。
 *
 * 与通用的 formatDuration 分开：接口耗时绝大多数在几十~几百毫秒，
 * 套用「<1 秒 / 3 分 12 秒」这套量级合适的说法，会把 198ms 说成「<1 秒」——
 * 丢掉全部信息量，而这里最该看清的就是差几毫秒。
 */
function formatLatency(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const n = Number(seconds);
  if (n < 1) return `${Math.round(n * 1000)} ms`;
  return formatDuration(n);
}

function formatByUnit(value, unit) {
  switch (unit) {
    case "rate": return formatRate(value);
    case "duration": return formatLatency(value);
    case "bytes": return formatBytes(value);
    default: return formatCount(value);
  }
}

/* ── 通用片段 ──────────────────────────────────────────── */

/** 统计砖。`id` 用于跨刷新比对并触发"这个数刚动过"的一次提亮。 */
function stat(label, value, { unit, hint, tone = "", id, badge } = {}) {
  // 「—」是占位符（没有可说的数），不是读数。用 30px 排它会显得像加载坏了，
  // 所以降一级字号并去掉字重。
  const placeholder = value === "—" || value === "–" || value === "-";
  return el("div", { class: `card card--lift stat${tone ? ` stat--${tone}` : ""}` },
    el("div", { class: "stat__label" }, label, badge ?? null),
    el("div", {
      class: `stat__value${placeholder ? " stat__value--empty" : ""}`,
      dataset: id ? { statId: id } : {} },
      value,
      unit ? el("span", { class: "stat__unit", text: unit }) : null,
    ),
    hint ? el("div", { class: "stat__hint", text: hint }) : null,
  );
}

/** 把统计砖挂上迷你走势线（图表在其下方独立呈现）。 */
function attachSpark(card, values, color) {
  const box = el("div", { class: "stat__spark" });
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  // 全 0 时用中性色：一条贴底的**红色**线会被读成「有坏事发生」，
  // 而「没有报错」正是好消息。
  const allZero = finite.length > 0 && finite.every((v) => v === 0);
  box.append(sparkline({ values, color: allZero ? "var(--ink-faint)" : color }));
  card.append(box);
  return card;
}

/**
 * 代号标签。
 *
 * **默认不显示**。它是给"需要精确对指标名做告警集成的人"准备的，
 * 放在 title 里——悬停可见，不占版面。
 */
function codeTag(text) {
  if (!text) return null;
  return el("span", { class: "code", text, title: `内部标识：${text}` });
}

/** 键值对列表（部署信息这类"有名字有值"的离散事实）。 */
function keyValues(pairs) {
  return el("div", { class: "kv" },
    ...pairs.map(([key, value]) =>
      el("div", { class: "kv__item" },
        el("span", { class: "kv__k", text: key }),
        el("span", { class: "kv__v", text: String(value) }),
      ),
    ),
  );
}

/** 状态色：坏 → 警告 → 正常。 */
function toneFor(value, { warn, bad }) {
  if (value >= bad) return "alert";
  if (value >= warn) return "warn";
  return "ok";
}

/**
 * 图表配色。
 *
 * 判据是**纸面上的可区分度**，不是配色好看：
 *  - 请求/报错是并排的两张主图，必须一眼分得开 → 深蓝 vs 红。
 *  - 红、陶土、莓色在同一族（都是暖红），放在不同卡片里还行，
 *    但指标页 8 张图并排时会糊成一片，所以拆开：延迟用莓、积压用陶土。
 *  - 饱和度刻意压低：亮色在 #fff9eb 纸面上会跳出来、显得廉价。
 */
const SERIES_COLORS = {
  requestsPerMinute: "var(--info)",   // 深蓝 —— 主图
  errorsPerMinute: "var(--bad)",      // 红
  p95Seconds: "var(--violet)",        // 莓
  eventLoopLagSeconds: "var(--gold-ink)", // 深金
  heapUsedBytes: "var(--accent)",     // 苔绿
  poolActive: "var(--sky)",           // 海盐蓝
  queuePending: "var(--warn)",        // 陶土
  outboxPending: "var(--accent-deep)",// 绿
};

/** 取一条曲线的原始值序列（缺失点保留 null，图表据此留空）。 */
function seriesValues(points, key) {
  return points.map((point) => (typeof point[key] === "number" ? point[key] : null));
}

/** 一张趋势图卡片：标题 + 说明 + 图 + 当前读数。 */
function chartCard({ label, hint, values, color, unit, spanLabel }) {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const last = finite.length ? finite[finite.length - 1] : null;
  const peak = finite.length ? Math.max(...finite) : null;

  const card = el("div", { class: "card" },
    el("div", { class: "stat__label" }, label),
    areaChart({
      values,
      color,
      label,
      emptyHint: finite.length ? "正在积累数据…" : "这段时间没有采样",
      valueText: last === null
        ? "暂无读数"
        : `当前 ${formatByUnit(last, unit)}${peak !== null && peak > 0 ? ` · 峰值 ${formatByUnit(peak, unit)}` : ""}`,
    }),
    hint ? el("div", { class: "stat__hint", text: hint }) : null,
    spanLabel ? el("div", { class: "stat__hint", text: spanLabel }) : null,
  );
  return card;
}

/* ── 概览 ──────────────────────────────────────────────── */

/**
 * 判断「现在到底怎么样」，用一句话说清。
 *
 * 刻意**不是**把五个指标拼起来念一遍——那是仪表盘，不是结论。
 * 结论要能回答一个普通人的问题：「这东西能用吗？」
 */
function verdict({ errorsPerMinute, queuePending, oldestPendingSeconds, lagSeconds, requestsPerMinute, recentActivity, blockingCount }) {
  // 阻断级待办排在最前：「功能已经不可用」比「响应慢」更该先说。
  // 顶上写着"一切正常"、底下却有一条"密钥没配"，是最难堪的组合。
  if (blockingCount > 0) {
    return {
      tone: "block",
      icon: "⚠",
      title: `有 ${blockingCount} 项配置问题`,
      body: "模型密钥没配或配置有错误，对应功能现在调用会失败。先看下面「需要你处理」里的第一条。",
    };
  }
  if (errorsPerMinute !== null && errorsPerMinute > 0.5) {
    return {
      tone: "bad",
      icon: "⚠",
      title: "有服务在报错",
      body: `最近每分钟约 ${formatRate(errorsPerMinute)}。用户操作可能会失败，建议先看「日志」里最上面几条。`,
    };
  }
  if (queuePending !== null && queuePending > 0 && oldestPendingSeconds > 900) {
    return {
      tone: "warn",
      icon: "⏳",
      title: "后台任务堵住了",
      body: `有 ${formatCount(queuePending)} 个任务在排队，最久的已经等了 ${formatDuration(oldestPendingSeconds)}。用户不会立刻受影响，但相关的功能会延迟。`,
    };
  }
  if (lagSeconds !== null && lagSeconds > 0.5) {
    return {
      tone: "warn",
      icon: "🐢",
      title: "服务响应变慢",
      body: `事件循环延迟 ${formatDuration(lagSeconds)}，说明请求在排队等 CPU。用户会感觉到「点了没反应」。`,
    };
  }
  if (requestsPerMinute !== null && requestsPerMinute === 0) {
    return {
      tone: "",
      icon: "💤",
      title: "一切正常，当前没人在用",
      // 只看最后一个点会与旁边那张画出历史活动的走势线**自相矛盾**：
      // 曲线明明有形，结论却说"一直没人用"。窗口内有活动就如实说明。
      body: recentActivity
        ? `服务是活的。刚测完使用情况，现在正好安静下来——这不是故障。`
        : "服务是活的，只是这段时间没有收到请求。这不是故障。",
    };
  }
  return {
    tone: "",
    icon: "✓",
    title: "一切正常",
    body: requestsPerMinute !== null
      ? `服务正常运行，最近每分钟约 ${formatRate(requestsPerMinute)}，没有报错。`
      : "服务正常运行，没有报错。",
  };
}

/**
 * 执行一个待办动作。
 *
 * **两种都要求确认**，理由不同：
 *  - `purge` 是**不可逆**的删除。
 *  - `retry` 不可逆，但会重新触发一批模型调用 —— 400 条重试就是 400 次
 *    对外部模型服务的调用，那是实打实的费用。"重试"听起来无害，
 *    按钮底下其实可能是一笔开销。
 *
 * 确认文案里都带上**具体数量**，不含糊。
 */
async function performTodoAction(item) {
  const action = item.action;
  if (action.kind === "goto_config") return switchView("config");
  if (action.kind === "goto_queues") return switchView("queues");

  const isPurge = action.kind === "purge_dead";
  const count = item.count ?? 0;
  const title = isPurge ? "清理这些任务？" : "重试这些任务？";
  const body = isPurge
    ? `「${item.title}」中的 ${formatCount(count)} 条将被**永久删除**，不可恢复。它们的失败原因也会一并消失。`
    : `「${item.title}」中的 ${formatCount(count)} 条会被重新排队，每个都会再次调用模型服务（产生新的调用费用）。`;

  const ok = await confirmDialog({
    title,
    body: body.replace(/\*\*/g, ""),
    confirmLabel: isPurge ? "永久删除" : "重新排队",
    tone: isPurge ? "danger" : "primary",
  });
  if (!ok) return;

  try {
    const result = await api("/jobs/actions", {
      method: "POST",
      body: JSON.stringify({ jobType: action.jobType, action: isPurge ? "purge" : "retry" }),
    });
    const verb = isPurge ? "已清理" : "已重新排队";
    toast(`${verb} ${formatCount(result.affected)} 条`);
    // 只刷新待办那一段：整页重渲染会丢掉滚动位置，
    // 而人刚点完按钮时正看着那个位置。
    await refreshTodoSection();
  } catch (error) {
    toast(error.message, "bad");
  }
}

const SEVERITY_META = {
  block: { tone: "bad", dot: "var(--bad)" },
  warn: { tone: "warn", dot: "var(--warn)" },
  info: { tone: "info", dot: "var(--info)" },
};

function todoItemCard(item) {
  const meta = SEVERITY_META[item.severity] ?? SEVERITY_META.info;
  return el("div", { class: `todo todo--${meta.tone}`, dataset: { todoId: item.id } },
    el("span", { class: "todo__dot", style: `--c:${meta.dot}` }),
    el("div", { class: "todo__text" },
      el("div", { class: "todo__title", text: item.title }),
      el("div", { class: "todo__detail", text: item.detail }),
    ),
    el("button", {
      class: "btn btn--todo",
      type: "button",
      text: item.actionLabel,
      onclick: () => performTodoAction(item),
    }),
  );
}

/**
 * 待办分成两组，因为它们回答的是**两个不同的问题**：
 *
 *   `urgent`（block + warn）——「我现在必须做什么？」
 *   `later`  （info）       ——「哪天顺手可以清掉？」
 *
 * 混在一起会出现一种自相矛盾：顶上写着「一切正常」，底下却写着
 * 「12 件待处理」。那 12 件全是死信清理，一件都不紧急——
 * 系统健康与"有一堆可选家务"本来就可以同时成立，只是必须分开说。
 */
function splitTodo(data) {
  return {
    urgent: data.items.filter((item) => item.severity !== "info"),
    later: data.items.filter((item) => item.severity === "info"),
  };
}

/** 需要处理的那段：动作执行完后原地刷新它（不整页重渲染）。 */
async function refreshTodoSection() {
  const data = await api("/todo");
  const { urgent, later } = splitTodo(data);
  paintTodoSections(data, urgent, later);
}

function paintTodoSections(data, urgent, later) {
  const body = $("#todo-body");
  const heading = $("#todo-count");
  if (heading) {
    heading.textContent = urgent.length > 0
      ? `${urgent.length} 件需要处理`
      : "没有需要处理的";
  }
  if (body) {
    body.replaceChildren(
      urgent.length > 0
        ? urgent.map(todoItemCard)
        : [el("div", { class: "empty empty--good" },
            el("strong", { text: "没有需要你处理的事" }),
            "失败任务、积压和配置问题都没有。")],
    );
  }

  // 可选清理：整段重建（数量会变），没有就整段消失，不占版面。
  const existing = $("#later-section");
  if (existing) existing.remove();
  if (later.length > 0) {
    // 挂在待办那一段之后，与首次渲染的位置保持一致。
    const todoSection = $("#todo-section");
    todoSection?.after(renderLaterSection(later));
    syncLaterToggle();
  }
}

/**
 * 「顺手可以清掉」这一段的渲染。
 *
 * 12 条同构卡片平铺出来是一面墙：读的人要滚很久才知道其实只有一件事
 * （"有一堆死信"），而且每条的动作都一样。所以收敛成**一个决策 + 可展开的明细**：
 *
 *   ┌ 共 280 条重试用尽的任务，分布在 12 类   [展开] [全部清理] ┐
 *
 * 展开后仍是逐类的按钮——想挑一类清的人不用被"全部清理"绑着走。
 * 折叠状态跨刷新保留（否则点完清理、列表刷新，它自己又弹开了）。
 */
let laterExpanded = false;

function syncLaterToggle() {
  const toggle = $("#later-toggle");
  const body = $("#later-body");
  if (body) body.hidden = !laterExpanded;
  if (toggle) {
    toggle.textContent = laterExpanded ? "收起明细" : "展开明细";
    toggle.setAttribute("aria-expanded", String(laterExpanded));
  }
}

function renderLaterSection(later) {
  const total = later.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const section = el("section", { class: "section section--soft", id: "later-section" },
    el("h2", { class: "section__title" },
      el("span", { text: "顺手可以清掉" }),
      el("span", {
        class: "section__note",
        id: "later-count",
        text: `${later.length} 类 · ${formatCount(total)} 条 · 不紧急`,
      }),
    ),
    el("div", { class: "later-summary card" },
      el("div", { class: "later-summary__text" },
        el("div", { class: "later-summary__title", text: `${formatCount(total)} 条重试用尽的任务` }),
        el("div", {
          class: "later-summary__detail",
          text: `分布在 ${later.length} 类任务里。重试次数已用完，系统不会再碰它们——留着只占地方。`,
        }),
      ),
      el("div", { class: "later-summary__actions" },
        el("button", {
          class: "btn btn--ghost btn--sm", type: "button",
          id: "later-toggle",
          text: laterExpanded ? "收起明细" : "展开明细",
          "aria-expanded": String(laterExpanded),
          onclick: () => { laterExpanded = !laterExpanded; syncLaterToggle(); },
        }),
        el("button", {
          class: "btn btn--todo btn--sm", type: "button",
          text: "全部清理",
          onclick: () => purgeAllDead(later),
        }),
      ),
    ),
    el("div", { class: "todo-list todo-list--soft", id: "later-body", hidden: !laterExpanded },
      later.map(todoItemCard)),
  );
  return section;
}

/**
 * 一次性清理所有死信。
 *
 * 两条必须说清楚：
 *  1. **不可逆**——删除就是删除，面板不保留副本。
 *  2. **具体数量**——"280 条"和"一些"是完全不同的确认动作。
 *
 * 逐类顺序调用而不是并发：12 个 DELETE 并发打在同一条 jobs 表上没有收益，
 * 而顺序执行让失败中断在可预期的位置（已清的留下，没清的还在）。
 */
async function purgeAllDead(later) {
  const total = later.reduce((sum, item) => sum + (item.count ?? 0), 0);
  if (total === 0) return;

  const ok = await confirmDialog({
    title: "清理所有死信？",
    body: `${later.length} 类任务共 ${formatCount(total)} 条将被永久删除，不可恢复，失败原因也会一并消失。`,
    confirmLabel: `永久删除 ${formatCount(total)} 条`,
    tone: "danger",
  });
  if (!ok) return;

  let affected = 0;
  let failed = 0;
  for (const item of later) {
    if (item.action.kind !== "purge_dead") continue;
    try {
      const result = await api("/jobs/actions", {
        method: "POST",
        body: JSON.stringify({ jobType: item.action.jobType, action: "purge" }),
      });
      affected += result.affected ?? 0;
    } catch {
      // 一类失败不中断整体：其余的仍该被清掉。
      // 未清的那类会保留在清单里，刷新后看得见。
      failed += 1;
    }
  }

  toast(
    failed > 0
      ? `已清理 ${formatCount(affected)} 条，${failed} 类失败（看日志）`
      : `已清理 ${formatCount(affected)} 条`,
    failed > 0 ? "bad" : "ok",
  );
  // 清空后整段会消失；把展开态也复位，否则下次出现死信时会带着
  // 「展开中」的旧状态直接摊开。
  laterExpanded = false;
  await refreshTodoSection();
}

async function loadOverview() {
  const [data, series, todo, queues] = await Promise.all([
    api("/overview"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
    api("/todo").catch(() => ({ items: [], counts: { total: 0, block: 0, warn: 0, info: 0 } })),
    api("/queues").catch(() => null),
  ]);

  $("#env-badge").textContent = data.service.nodeEnv;
  const uptime = $("#uptime");
  if (uptime) uptime.textContent = `已运行 ${formatDuration(data.service.uptimeSeconds)}`;

  const points = series.points ?? [];
  const lastPoint = points.length ? points[points.length - 1] : null;
  const wrap = el("div", {});

  // ── 状态横幅：先回答"现在怎么样" ──
  const v = verdict({
    errorsPerMinute: lastPoint?.errorsPerMinute ?? null,
    queuePending: lastPoint?.queuePending ?? null,
    oldestPendingSeconds: queues?.totals.oldestPendingSeconds ?? null,
    lagSeconds: lastPoint?.eventLoopLagSeconds ?? null,
    requestsPerMinute: lastPoint?.requestsPerMinute ?? null,
    recentActivity: seriesValues(points, "requestsPerMinute").some((n) => typeof n === "number" && n > 0),
    blockingCount: todo.counts.block,
  });
  const blocking = todo.counts.block;
  wrap.append(
    el("div", { class: `verdict${v.tone ? ` verdict--${v.tone}` : ""}` },
      el("div", { class: "verdict__badge", text: v.icon }),
      el("div", { class: "verdict__text" },
        el("h2", { class: "verdict__title", text: v.title }),
        el("p", { class: "verdict__body", text: v.body }),
      ),
      el("div", { class: "verdict__actions" },
        el("button", { class: "btn btn--ghost", type: "button", text: "设置", onclick: () => switchView("config") }),
        el("button", { class: "btn btn--ghost", type: "button", text: "排查", onclick: () => switchView("logs") }),
      ),
    ),
  );

  // ── 待办：这一屏的纲 ──
  const { urgent, later } = splitTodo(todo);
  wrap.append(
    el("section", { class: "section section--first", id: "todo-section" },
      el("h2", { class: "section__title" },
        el("span", { text: blocking > 0 ? "有事需要你处理" : "需要你处理" }),
        el("span", {
          class: "section__note",
          id: "todo-count",
          text: urgent.length > 0 ? `${urgent.length} 件需要处理` : "没有需要处理的",
        }),
      ),
      el("div", { class: "todo-list", id: "todo-body" },
        urgent.length > 0
          ? urgent.map(todoItemCard)
          : [el("div", { class: "empty empty--good" },
              el("strong", { text: "没有需要你处理的事" }),
              "失败任务、积压和配置问题都没有。")],
      ),
    ),
  );

  // 可选清理：单独一段，没有就整段消失。
  if (later.length > 0) {
    wrap.append(renderLaterSection(later));
  }

  // ── 关键读数：支持信息，四张就够 ──
  const grid = el("div", { class: "grid grid--four" });
  const requestCard = stat("最近使用", formatRate(lastPoint?.requestsPerMinute ?? null), {
    hint: "每分钟有多少次操作打到服务", id: "ov-req",
  });
  attachSpark(requestCard, seriesValues(points, "requestsPerMinute"), SERIES_COLORS.requestsPerMinute);
  const errorCard = stat("报错", formatRate(lastPoint?.errorsPerMinute ?? null), {
    hint: "用户操作失败的频率", tone: lastPoint?.errorsPerMinute ? "alert" : "ok", id: "ov-err",
  });
  attachSpark(errorCard, seriesValues(points, "errorsPerMinute"), SERIES_COLORS.errorsPerMinute);
  const latencyCard = stat("响应耗时", formatLatency(lastPoint?.p95Seconds ?? null), {
    hint: "95% 的操作快于这个时间", tone: (lastPoint?.p95Seconds ?? 0) > 1 ? "warn" : "", id: "ov-lat",
  });
  attachSpark(latencyCard, seriesValues(points, "p95Seconds"), SERIES_COLORS.p95Seconds);
  const queueCard = stat("排队任务", queues ? formatCount(queues.totals.pending) : "—", {
    hint: queues && queues.totals.pending === 0 ? "队列是空的" : "排在后台等执行",
    tone: queues && queues.totals.pending > 20 ? "warn" : "", id: "ov-queue",
  });
  attachSpark(queueCard, seriesValues(points, "queuePending"), SERIES_COLORS.queuePending);
  grid.append(requestCard, errorCard, latencyCard, queueCard);
  wrap.append(el("div", { class: "section" },
    el("h2", { class: "section__title" }, "关键读数",
      el("span", { class: "section__note", text: "实时 · 走势在下面" })),
    grid));

  // ── 趋势 ──
  if (points.length >= 2) {
    const spanLabel = series.spanMs
      ? `最近 ${formatDuration(series.spanMs / 1000)}，每 ${Math.round(series.sampleIntervalMs / 1000)} 秒采一次`
      : null;
    const featured = series.series.filter((s) =>
      ["requestsPerMinute", "errorsPerMinute", "p95Seconds"].includes(s.key));
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "走势",
          el("span", { class: "section__note", text: spanLabel ?? "正在积累数据" })),
        el("div", { class: "grid grid--pair" },
          ...featured.map((meta) => chartCard({
            label: meta.label,
            hint: meta.hint,
            values: seriesValues(points, meta.key),
            color: SERIES_COLORS[meta.key],
            unit: meta.unit,
          })),
        ),
      ),
    );
  } else {
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "走势"),
        el("div", { class: "card" },
          el("div", { class: "empty" },
            el("strong", { text: "走势图正在积累数据" }),
            "面板每 15 秒采一次点，需要两三分钟才能画出有意义的曲线。上面的读数是实时的，不用等。",
          )),
      ),
    );
  }

  // ── 部署信息：压成一行键值 ──
  wrap.append(
    el("div", { class: "section" },
      el("h2", { class: "section__title" }, "部署"),
      el("div", { class: "card" },
        keyValues([
          ["运行环境", data.service.nodeEnv === "production" ? "正式" : "开发/测试"],
          ["已运行", formatDuration(data.service.uptimeSeconds)],
          ["配置文件", data.config.exists ? "已就位" : "未找到"],
          ["用户", queues ? formatNumber(queues.counts.usersTotal) : "—"],
          ["学习空间", queues ? formatNumber(queues.counts.workspacesTotal) : "—"],
          ["笔记", queues ? formatNumber(queues.counts.notesActive) : "—"],
          ["数据库连接", data.database.poolMax ? `上限 ${data.database.poolMax}` : "—"],
        ]),
      ),
    ),
  );

  return wrap;
}

/* ── 指标 ──────────────────────────────────────────────── */

async function loadMetrics() {
  const [data, series] = await Promise.all([
    api("/metrics"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
  ]);
  const points = series.points ?? [];
  const wrap = el("div", {});

  if (points.length >= 2) {
    const spanLabel = series.spanMs
      ? `最近 ${formatDuration(series.spanMs / 1000)} · 每 ${Math.round(series.sampleIntervalMs / 1000)} 秒采一次`
      : null;
    wrap.append(
      el("div", { class: "grid grid--pair" },
        ...series.series.map((meta) =>
          chartCard({
            label: meta.label,
            hint: meta.hint,
            values: seriesValues(points, meta.key),
            color: SERIES_COLORS[meta.key],
            unit: meta.unit,
            spanLabel,
          }),
        ),
      ),
    );
  } else {
    wrap.append(
      el("div", { class: "card" },
        el("div", { class: "empty" },
          el("strong", { text: "趋势图正在积累数据" }),
          "面板启动后每 15 秒采一个点。上面「全部指标」是即时值，可以先看那个。",
        ),
      ),
    );
  }

  wrap.append(
    el("div", { class: "section" },
      el("h2", { class: "section__title" }, "全部指标",
        el("span", { class: "section__note", text: "与 /metrics 同一份数据 · 展开看明细" })),
      el("div", { class: "grid grid--wide" },
        ...[...data.business, ...data.process].map((seriesItem) => {
          const card = el("details", { class: "card disclosure" });
          const summary = el("summary", {});
          summary.append(
            el("span", { text: seriesItem.label ?? seriesItem.name }),
            el("span", { class: "badge badge--mono", title: seriesItem.name, text: `${seriesItem.type} · ${seriesItem.samples.length}` }),
          );
          const body = el("div", { class: "disclosure__body" });
          body.append(el("p", { class: "stat__hint disclosure__help", text: seriesItem.help }));

          if (seriesItem.histograms?.length) {
            body.append(tableOf(
              ["标签", "条数", "p50", "p95", "溢出"],
              seriesItem.histograms.map((h) => [
                codeTag(Object.entries(h.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—"),
                formatCount(h.count),
                h.p50 === null ? "—" : `${(h.p50 * 1000).toFixed(1)} ms`,
                h.p95 === null ? "—" : `${(h.p95 * 1000).toFixed(1)} ms`,
                (h.overflowRatio ?? 0) > 0.001 ? formatPercent(h.overflowRatio) : "0%",
              ]),
              [2, 3, 4],
            ));
          } else {
            body.append(tableOf(
              ["标签", "值"],
              seriesItem.samples.slice(0, 30).map((s) => [
                codeTag(Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(" ") || "—"),
                formatNumber(s.value),
              ]),
              [1],
            ));
          }
          card.append(summary, body);
          return card;
        }),
      ),
    ),
  );

  return wrap;
}

/** 通用表格（表头 + 行数组，数字列右对齐）。 */
function tableOf(headers, rows, numericColumns = []) {
  return el("div", { class: "table__scroll" },
    el("table", {},
      el("thead", {}, el("tr", {}, ...headers.map((h, i) =>
        el("th", { class: numericColumns.includes(i) ? "num" : null, text: h })))),
      el("tbody", {}, ...rows.map((row) =>
        el("tr", {}, ...row.map((cell, i) =>
          el("td", { class: numericColumns.includes(i) ? "num" : null },
            cell instanceof Node ? cell : String(cell)))))),
    ),
  );
}

/* ── 日志 ──────────────────────────────────────────────── */

const LOG_LEVELS = [
  { value: "trace", label: "全部" },
  { value: "debug", label: "常规以上" },
  { value: "info", label: "记录以上" },
  { value: "warn", label: "警告以上" },
  { value: "error", label: "只有问题" },
];
let logLevel = "trace";

/**
 * Fastify 的自动请求日志（incoming request / request completed）由框架在每个
 * 请求上打两条，**带 `req` / `res` 字段**。
 *
 * 不做处理的话它们会占满整个窗口——实测一个只有几十次请求的进程，缓冲里几乎
 * 全是这两条，真正的应用日志（错误、清理计数）被挤出去。所以默认排除，并给一个
 * 说清自己在做什么的开关，而不是悄悄丢数据。
 */
function isFrameworkRequestLog(entry) {
  return Boolean(entry.fields && (entry.fields.req !== undefined || entry.fields.res !== undefined));
}

let showRequestLogs = false;

/**
 * 日志文本搜索。
 *
 * 只按级别筛是不够的：排查时人手里的线索是**一个词**（runId、模块名、
 * 某句报错），不是"我要看所有 warn"。
 *
 * 两处刻意的设计：
 *  - **搜索时把取回条数提到缓冲上限**（500）。只在最近 200 条里搜，
 *    结果会随着"新日志盖上来"而凭空消失——那比搜不到更让人困惑。
 *  - **输入时只重绘流，不重绘输入框本身**。否则每敲一个字符焦点就没了，
 *    连续输入会断在第一下。
 */
let logSearch = "";

/** 一条日志是否匹配关键词（同时看消息与字段值）。 */
function logMatches(entry, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (entry.msg.toLowerCase().includes(needle)) return true;
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (key.toLowerCase().includes(needle)) return true;
    if (String(value).toLowerCase().includes(needle)) return true;
  }
  return false;
}

async function loadLogs() {
  const wrap = el("div", {});
  const chips = el("div", { class: "chips" });
  const matchNote = el("span", { class: "section__note", id: "log-match" });
  const toolbar = el("div", { class: "logs-toolbar" }, chips, matchNote);

  const renderChips = () => {
    chips.replaceChildren(
      ...LOG_LEVELS.map((level) =>
        el("button", {
          class: "chip", type: "button",
          "aria-pressed": level.value === logLevel ? "true" : "false",
          text: level.label,
          onclick: () => { logLevel = level.value; renderChips(); refresh(); },
        }),
      ),
      el("button", {
        class: "chip", type: "button",
        "aria-pressed": showRequestLogs ? "true" : "false",
        text: "含请求日志",
        onclick: () => { showRequestLogs = !showRequestLogs; renderChips(); refresh(); },
      }),
    );
  };
  renderChips();
  wrap.append(toolbar);

  // 搜索框与流分开：重绘流时输入框不重建，焦点与光标位置得以保留。
  const search = el("input", {
    class: "field__input logs-search",
    type: "search",
    placeholder: "搜消息、字段值，比如 runId 或报错关键词",
    value: logSearch,
    "aria-label": "搜索日志",
  });
  let searchTimer = null;
  search.addEventListener("input", () => {
    logSearch = search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 220);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      logSearch = "";
      refresh();
      event.preventDefault();
    }
  });
  wrap.append(search);

  const stream = el("div", { class: "logs scroller u-mt-12" });
  wrap.append(stream);

  async function refresh() {
    try {
      // 搜索时取满缓冲：关键词命中的可能是第 480 条，而不是最近 200 条。
      const limit = logSearch.trim() ? 500 : 200;
      const data = await api(`/logs?level=${encodeURIComponent(logLevel)}&limit=${limit}`);
      const base = showRequestLogs ? data.entries : data.entries.filter((e) => !isFrameworkRequestLog(e));
      const entries = base.filter((entry) => logMatches(entry, logSearch.trim()));

      if (matchNote) {
        matchNote.textContent = logSearch.trim()
          ? `匹配 ${entries.length} 条 · 在最近 ${base.length} 条里搜`
          : `${entries.length} 条`;
      }

      if (entries.length === 0) {
        stream.replaceChildren(
          el("div", { class: "empty" },
            el("strong", {
              text: logSearch.trim() ? `没有匹配「${logSearch.trim()}」的日志` : "这个级别还没有日志",
            }),
            logSearch.trim()
              ? "关键词在消息与字段值里都不匹配。可以放宽级别筛选，或清空搜索框（Esc）。"
              : base.length
                ? `已排除 ${base.length} 条框架请求日志。点「含请求日志」把它们放回来。`
                : `换一个更低的级别试试。缓冲区只保留最近 ${data.capacity} 条，重启即清空。`,
          ),
        );
        return;
      }

      stream.replaceChildren(
        ...entries.map((entry) =>
          el("div", { class: "log" },
            el("div", { class: "log__time", text: formatTime(entry.time) }),
            el("div", { class: "log__level", dataset: { level: entry.level }, text: entry.level }),
            el("div", { class: "log__body" },
              el("div", { class: "log__msg", text: entry.msg }),
              Object.keys(entry.fields).length
                ? el("div", { class: "log__fields" },
                    ...Object.entries(entry.fields).flatMap(([key, value], index) => [
                      index > 0 ? " " : null,
                      el("b", { text: `${key}=` }),
                      String(value),
                    ]),
                  )
                : null,
            ),
          ),
        ),
      );
      // 日志页自己轮询：这是唯一一个"新数据在原地出现"比"手动刷新"更合适的视图。
      clearInterval(pollTimer);
      pollTimer = setInterval(refresh, 5000);
    } catch (error) {
      if (error.message !== "unauthorized") setConnection("error", "出错");
    }
  }

  await refresh();
  return wrap;
}

/* ── 队列 ──────────────────────────────────────────────── */

async function loadQueues() {
  const data = await api("/queues");
  const t = data.totals;
  const wrap = el("div", {});

  const grid = el("div", { class: "grid" });
  grid.append(
    stat("等待中", formatCount(t.pending), {
      hint: t.pending === 0 ? "队列是空的" : "排在后台等着执行",
      tone: t.pending > 20 ? "warn" : "",
      id: "q-pending",
    }),
    stat("正在做", formatCount(t.running), { hint: "此刻正在后台跑的任务", id: "q-running" }),
    stat("最近失败", formatCount(t.failedRecent), {
      hint: "24 小时内失败过的任务",
      tone: t.failedRecent > 0 ? "warn" : "ok",
      id: "q-failed",
    }),
    stat("彻底停了", formatCount(t.deadTotal), {
      hint: "重试用尽、需要人工看一眼",
      tone: t.deadTotal > 0 ? "alert" : "ok",
      id: "q-dead",
    }),
    stat("最久等待", t.oldestPendingSeconds > 0 ? formatDuration(t.oldestPendingSeconds) : "—", {
      // 没有 pending 时显示 "<1 秒" 是误导：读起来像"刚排进来"，
      // 实际是"队列里根本没有在等的东西"。
      tone: t.oldestPendingSeconds > 900 ? "warn" : "",
      hint: t.pending > 0 ? "排最久的那个已经等了多久" : "当前没有等待中的任务",
      id: "q-oldest",
    }),
  );
  wrap.append(grid);

  if (data.byType.length > 0) {
    const segments = [
      { label: "等待中", value: t.pending, color: "var(--info)" },
      { label: "正在做", value: t.running, color: "var(--accent)" },
      { label: "最近失败", value: t.failedRecent, color: "var(--warn)" },
      { label: "彻底停了", value: t.deadTotal, color: "var(--bad)" },
    ];
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "后台都在做什么",
          el("span", { class: "section__note", text: `${data.byType.length} 类任务` })),
        el("div", { class: "card" },
          stackedBar({ segments }),
          el("div", { class: "legend" },
            ...segments.map((s) =>
              el("span", { class: "legend__item" },
                el("span", { class: "legend__dot", style: `--c:${s.color}` }),
                `${s.label} ${formatCount(s.value)}`,
              ),
            ),
          ),
        ),
        el("div", { class: "table u-mt-14" },
          tableOf(
            ["任务", "等待", "在做", "失败", "停了", "最久等待"],
            data.byType.map((row) => [
              // 人话是主标题；没有收录的任务类型退回标识（而不是猜一个意思）。
              row.label,
              formatCount(row.pending),
              formatCount(row.running),
              formatCount(row.failedRecent),
              formatCount(row.deadTotal),
              row.oldestPendingSeconds > 0 ? formatDuration(row.oldestPendingSeconds) : "—",
            ]),
            [1, 2, 3, 4, 5],
          ),
        ),
      ),
    );
  }

  if (data.recentFailures.length > 0) {
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "没能做完的事",
          el("span", { class: "section__note", text: "错误已脱敏，只显示可安全展示的原因" })),
        el("div", { class: "table" },
          tableOf(
            ["任务", "结果", "重试", "原因", "什么时候"],
            data.recentFailures.map((row) => [
              row.label,
              el("span", { class: `badge ${row.status === "dead" ? "badge--bad" : "badge--warn"}`, text: row.statusLabel }),
              `${row.attempts} 次`,
              row.failure.summary,
              formatDateTime(row.finishedAt ?? row.scheduledAt),
            ]),
            [2],
          ),
        ),
      ),
    );
  }

  const audit = await api("/audit?limit=40").catch(() => ({ entries: [] }));
  if (audit.entries.length > 0) {
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "有人做了重要操作",
          el("span", { class: "section__note", text: "导出、删除、移除成员这类动作" })),
        el("div", { class: "table" },
          tableOf(
            ["做了什么", "对象", "什么时候"],
            audit.entries.map((row) => [
              row.label,
              `${row.targetLabel}`,
              formatDateTime(row.createdAt),
            ]),
          ),
        ),
      ),
    );
  }

  return wrap;
}

/* ── 配置 ────────────────────────────────────────────────
   这一页是**只读的**，而且把"只读"说在明面上。

   为什么不给写入：compose 把 ./config 以 :ro 挂进容器，按默认部署
   一定写不进去。与其摆一个永远灰着的保存按钮（那是假功能），
   不如把这页做成「看清 + 导出 + 明确告诉你去哪改」。

   读取端的写能力（PUT /admin/api/config）仍然保留并有测试覆盖——
   部署方把挂载改成可写后，服务端是就绪的，只是界面目前不提供入口。 */

/** 把配置导出成 JSON 文件。 */
async function exportConfig(snapshot) {
  // 序列化时重新构造，只保留**结构**：apiKey 已经是 ${ENV} 引用，
  // 明文密钥（如果有人写死在文件里）服务端在读取时就没吐出来，
  // 这里自然也不会带上。
  const payload = {
    platforms: Object.fromEntries(
      (snapshot.platforms ?? []).map((p) => [
        p.id,
        {
          type: p.type,
          ...(p.apiKey.mode === "env-ref" ? { apiKey: `\${${p.apiKey.envVar}}` } : {}),
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        },
      ]),
    ),
    capabilities: Object.fromEntries(
      (snapshot.capabilities ?? []).map((c) => [c.capability, { platform: c.platform, model: c.model }]),
    ),
    ...(snapshot.tts ? { tts: snapshot.tts } : {}),
  };

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: "ai-platforms.json" });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast("已导出 ai-platforms.json");
  } catch {
    // 兜底：下载被 CSP 或环境挡住时，至少能复制到剪贴板。
    // 这条不是"顺便加的"——一个导不出去的导出按钮比没有更让人困惑。
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板");
    } catch {
      toast("导出失败：浏览器既不给下载也不给剪贴板", "bad");
    }
  }
}

async function loadConfig() {
  const [snapshot, overview] = await Promise.all([
    api("/config"),
    api("/overview").catch(() => null),
  ]);
  const wrap = el("div", {});

  // ── 变更说明：先说清楚"这页能不能改、要改去哪改" ──
  wrap.append(
    el("div", { class: `banner banner--${snapshot.writable ? "info" : "warn"}` },
      el("span", { class: "banner__icon", text: snapshot.writable ? "i" : "!" }),
      el("span", {},
        snapshot.writable
          ? "本部署的配置目录可写，但面板当前只提供查看与导出。要改配置，直接编辑下面的文件并重启服务。"
          : `面板只能看，不能写。要改配置：编辑 ${snapshot.path}，然后重启服务。`,
      ),
    ),
  );

  // ── 能力开关：从概览移过来 ──
  // 它们由环境变量决定，本来就属于"配置"这一格；留在概览只是把首屏撑满了。
  if (overview?.capabilities?.length) {
    wrap.append(
      el("div", { class: "section section--first" },
        el("h2", { class: "section__title" }, "现在能用哪些功能",
          el("span", { class: "readonly-note", text: "改这个要改环境变量并重启" })),
        el("div", { class: "grid grid--wide" },
          ...overview.capabilities.map((capability) =>
            el("div", { class: "card" },
              el("div", { class: "stat__label" },
                el("span", { text: capability.label }),
                el("span", {
                  class: `badge ${capability.enabled ? "badge--on" : "badge--off"}`,
                  text: capability.enabled ? "可用" : "未启用",
                }),
              ),
              el("div", { class: "stat__hint", text: capability.detail }),
              codeTag(capability.key),
            ),
          ),
        ),
      ),
    );
  }

  // ── 配置问题：先于配置内容出现（有问题就该先看问题）──
  if (snapshot.issues.length > 0) {
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "配置有问题",
          el("span", { class: "section__note", text: `${snapshot.issues.length} 处` })),
        el("ul", { class: "issue-list" },
          ...snapshot.issues.map((issue) =>
            el("li", { class: "issue", dataset: { blocking: String(issue.blocking) } },
              codeTag(issue.path || "(root)"),
              el("span", { text: issue.message }),
            ),
          ),
        ),
      ),
    );
  }

  if (snapshot.unresolvedEnvRefs.length > 0) {
    wrap.append(
      el("div", { class: "banner banner--warn" },
        el("span", { class: "banner__icon", text: "!" }),
        el("span", {},
          `有 ${snapshot.unresolvedEnvRefs.length} 个密钥没配：`,
          snapshot.unresolvedEnvRefs.join("、"),
          "。这些模型服务现在用不了，调用会失败。",
        ),
      ),
    );
  }

  // ── 模型服务商 ──
  wrap.append(
    el("div", { class: "section" },
      el("h2", { class: "section__title" }, "模型服务商",
        el("span", { class: "readonly-note", text: `要改：编辑 ${snapshot.path}` })),
      ...snapshot.platforms.map((platform) =>
        el("div", { class: "card editor-row editor-row--readonly" },
          el("div", { class: "editor-row__id" },
            el("div", { class: "editor-row__name", text: platform.id }),
            el("div", { class: "editor-row__badges" },
              el("span", {
                class: `badge ${platform.apiKey.resolved ? "badge--on" : "badge--warn"}`,
                text: platform.apiKey.mode === "env-ref"
                  ? (platform.apiKey.resolved ? "密钥已就位" : "密钥没配")
                  : platform.apiKey.mode === "literal-redacted" ? "密钥写死在文件里" : "不需要密钥",
              }),
              el("span", { class: "badge badge--off", text: platform.type }),
            ),
            el("div", {
              class: "editor-row__note",
              text: platform.usedByCapabilities.length > 0
                ? `被 ${platform.usedByCapabilities.join("、")} 使用`
                : "目前没有任何功能用它",
            }),
          ),
          el("div", { class: "editor-row__fields" },
            el("div", { class: "field" },
              el("label", { class: "field__label", text: "接口地址" }),
              el("div", { class: "readonly-value", text: platform.baseUrl ?? "（未设置）" }),
            ),
            el("div", { class: "field" },
              el("label", { class: "field__label", text: "密钥来源" }),
              el("div", { class: "readonly-value", text:
                platform.apiKey.mode === "env-ref"
                  ? `${platform.apiKey.envVar}${platform.apiKey.resolved ? " · 已注入" : " · 未注入"}`
                  : platform.apiKey.mode === "literal-redacted" ? "写死在文件里（值不显示）" : "不需要" }),
            ),
            el("div", { class: "field" },
              el("label", { class: "field__label", text: "协议" }),
              el("div", { class: "readonly-value", text: platform.type }),
            ),
          ),
        ),
      ),
    ),
  );

  // ── 能力 → 模型 ──
  wrap.append(
    el("div", { class: "section" },
      el("h2", { class: "section__title" }, "每种功能用哪个模型",
        el("span", { class: "readonly-note", text: `要改：编辑 ${snapshot.path}` })),
      ...snapshot.capabilities.map((capability) =>
        el("div", { class: "card editor-row editor-row--readonly" },
          el("div", { class: "editor-row__id" },
            el("div", { class: "editor-row__name", text: capability.label ?? capability.capability }),
            el("div", { class: "editor-row__badges" },
              el("span", {
                class: `badge ${capability.resolvable ? "badge--on" : "badge--warn"}`,
                text: capability.resolvable ? "可用" : "会用兜底",
              }),
              codeTag(capability.capability),
            ),
            capability.problem
              ? el("div", { class: "editor-row__note", text: capability.problem })
              : null,
          ),
          el("div", { class: "editor-row__fields" },
            el("div", { class: "field" },
              el("label", { class: "field__label", text: "服务商" }),
              el("div", { class: "readonly-value", text: capability.platform }),
            ),
            el("div", { class: "field" },
              el("label", { class: "field__label", text: "模型" }),
              el("div", { class: "readonly-value readonly-value--mono", text: capability.model || "（未设置）" }),
            ),
          ),
        ),
      ),
    ),
  );

  if (snapshot.tts) {
    wrap.append(
      el("div", { class: "section" },
        el("h2", { class: "section__title" }, "语音合成",
          el("span", { class: "readonly-note", text: `要改：编辑 ${snapshot.path}` })),
        el("div", { class: "card" },
          el("pre", { class: "mono u-m-0 u-wrap", text: JSON.stringify(snapshot.tts, null, 2) }),
        ),
      ),
    );
  }

  // ── 导出：这页唯一能做的动作 ──
  const exportButton = el("button", { class: "btn btn--primary", type: "button" }, "导出配置 JSON");
  exportButton.addEventListener("click", () => exportConfig(snapshot));

  wrap.append(
    el("div", { class: "actions" },
      exportButton,
      el("button", {
        class: "btn btn--ghost", type: "button", text: "重新读取",
        onclick: () => { cache.delete("config"); switchView("config", { force: true }); },
      }),
      el("span", { class: "readonly-value readonly-value--path", text: snapshot.path }),
    ),
  );

  return wrap;
}

/* ── 闸与启动 ──────────────────────────────────────────── */

function lockGate(message) {
  token = null;
  cache.clear();
  clearInterval(pollTimer);
  const gate = $("#gate");
  const shell = $("#shell");
  shell.hidden = true;
  gate.hidden = false;
  gate.dataset.state = "locked";
  // 重新显示时动画要能重播：先回到起点再释放。
  gate.style.removeProperty("animation");
  if (message) {
    const error = $("#gate-error");
    error.textContent = message;
    error.hidden = false;
    void error.offsetWidth;
  }
}

async function unlockGate(candidate) {
  const previous = token;
  token = candidate;
  try {
    // 先打一次真请求再揭幕：这样「令牌错了」发生在闸还开着的时候，
    // 用户不会先看到面板骨架再被弹回来。
    await api("/overview");
  } catch {
    token = previous;
    return false;
  }
  const gate = $("#gate");
  const shell = $("#shell");
  gate.dataset.state = "unlocked";
  shell.hidden = false;
  $("#gate-error").hidden = true;

  updateRailIndicator(true);
  await switchView("overview", { force: true });

  setTimeout(() => {
    gate.hidden = true;
  }, 460);
  return true;
}

function bindEvents() {
  $("#gate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#gate-token");
    const submit = $("#gate-submit");
    const error = $("#gate-error");
    const candidate = input.value.trim();
    if (!candidate) return;

    submit.disabled = true;
    error.hidden = true;
    const ok = await unlockGate(candidate);
    submit.disabled = false;
    if (ok) {
      input.value = "";
    } else {
      error.textContent = "令牌不正确，或该部署未启用运维面板。";
      error.hidden = false;
      void error.offsetWidth;
      input.select();
    }
  });

  $$(".rail__item").forEach((item) => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  $("#refresh").addEventListener("click", async () => {
    const button = $("#refresh");
    button.classList.add("is-busy");
    cache.delete(currentView);
    await switchView(currentView, { force: true });
    button.classList.remove("is-busy");
  });

  $("#lock").addEventListener("click", () => lockGate(null));

  // 键盘：数字键快速切换视图，和导航栏的顺序一致。
  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea")) return;
    if ($("#shell").hidden) return;
    const views = Object.keys(VIEWS);
    const index = Number(event.key) - 1;
    if (index >= 0 && index < views.length) switchView(views[index]);
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    // 指示器跟随的是导航项的实际几何，缩放后必须重算而不是等下一次点击。
    resizeTimer = setTimeout(() => updateRailIndicator(true), 90);
  });
}

bindEvents();
updateRailIndicator(true);