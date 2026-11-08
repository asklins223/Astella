/* ============================================================
   视图 · 日志（级别构成条 + 填满视口的终端）
   ------------------------------------------------------------
   这一版只改**结构与表达**，不改视觉语言：仍是一张玻璃卡 + 发丝线，
   配色只沿用既有 token，没有新增彩色边条、没有新的标题样式。

   改了什么：
     · 左栏「全部 / 常规以上 / … / 只有问题」五行文字 + 计数，本质是
       同一条分布被拆成 5 份。现在换成一条**级别构成条**：色块宽度 =
       当前窗口里各级别的真实条数；点某一段 = 按该级别**及以上**筛选
       （点 warn = 警告以上），语义与原左栏完全一致。点已选中的段
       或「查看全部」回到全部。
     · 访问日志同样换成状态码构成条（2xx/3xx/4xx/5xx），点 4xx = 只看
       失败（沿用既有「失败 = ≥400」语义），点 5xx = 只看服务端错误。
     · 终端用运行时几何撑满视口：旧版 `.term__body` 的 65vh/430px 上限
       让页面下方整片留白；现在按窗口高度算一次，铺到页脚之上。
     · 每条日志 / 每个请求行都可点开抽屉：时间、级别、消息全文、全部
       fields（键值表，长值换行）与原始形状摘要。

   没改什么：
     · **暂停语义原样保留**：暂停时画面冻住，只更新计数（构成条与计数
       仍更新，流不重绘）。
     · SSE 订阅（ctx.onLogEvent / ctx.onRequestEvent）与 ctx.onCleanup 清理。
     · 过滤状态仍是模块级 state，45 秒自动刷新后不重置。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatCount, formatDateTime, formatMs, formatTime } from "../format.js";
import { el, emptyState, ICONS, icon, openDrawer, drawerFacts, drawerSection } from "../ui.js";
import { compositionBar } from "./shared.js";

export const view = {
  title: "日志", eyebrow: "LIVE OBSERVATIONS",
  lede: "实时追踪应用与请求，快速筛出值得关注的事件。",
  fill: true,
  load: loadLogs,
};

const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 };

/**
 * 级别 → 颜色与文案。
 *
 * 这里用**同一色相族的严重度阶梯**（灰 → 蓝 → 琥珀 → 红），不是彩虹：
 * 读者一眼要回答的是"警告/错误占比多大"，色相在这里带含义。
 * info 用强调蓝（终端里 info 也是蓝），错误用 --bad，致命再深一档。
 */
const LEVEL_META = {
  trace: { label: "trace", hint: "跟踪", color: "var(--ink-4)" },
  debug: { label: "debug", hint: "调试", color: "var(--series-8)" },
  info: { label: "info", hint: "记录", color: "var(--series-1)" },
  warn: { label: "warn", hint: "警告", color: "var(--warn)" },
  error: { label: "error", hint: "错误", color: "var(--bad)" },
  fatal: { label: "fatal", hint: "致命", color: "#8c1f2b" },
  silent: { label: "silent", hint: "静默", color: "var(--ink-3)" },
};

/** 原左栏的五档阈值：构成条点选后等价于这里的档位。 */
const LEVEL_THRESHOLDS = {
  trace: "全部",
  debug: "常规以上",
  info: "记录以上",
  warn: "警告以上",
  error: "只有问题",
  fatal: "只有致命",
  silent: "只有静默",
};

const STATUS_BANDS = [
  { key: "2xx", label: "2xx 成功", color: "var(--ok)" },
  { key: "3xx", label: "3xx 跳转", color: "var(--series-6)" },
  { key: "4xx", label: "4xx 请求错误", color: "var(--warn)" },
  { key: "5xx", label: "5xx 服务端错误", color: "var(--bad)" },
  { key: "other", label: "无状态码", color: "var(--ink-4)" },
];

/** 视图内保留的过滤状态：切走再切回来时不清空（运维正在排查的上下文）。 */
const state = {
  mode: "app", // "app" | "requests"
  level: "trace", // 阈值：点 warn = warn 及以上
  search: "",
  paused: false,
  requestSearch: "",
  statusBand: null, // null = 全部请求
};

