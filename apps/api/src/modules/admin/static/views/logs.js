/* ============================================================
   视图 · 日志（级别栏 + 终端）
   ------------------------------------------------------------
   左边一列是**过滤器**，右边是流：

     · **应用日志**：左栏按级别列出计数（全部 / 常规以上 / … / 只有问题），
       点一行筛一类；右侧终端实时尾随（SSE），支持关键词搜索与暂停。
     · **访问日志**：左栏换成"全部 / 只看失败"与数量；右侧一行一条请求
       （方法 + 路径 + 状态 + 耗时）——它回答「刚才哪个请求慢了/炸了」。

   计数按**当前窗口**统计（不是全量），所以它同时也是分布读数：
   一眼看出"警告多不多"，再决定要不要钻进去。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatMs, formatTime } from "../format.js";
import { el, emptyState, ICONS, icon } from "../ui.js";

export const view = {
  title: "日志",
  lede: "左边按级别筛选（数字是当前窗口里的条数），右边是实时流。内存里只保留最近一批，重启即清空——完整日志仍在容器里。",
  fill: true,
  load: loadLogs,
};

const LEVELS = [
  { value: "trace", label: "全部" },
  { value: "debug", label: "常规以上" },
  { value: "info", label: "记录以上" },
  { value: "warn", label: "警告以上" },
  { value: "error", label: "只有问题" },
];
const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 };

/** 视图内保留的过滤状态：切走再切回来时不清空（运维正在排查的上下文）。 */
const state = {
  mode: "app", // "app" | "requests"
  level: "trace",
  search: "",
  paused: false,
  requestsOnlyProblems: false,
  requestSearch: "",
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

function fieldTone(key, value) {
  const text = `${key} ${typeof value === "string" ? value : ""}`.toLowerCase();
  if (text.includes("error") || text.includes("fail")) return " log__field--bad";
  if (key === "stack" || key === "diag") return " log__field--warn";
  return "";
}

function logRow(entry, { isNew = false } = {}) {
  const fields = Object.entries(entry.fields ?? {});
  return el("div", { class: `log${isNew ? " log--new" : ""}`, dataset: { seq: entry.seq } },
    el("div", { class: "log__time", text: formatTime(entry.time) }),
    el("div", { class: "log__level", dataset: { level: entry.level }, text: entry.level }),
    el("div", { class: "log__body" },
      el("div", { class: "log__msg", text: entry.msg }),
      fields.length
        ? el("div", { class: "log__fields" },
            ...fields.map(([key, value]) =>
              el("span", { class: `log__field${fieldTone(key, value)}` },
                el("b", { text: `${key}=` }),
                fieldValueText(value),
              )))
        : null,
    ),
  );
}

function requestRow(entry) {
  const status = entry.fields.statusCode;
  const tone = typeof status === "number" && status >= 500 ? "bad" : typeof status === "number" && status >= 400 ? "warn" : "ok";
  return el("div", { class: "req-row" },
    el("div", { class: "req-row__path", text: `${entry.fields.method ?? "?"} ${entry.fields.url ?? ""}` }),
    el("div", { class: `req-row__status req-row__status--${tone}`, text: String(status ?? "—") }),
    el("div", { class: "req-row__ms", text: formatMs(entry.fields.durationMs) }),
    el("div", { class: "req-row__ago", title: formatTime(entry.time), text: formatAgo(entry.time) }),
  );
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

function levelAtLeast(entryLevel, minLevel) {
  return (LEVEL_ORDER[entryLevel] ?? 0) >= (LEVEL_ORDER[minLevel] ?? 0);
}

async function loadLogs(ctx) {
  /* ── 左栏：过滤器（按模式切换内容）── */
  const levelsRail = el("div", { class: "levels" });

  /* ── 右侧：工具栏 + 流 ── */
  const modeTabs = el("div", { class: "seg", role: "group", "aria-label": "日志流" });
  const searchInput = el("input", { class: "field__input", type: "search", style: "flex:1;min-width:180px" });
  const countNote = el("span", { class: "term__count" });
  const pauseButton = el("button", { class: "btn btn--sm", type: "button" });

  const toolbar = el("div", { class: "term__toolbar" },
    modeTabs,
    searchInput,
    pauseButton,
    countNote,
  );
  const body = el("div", { class: "term__body" });
  const term = el("div", { class: "term" }, toolbar, body);
  const layout = el("div", { class: "log-layout" }, levelsRail, term);

  /* ── 两条流的数据窗口 ── */
  let appEntries = [];
  let appCapacity = 500;
  let requests = [];
  let requestCapacity = 300;

  function renderModeTabs() {
    modeTabs.replaceChildren(
      ...[["app", "应用日志"], ["requests", "访问日志"]].map(([value, label]) =>
        el("button", {
          class: "seg__item", type: "button",
          "aria-pressed": state.mode === value ? "true" : "false",
          text: label,
          onclick: () => { state.mode = value; renderModeTabs(); renderToolbar(); paintRail(); render(); },
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
    pauseButton.replaceChildren(
      icon(state.paused ? ICONS.play : ICONS.pause, { size: 12 }),
      el("span", { text: state.paused ? "继续" : "暂停" }),
    );
  }
  pauseButton.addEventListener("click", () => {
    state.paused = !state.paused;
    paintPauseButton();
    if (!state.paused) render();
  });
  paintPauseButton();

  searchInput.addEventListener("input", () => {
    if (state.mode === "app") state.search = searchInput.value;
    else state.requestSearch = searchInput.value;
    render();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      state.search = "";
      state.requestSearch = "";
      render();
      event.preventDefault();
    }
  });

  /**
   * 左栏过滤器：应用模式按级别列出计数；访问模式是"全部 / 只看失败"。
   * 计数是**当前窗口**的分布——它同时告诉你"警告多不多"。
   */
  function paintRail() {
    if (state.mode === "app") {
      // 一次遍历数出各级别的条数（每来一条日志都要更新左栏，别做 5 次 filter）。
      const tally = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0, silent: 0 };
      for (const entry of appEntries) tally[entry.level] = (tally[entry.level] ?? 0) + 1;
      const atLeast = (level) => Object.entries(tally)
        .reduce((sum, [name, count]) => sum + ((LEVEL_ORDER[name] ?? 0) >= (LEVEL_ORDER[level] ?? 0) ? count : 0), 0);
      levelsRail.replaceChildren(...LEVELS.map((level) => {
        const count = atLeast(level.value);
        const tone = level.value === "error" && count > 0 ? "bad"
          : level.value === "warn" && count > 0 ? "warn" : "";
        return el("button", {
          class: "level-row", type: "button",
          "aria-pressed": level.value === state.level ? "true" : "false",
          onclick: () => { state.level = level.value; paintRail(); render(); },
        },
          el("span", { text: level.label }),
          el("span", { class: `level-row__count${tone ? ` level-row__count--${tone}` : ""}`, text: String(count) }),
        );
      }));
      return;
    }

    const problems = requests.filter((entry) => (entry.fields.statusCode ?? 0) >= 400).length;
    levelsRail.replaceChildren(
      el("button", {
        class: "level-row", type: "button",
        "aria-pressed": state.requestsOnlyProblems ? "false" : "true",
        onclick: () => { state.requestsOnlyProblems = false; paintRail(); render(); },
      },
        el("span", { text: "全部请求" }),
        el("span", { class: "level-row__count", text: String(requests.length) }),
      ),
      el("button", {
        class: "level-row", type: "button",
        "aria-pressed": state.requestsOnlyProblems ? "true" : "false",
        onclick: () => { state.requestsOnlyProblems = true; paintRail(); render(); },
      },
        el("span", { text: "只看失败" }),
        el("span", { class: `level-row__count${problems > 0 ? " level-row__count--warn" : ""}`, text: String(problems) }),
      ),
    );
  }

  /* ── 渲染流 ── */
  function render() {
    if (state.mode === "app") {
      const needle = state.search.trim();
      const visible = appEntries.filter((entry) =>
        levelAtLeast(entry.level, state.level) && matchesSearch(entry, needle));
      countNote.textContent = state.paused
        ? `已暂停 · 缓冲 ${appEntries.length}/${appCapacity}`
        : `${visible.length} 条${needle ? "命中" : ""} · 缓冲 ${appEntries.length}/${appCapacity}`;
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

    const needle = state.requestSearch.trim().toLowerCase();
    const visible = requests.filter((entry) => {
      const status = entry.fields.statusCode;
      if (state.requestsOnlyProblems && !(typeof status === "number" && status >= 400)) return false;
      if (!needle) return true;
      return String(entry.fields.url ?? "").toLowerCase().includes(needle);
    });
    countNote.textContent = `${visible.length} 条 · 缓冲 ${requests.length}/${requestCapacity}`;
    if (visible.length === 0) {
      body.replaceChildren(emptyState(
        state.requestsOnlyProblems ? "这段时间没有失败的请求" : "还没有完成的请求",
        state.requestsOnlyProblems ? "切到「全部请求」看完整访问。" : "请求完成后会实时出现在这里。",
        state.requestsOnlyProblems ? "good" : "",
      ));
      return;
    }
    body.replaceChildren(...visible.map(requestRow));
  }

  /* ── 初始数据 + 实时 ── */
  const [initialLogs, initialRequests] = await Promise.all([
    api("/logs?level=trace&limit=200"),
    api("/logs/requests?limit=150"),
  ]);
  appEntries = initialLogs.entries ?? [];
  appCapacity = initialLogs.capacity ?? 500;
  requests = initialRequests.entries ?? [];
  requestCapacity = initialRequests.capacity ?? 300;

  renderModeTabs();
  renderToolbar();
  paintRail();
  render();

  const atTop = () => body.scrollTop < 40;
  function appendLiveLog(entry) {
    appEntries = [entry, ...appEntries].slice(0, 500);
    // 暂停的语义是"画面冻住"：只更新左栏计数，不重绘流本身。
    // （此前 paused 分支也会 render()，新日志照常插到顶部——暂停形同虚设。）
    if (state.paused || state.mode !== "app") {
      if (state.mode === "app") {
        paintRail();
        if (state.paused) countNote.textContent = `已暂停 · 缓冲 ${appEntries.length}/${appCapacity}`;
      }
      return;
    }
    const matches = levelAtLeast(entry.level, state.level) && matchesSearch(entry, state.search.trim());
    paintRail();
    if (!matches) {
      countNote.textContent = `有未显示的新日志 · 缓冲 ${appEntries.length}/${appCapacity}`;
      return;
    }
    const first = body.firstElementChild;
    const keep = atTop();
    if (first && first.classList.contains("empty")) render();
    else body.prepend(logRow(entry, { isNew: true }));
    if (!keep) body.scrollTop += 34;
  }

  let requestRerenderPending = false;
  function scheduleRequestRender() {
    if (requestRerenderPending) return;
    requestRerenderPending = true;
    requestAnimationFrame(() => {
      requestRerenderPending = false;
      paintRail();
      if (state.mode === "requests") render();
    });
  }

  const unsubscribeLogs = ctx.onLogEvent((entry) => appendLiveLog(entry));
  const unsubscribeRequests = ctx.onRequestEvent((entry) => {
    requests = [entry, ...requests].slice(0, 300);
    scheduleRequestRender();
  });
  ctx.onCleanup?.(() => unsubscribeLogs?.());
  ctx.onCleanup?.(() => unsubscribeRequests?.());

  return layout;
}