/** 服务端已把对象压成形状摘要；这里把它说成人话。 */
function fieldValueText(value) {
  if (value === null) return "null";
  if (typeof value === "object") {
    if (value.__type === "array") return `array(${value.length})`;
    if (typeof value.__type === "string") return value.__type;
    return "object";
  }
  return String(value);
}

function levelAtLeast(entryLevel, minLevel) {
  return (LEVEL_ORDER[entryLevel] ?? 0) >= (LEVEL_ORDER[minLevel] ?? 0);
}

function matchesSearch(entry, needle) {
  if (!needle) return true;
  const query = needle.toLowerCase();
  if (entry.msg.toLowerCase().includes(query)) return true;
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (key.toLowerCase().includes(query)) return true;
    if (fieldValueText(value).toLowerCase().includes(query)) return true;
  }
  return false;
}

function bandOf(entry) {
  const status = entry.fields?.statusCode;
  if (typeof status !== "number") return "other";
  return `${Math.floor(status / 100)}xx`;
}

/**
 * 状态码分段语义（沿用旧左栏的「只看失败 = ≥400」）：
 *   4xx 段 → ≥400（客户端 + 服务端错误都算失败）；5xx 段 → ≥500。
 */
function matchesBand(entry, band) {
  if (!band) return true;
  const status = entry.fields?.statusCode;
  if (band === "4xx") return typeof status === "number" && status >= 400;
  if (band === "5xx") return typeof status === "number" && status >= 500;
  return bandOf(entry) === band;
}

/** 让一行「可点开抽屉」但保留终端行的排版：div 比 button 少一套需要覆盖的 UA 样式。 */
function clickableRow(node, onActivate, label) {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", label);
  node.style.cursor = "pointer";
  node.addEventListener("click", onActivate);
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate();
  });
  node.addEventListener("focus", () => { node.style.boxShadow = "inset 0 0 0 2px rgba(0,113,227,.45)"; });
  node.addEventListener("blur", () => { node.style.boxShadow = ""; });
  return node;
}

function logRow(entry, { isNew = false } = {}) {
  const node = el("div", { class: `log${isNew ? " log--new" : ""}`, dataset: { seq: entry.seq } },
    el("div", { class: "log__time", text: formatTime(entry.time) }),
    el("div", { class: "log__level", dataset: { level: entry.level }, text: entry.level }),
    el("div", { class: "log__body" },
      el("div", { class: "log__msg", text: entry.msg }),
    ),
  );
  return clickableRow(node, () => openLogDrawer(entry), `${entry.level} ${entry.msg}，打开详情`);
}

function requestRow(entry) {
  const status = entry.fields.statusCode;
  const tone = typeof status === "number" && status >= 500 ? "bad" : typeof status === "number" && status >= 400 ? "warn" : "ok";
  const node = el("div", { class: "req-row" },
    el("div", { class: "req-row__path", text: `${entry.fields.method ?? "?"} ${entry.fields.url ?? ""}` }),
    el("div", { class: `req-row__status req-row__status--${tone}`, text: String(status ?? "—") }),
    el("div", { class: "req-row__ms", text: formatMs(entry.fields.durationMs) }),
    el("div", { class: "req-row__ago", title: formatTime(entry.time), text: formatAgo(entry.time) }),
  );
  return clickableRow(node, () => openRequestDrawer(entry), `${entry.fields.method ?? ""} ${entry.fields.url ?? ""} 状态 ${status ?? "未知"}，打开详情`);
}

/** 应用日志抽屉：时间 / 级别 / 消息全文 / 所有字段 / 原始形状摘要。 */
function openLogDrawer(entry) {
  const fields = Object.entries(entry.fields ?? {});
  const time = formatDateTime(entry.time);
  openDrawer({
    title: entry.msg,
    eyebrow: `应用日志 · ${entry.level.toUpperCase()}`,
    sub: `${time} · 序号 ${entry.seq}`,
    body: [
      drawerFacts([
        ["级别", entry.level.toUpperCase(), { mono: true }],
        ["时间", time],
        ["序号", String(entry.seq), { mono: true }],
        ["附带字段", `${fields.length} 个`],
      ]),
      fields.length
        ? drawerSection("字段", "服务端把对象压成形状摘要", drawerFacts(
            fields.map(([key, value]) => [key, fieldValueText(value), { mono: true }]),
          ))
        : drawerSection("字段", null,
            el("p", { class: "dim", style: "margin:0;font-size:12px", text: "这条日志没有附带字段。" })),
      drawerSection("原始形状", "排查时可以整段贴给服务端同学",
        el("pre", { class: "log-tail", text: JSON.stringify(entry.fields ?? {}, null, 2) })),
    ],
  });
}

/** 访问日志抽屉：方法 / 路径 / 状态 / 耗时 / 时间 / 请求 id。 */
function openRequestDrawer(entry) {
  const fields = entry.fields ?? {};
  const time = formatDateTime(entry.time);
  openDrawer({
    title: `${fields.method ?? "?"} ${fields.url ?? ""}`,
    eyebrow: "访问日志",
    sub: `${time} · ${formatMs(fields.durationMs)}`,
    body: [
      drawerFacts([
        ["状态码", String(fields.statusCode ?? "—"), { mono: true }],
        ["耗时", formatMs(fields.durationMs)],
        ["请求 ID", String(fields.reqId ?? "—"), { mono: true }],
        ["时间", time],
        ["序号", String(entry.seq), { mono: true }],
      ]),
      drawerSection("原始形状", null,
        el("pre", { class: "log-tail", text: JSON.stringify(fields, null, 2) })),
    ],
  });
}

async function loadLogs(ctx) {
  /* ── 工具条：模式 + 搜索 + 暂停 ── */
  const modeTabs = el("div", { class: "seg", role: "group", "aria-label": "日志流" });
  const searchInput = el("input", {
    class: "field__input", type: "search", "aria-label": "搜索日志",
    style: "flex:1;min-width:160px",
  });
  const pauseButton = el("button", { class: "btn btn--sm", type: "button" });
  // 只在"画面与计数不一致"时才出现的旁注：暂停、有未显示的新日志、筛选后只显示一部分。
  const countNote = el("span", { class: "queue-tools__note", hidden: true });

  const tools = el("div", { class: "queue-tools", style: "margin:0 0 12px" },
    modeTabs,
    el("div", { class: "queue-tools__search" }, searchInput),
    pauseButton,
    countNote,
  );

  /* ── 级别 / 状态码构成条（本页的核心可视化）──
     读数与筛选说明都并进了工具条右侧的旁注：日志页的主角是终端，
     统计区只保留一条可点的构成条 + 一行图例，不再用大号数字占一层楼。 */
  const distSlot = el("div", {});
  const card = el("section", { class: "section log-summary", style: "margin-top:0;padding:12px 20px 10px" },
    tools, distSlot);

  /* ── 终端：由 .view--fill 的 flex 链撑满（styles.css 里已有规则），
     这里只把两个容器接进那条链：wrap 占满 page-body，term 占满 wrap 的余量。 ── */
  const body = el("div", { class: "term__body" });
  const term = el("div", { class: "term" }, body);
  // flex 布局由 `.view--fill .page-body > div` 提供，这里只补一个间距。
  const wrap = el("div", { style: "gap:14px" }, card, term);

  /* ── 两条流的数据窗口 ── */
  let appEntries = [];
  let appCapacity = 500;
  let requests = [];
  let requestCapacity = 300;

  /* ── 构成条状态 ── */
  let syncing = false; // 程序化同步选中态时，忽略 onLocate 回调

  function renderModeTabs() {
    modeTabs.replaceChildren(
      ...[["app", "应用日志"], ["requests", "访问日志"]].map(([value, label]) =>
        el("button", {
          class: "seg__item", type: "button",
          "aria-pressed": state.mode === value ? "true" : "false",
          text: label,
          onclick: () => {
            if (state.mode === value) return;
            state.mode = value;
            renderModeTabs();
            renderToolbar();
            paintDistribution();
            renderStream();
          },
        })),
    );
  }

  function renderToolbar() {
    if (state.mode === "app") {
      searchInput.placeholder = "搜消息、字段值，比如 runId 或报错关键词";
      searchInput.value = state.search;
      pauseButton.hidden = false;
    } else {
      searchInput.placeholder = "搜路径，比如 /v2/home";
      searchInput.value = state.requestSearch;
      pauseButton.hidden = true;
    }
  }

  function paintPauseButton() {
    pauseButton.setAttribute("aria-pressed", String(state.paused));
    pauseButton.replaceChildren(
      icon(state.paused ? ICONS.play : ICONS.pause, { size: 12 }),
      el("span", { text: state.paused ? "继续" : "暂停" }),
    );
  }

  /** 旁注只在有话说时出现（暂停 / 命中 / 未显示的新日志），空字符串就隐藏。 */
  function setNote(text) {
    countNote.textContent = text;
    countNote.hidden = !text;
  }

  /* ── 筛选动作：构成条点选 → 阈值/分段 ── */
  function clearFilter() {
    if (state.mode === "app") {
      if (state.level === "trace") return;
      state.level = "trace";
    } else {
      if (state.statusBand === null) return;
      state.statusBand = null;
    }
    paintDistribution();
    renderStream();
  }

  function paintSummary({ total, unit, activeLabel = "", activeCount = 0 }) {
    const filter = activeLabel
      ? ` · 当前筛选「${activeLabel}」${formatCount(activeCount)} 条 · 点已选中色段取消`
      : "";
    setNote(`${formatCount(total)} ${unit}${filter}`);
  }

  function paintEmpty(note) {
    setNote(note);
    distSlot.replaceChildren();
  }

  /**
   * 应用日志：级别构成条。
   *
   * 色块宽度 = 当前窗口里该级别的真实条数；点击 = 该级别**及以上**，
   * 与原左栏「警告以上」这类阈值一一对应（见 LEVEL_THRESHOLDS）。
   */
  function paintAppDistribution() {
    if (appEntries.length === 0) {
      paintEmpty("0 条日志 · SSE 连上后新日志会实时进入这里");
      return;
    }
    const tally = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0, silent: 0 };
    for (const entry of appEntries) tally[entry.level] = (tally[entry.level] ?? 0) + 1;
    const total = appEntries.length;
    const atLeast = (level) => Object.entries(tally)
      .reduce((sum, [name, count]) => sum + ((LEVEL_ORDER[name] ?? 0) >= (LEVEL_ORDER[level] ?? 0) ? count : 0), 0);

    const items = Object.keys(LEVEL_META)
      .filter((level) => tally[level] > 0)
      .map((level) => ({
        key: level,
        label: `${LEVEL_META[level].label} ${LEVEL_META[level].hint}`,
        value: tally[level],
        color: LEVEL_META[level].color,
        hint: `按「${LEVEL_THRESHOLDS[level]}」筛选（${formatCount(atLeast(level))} 条）`,
      }));

    paintSummary({
      total,
      unit: `条日志 · 缓冲 ${appEntries.length}/${appCapacity}${state.paused ? " · 画面已暂停，计数仍在更新" : ""}`,
      activeLabel: state.level === "trace" ? "" : LEVEL_THRESHOLDS[state.level],
      activeCount: atLeast(state.level),
      hint: "点色段 = 该级别及以上",
    });

    const comp = compositionBar({
      items,
      ariaLabel: `当前窗口 ${formatCount(total)} 条日志的级别构成`,
      locatable: true,
      onLocate: (key) => {
        if (syncing) return;
        // null = 用户点击已选中段（取消）；否则按该级别及以上筛选
        const next = key && key !== "__rest__" ? key : "trace";
        if (next === state.level) { paintDistribution(); return; }
        state.level = next;
        paintDistribution();
        renderStream();
      },
    });
    comp.node.lastElementChild.append(el("span", { class: "dist__note", style: "margin-left:auto", text: "点色段 = 该级别及以上" }));
    distSlot.replaceChildren(comp.node);
    if (state.level !== "trace") {
      syncing = true;
      try {
        const index = comp.head.findIndex((item) => item.key === state.level);
        if (index >= 0) comp.node.querySelectorAll(".dist__seg")[index]?.click();
      } finally { syncing = false; }
    }
  }

  /** 访问日志：状态码构成条。点 4xx = 只看失败（≥400），点 5xx = 只看服务端错误。 */
  function paintRequestDistribution() {
    if (requests.length === 0) {
      paintEmpty("0 条已完成请求 · 请求完成后会实时出现在这里");
      return;
    }
    const counts = Object.fromEntries(STATUS_BANDS.map((band) => [band.key, 0]));
    for (const entry of requests) counts[bandOf(entry)] += 1;
    const total = requests.length;
    const activeCount = state.statusBand
      ? requests.filter((entry) => matchesBand(entry, state.statusBand)).length
      : total;

    paintSummary({
      total,
      unit: `条已完成请求 · 缓冲 ${requests.length}/${requestCapacity}`,
      activeLabel: state.statusBand
        ? `${state.statusBand === "4xx" ? "失败（4xx 及 5xx）" : state.statusBand}`
        : "",
      activeCount,
      hint: "点色段 = 只看这类响应",
    });

    const items = STATUS_BANDS
      .filter((band) => counts[band.key] > 0)
      .map((band) => ({
        key: band.key,
        label: band.label,
        value: counts[band.key],
        color: band.color,
        hint: band.key === "4xx" ? `只看失败（4xx + 5xx，${formatCount(activeCount >= 0 ? requests.filter((e) => matchesBand(e, "4xx")).length : 0)} 条）`
          : band.key === "5xx" ? `只看服务端错误（${formatCount(requests.filter((e) => matchesBand(e, "5xx")).length)} 条）`
            : `只看 ${band.label}`,
      }));

    const comp = compositionBar({
      items,
      ariaLabel: `当前窗口 ${formatCount(total)} 条请求的状态码构成`,
      onLocate: (key) => {
        if (syncing) return;
        const next = key && key !== "__rest__" ? key : null;
        if (next === state.statusBand) { paintDistribution(); return; }
        state.statusBand = next;
        paintDistribution();
        renderStream();
      },
    });
    comp.node.lastElementChild.append(el("span", { class: "dist__note", style: "margin-left:auto", text: "点色段 = 只看这类响应" }));
    distSlot.replaceChildren(comp.node);
    if (state.statusBand) {
      syncing = true;
      try {
        const index = comp.head.findIndex((item) => item.key === state.statusBand);
        if (index >= 0) comp.node.querySelectorAll(".dist__seg")[index]?.click();
      } finally { syncing = false; }
    }
  }

  function paintDistribution() {
    if (state.mode === "app") paintAppDistribution();
    else paintRequestDistribution();
  }

  /* ── 渲染流 ── */
  function visibleAppEntries() {
    const needle = state.search.trim();
    return appEntries.filter((entry) => levelAtLeast(entry.level, state.level) && matchesSearch(entry, needle));
  }

  function visibleRequests() {
    const needle = state.requestSearch.trim().toLowerCase();
    return requests.filter((entry) => {
      if (!matchesBand(entry, state.statusBand)) return false;
      if (!needle) return true;
      return String(entry.fields.url ?? "").toLowerCase().includes(needle);
    });
  }

  function renderStream() {
    if (state.mode === "app") {
      const needle = state.search.trim();
      const visible = visibleAppEntries();
      // 计数已经在构成条的标题里（总数/缓冲），这里只在"画面与数据不一致"时补一句。
      setNote(state.paused
        ? `已暂停 · 画面已冻结 · 缓冲 ${appEntries.length}/${appCapacity}`
        : needle ? `${visible.length} 条命中 · 缓冲 ${appEntries.length}/${appCapacity}` : "");
      if (visible.length === 0) {
        body.replaceChildren(emptyState(
          needle ? `没有匹配「${needle}」的日志` : "这个级别还没有日志",
          needle
            ? "关键词在消息与字段值里都不匹配。可以放宽级别或清空搜索（Esc）。"
            : "应用日志不在请求噪音里——这里空，多半是真的还没说过话。换个更低的级别试试。",
        ));
        return;
      }
      body.replaceChildren(...visible.map((entry) => logRow(entry)));
      return;
    }

    const visible = visibleRequests();
    setNote(`${visible.length} 条 · 缓冲 ${requests.length}/${requestCapacity}`);
    if (visible.length === 0) {
      body.replaceChildren(emptyState(
        state.statusBand === "4xx" ? "这段时间没有失败的请求" : "这个筛选下没有请求",
        state.statusBand === "4xx" ? "切到「全部请求」看完整访问。" : "点构成条上已选中的段可以取消筛选。",
        state.statusBand === "4xx" ? "good" : "",
      ));
      return;
    }
    body.replaceChildren(...visible.map((entry) => requestRow(entry)));
  }

  /* ── 键盘 / 交互：搜索、暂停 ── */
  pauseButton.addEventListener("click", () => {
    state.paused = !state.paused;
    paintPauseButton();
    // 暂停 = 画面冻住（不重绘流），只更新旁注与构成条；恢复时才补上这期间的新日志。
    if (!state.paused) renderStream();
    else setNote(`已暂停 · 画面已冻结 · 缓冲 ${appEntries.length}/${appCapacity}`);
    paintDistribution();
  });
  paintPauseButton();

  searchInput.addEventListener("input", () => {
    if (state.mode === "app") state.search = searchInput.value;
    else state.requestSearch = searchInput.value;
    renderStream();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    searchInput.value = "";
    state.search = "";
    state.requestSearch = "";
    renderStream();
    event.preventDefault();
  });

  /* ── 初始数据 + 实时 ── */
  const [initialLogs, initialRequests] = await Promise.all([
    api("/logs?level=trace&limit=500"),
    api("/logs/requests?limit=150"),
  ]);
  if (!ctx.isActive()) return el("div");
  appEntries = initialLogs.entries ?? [];
  appCapacity = initialLogs.capacity ?? 500;
  requests = initialRequests.entries ?? [];
  requestCapacity = initialRequests.capacity ?? 300;

  renderModeTabs();
  renderToolbar();
  paintDistribution();
  renderStream();

  const atTop = () => body.scrollTop < 40;
  function appendLiveLog(entry) {
    if (appEntries.some((item) => item.seq === entry.seq)) return;
    const previousHeight = body.scrollHeight;
    appEntries = [entry, ...appEntries].slice(0, 500);
    // 暂停的语义是"画面冻住"：只更新计数与构成条，不重绘流本身。
    if (state.paused || state.mode !== "app") {
      if (state.mode === "app") paintDistribution();
      return;
    }
    const matches = levelAtLeast(entry.level, state.level) && matchesSearch(entry, state.search.trim());
    paintDistribution();
    if (!matches) {
      setNote(`有未显示的新日志 · 缓冲 ${appEntries.length}/${appCapacity}`);
      return;
    }
    const first = body.firstElementChild;
    const keep = atTop();
    if (first && first.classList.contains("empty")) renderStream();
    else body.prepend(logRow(entry, { isNew: true }));
    const retained = new Set(appEntries.map((item) => String(item.seq)));
    body.querySelectorAll("[data-seq]").forEach((node) => { if (!retained.has(node.dataset.seq)) node.remove(); });
    if (!keep) body.scrollTop += body.scrollHeight - previousHeight;
  }

  let requestRerenderPending = false;
  function scheduleRequestRender() {
    if (requestRerenderPending) return;
    requestRerenderPending = true;
    requestAnimationFrame(() => {
      requestRerenderPending = false;
      if (!ctx.isActive()) return;
      paintDistribution();
      if (state.mode === "requests") renderStream();
    });
  }

  const unsubscribeLogs = ctx.onLogEvent((entry) => appendLiveLog(entry));
  const unsubscribeRequests = ctx.onRequestEvent((entry) => {
    requests = [entry, ...requests].slice(0, 300);
    scheduleRequestRender();
  });
  ctx.onCleanup?.(() => unsubscribeLogs?.());
  ctx.onCleanup?.(() => unsubscribeRequests?.());

  /* 终端铺满视口完全由 CSS 负责：`.view--fill` 给了确定高度
     （height: calc(100vh - 150px)），`.page-body` / 本视图的 wrap / `.term`
     一路 flex:1 + min-height:0，`.term__body` 吃掉余量并在内部滚动。
     视图层不再算任何几何——自动刷新重排、窗口缩放、抽屉开关都不会打架。 */

  return wrap;
}
