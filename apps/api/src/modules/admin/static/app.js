/* ============================================================
   运维控制台 · 应用编排（工作台）
   ------------------------------------------------------------
   结构：token 闸 → 左栏常驻层 → 主列（sticky 页头带 + 页面内容）。

   三条不变量：
   1. **令牌只在内存**（模块作用域），刷新页面即失效；锁定 = 关流 + 清内存态。
   2. **左栏是仪表**：导航项带实时徽标（队列积压 / 配置问题 / 待办），
      栏底常驻现场速览——不翻页也知道哪里有事。
   3. **实时与轮询分工**：日志/访问日志走 SSE；左栏徽标 20 秒轻轮询；
      当前视图 45 秒自刷新（配置是编辑器、日志有实时流，两者除外）。
   ============================================================ */

import { setToken, hasToken, api, ApiError, openEventStream } from "./api-client.js";
import { el, tickStats } from "./ui.js";
import { formatDuration, formatNumber } from "./format.js";
import { view as overviewView } from "./views/overview.js";
import { view as queuesView } from "./views/queues.js";
import { view as logsView } from "./views/logs.js";
import { view as metricsView } from "./views/metrics.js";
import { view as infraView } from "./views/infra.js";
import { view as configView, resetDraft as resetConfigDraft } from "./views/config.js";

const VIEWS = {
  overview: overviewView,
  queues: queuesView,
  logs: logsView,
  metrics: metricsView,
  infra: infraView,
  config: configView,
};

let currentView = "overview";
let stream = null;
let railTimer = null;
let viewCleanups = [];
let liveState = { state: "idle", text: "就绪" };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ── 实时流（应用日志 + 访问日志共用一条连接）──────────── */

const logSubscribers = new Set();
const requestSubscribers = new Set();

function startStream() {
  stream?.close();
  stream = openEventStream({
    onLog(entry) {
      for (const subscriber of logSubscribers) subscriber(entry);
    },
    onRequest(entry) {
      for (const subscriber of requestSubscribers) subscriber(entry);
    },
    onState(stateName) {
      if (stateName === "connected") liveState = { state: "live", text: "实时" };
      else if (stateName === "reconnecting") liveState = { state: "busy", text: "重连中" };
      else if (stateName === "unauthorized") {
        lockGate("令牌已失效，请重新输入。");
        return;
      } else {
        liveState = { state: "idle", text: "就绪" };
      }
      paintLiveBadge();
    },
  });
}

function paintLiveBadge() {
  const badge = $("#nav-live");
  if (!badge) return;
  if (liveState.state === "live") {
    badge.hidden = false;
    badge.className = "rail__badge rail__badge--live";
    badge.replaceChildren(el("i", { "aria-hidden": "true" }), el("span", { text: "实时" }));
  } else if (liveState.state === "busy") {
    badge.hidden = false;
    badge.className = "rail__badge rail__badge--warn";
    badge.textContent = "重连中";
  } else {
    badge.hidden = true;
  }
}

/* ── 左栏徽标与现场速览（20 秒轻轮询）─────────────────── */

function setNavBadge(id, text, tone = "") {
  const badge = $("#" + id);
  if (!badge) return;
  if (!text) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.className = `rail__badge${tone ? ` rail__badge--${tone}` : ""}`;
  badge.textContent = text;
}

function setFact(id, value) {
  const node = $("#" + id);
  if (node) node.textContent = value;
}

async function refreshRailState() {
  if (!hasToken()) return;
  const [todo, queues, config, infra] = await Promise.all([
    api("/todo").catch(() => null),
    api("/queues").catch(() => null),
    api("/config").catch(() => null),
    api("/infra").catch(() => null),
  ]);

  // 队列：死信优先（红），否则显示等待中的数量（橙）。
  const dead = queues?.totals?.deadTotal ?? 0;
  const pending = queues?.totals?.pending ?? 0;
  setNavBadge("nav-badge-queues",
    dead > 0 ? String(dead) : pending > 0 ? String(pending) : "",
    dead > 0 ? "alert" : "warn");

  // 配置：阻断问题 + 未注入密钥，都是"功能不可用"级别的信号。
  const configIssues = (config?.issues?.filter((issue) => issue.blocking).length ?? 0)
    + (config?.unresolvedEnvRefs?.length ?? 0);
  setNavBadge("nav-badge-config", configIssues > 0 ? String(configIssues) : "", "warn");

  // 基础设施：不健康的容器（不健康 = 红；重启中/暂停 = 橙）。一次性任务
  // 退出码 0 在服务端已经算成 ok，不会误报。
  if (infra?.docker?.available) {
    const bad = infra.docker.containers.filter((c) => c.tone === "bad").length;
    const warn = infra.docker.containers.filter((c) => c.tone === "warn").length;
    setNavBadge("nav-badge-infra", bad > 0 ? String(bad) : warn > 0 ? String(warn) : "", bad > 0 ? "alert" : "warn");
  } else {
    setNavBadge("nav-badge-infra", "", "");
  }

  // 总览：待办里的 block + warn。
  const blocking = todo?.counts?.block ?? 0;
  const urgent = blocking + (todo?.counts?.warn ?? 0);
  setNavBadge("nav-badge-overview", urgent > 0 ? String(urgent) : "", blocking > 0 ? "alert" : "warn");

  if (queues) {
    setFact("fact-users", formatNumber(queues.counts.usersTotal));
    setFact("fact-spaces", formatNumber(queues.counts.workspacesTotal));
    setFact("fact-notes", formatNumber(queues.counts.notesActive));
    setFact("fact-runs", formatNumber(queues.counts.runsTotal));
  }
}

/* ── 视图上下文 ────────────────────────────────────────── */

const ctx = {
  switchView,
  reload: () => refreshCurrent(),
  onLogEvent(callback) {
    logSubscribers.add(callback);
    return () => logSubscribers.delete(callback);
  },
  onRequestEvent(callback) {
    requestSubscribers.add(callback);
    return () => requestSubscribers.delete(callback);
  },
  onCleanup(fn) {
    viewCleanups.push(fn);
  },
  /** 往页头带里追加内容（总览的状态句放这里，滚动时仍可见）。 */
  setHeadExtra(...nodes) {
    const slot = $("#head-extra");
    if (!slot) return;
    const flat = nodes.flat().filter(Boolean);
    slot.replaceChildren(...flat);
    slot.hidden = flat.length === 0;
  },
  /** 页头带右侧的动作（保存/放弃这类要常驻可点）。 */
  setHeadActions(...nodes) {
    const slot = $("#head-actions");
    if (!slot) return;
    slot.replaceChildren(...nodes.flat().filter(Boolean));
  },
  updateChrome(overview) {
    const env = $("#rail-env");
    if (env && overview?.service) {
      const mode = overview.service.nodeEnv === "production" ? "正式环境" : "开发环境";
      env.textContent = `${mode} · 运行 ${formatDuration(overview.service.uptimeSeconds)}`;
    }
    const release = $("#rail-release");
    if (release && overview?.release) {
      const version = overview.release.version ?? "dev";
      const commit = (overview.release.commit ?? "").slice(0, 7);
      release.textContent = commit ? `${version} · ${commit}` : version;
    }
  },
  /** 视图做完了动作（重试/清理/保存）后通知左栏刷新徽标。 */
  refreshRail: () => { void refreshRailState(); },
};

/* ── 视图路由 ──────────────────────────────────────────── */

async function switchView(name, { force = false } = {}) {
  if (!VIEWS[name]) return;
  if (name === currentView && !force) return;

  for (const cleanup of viewCleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* 清理失败不阻断切换 */
    }
  }

  currentView = name;

  $$(".rail__item").forEach((item) => {
    const active = item.dataset.view === name;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });

  const meta = VIEWS[name];
  const content = $("#content");
  const head = el("div", { class: "page-head" },
    el("div", { class: "page-head__inner" },
      el("div", { class: "page-head__row" },
        el("div", {},
          el("h1", { class: "page-head__title", text: meta.title }),
          el("p", { class: "page-head__lede", text: meta.lede }),
        ),
        el("div", { class: "page-head__actions", id: "head-actions" }),
      ),
      el("div", { id: "head-extra", hidden: true }),
    ),
  );
  const body = el("div", { class: "page-body" });
  content.replaceChildren(el("div", { class: `view${meta.fill ? " view--fill" : ""}` }, head, body));

  body.append(el("div", { class: "figures" },
    ...Array.from({ length: 4 }, () => el("div", { class: "figure" }, el("div", { class: "skeleton", style: "height:52px" }))),
  ));

  try {
    const rendered = await meta.load(ctx);
    if (currentView !== name) return; // 加载期间用户已切走
    body.replaceChildren(rendered);
    tickStats(body);
    window.scrollTo(0, 0);
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      lockGate("令牌无效，或该部署未启用运维面板。");
      return;
    }
    body.replaceChildren(
      el("div", { class: "empty" },
        el("strong", { text: "载入失败" }),
        el("span", { class: "mono", text: error.message }),
      ),
    );
  }
}

/** 重载当前视图（保留滚动位置）。 */
async function refreshCurrent() {
  const scrollTop = window.scrollY;
  await switchView(currentView, { force: true });
  window.scrollTo(0, scrollTop);
  void refreshRailState();
}

/* ── 闸与启动 ──────────────────────────────────────────── */

function lockGate(message) {
  setToken(null);
  stream?.close();
  stream = null;
  liveState = { state: "idle", text: "就绪" };
  resetConfigDraft();
  for (const cleanup of viewCleanups.splice(0)) {
    try { cleanup(); } catch { /* 无碍 */ }
  }
  paintLiveBadge();

  const gate = $("#gate");
  const shell = $("#shell");
  shell.hidden = true;
  gate.hidden = false;
  gate.dataset.state = "locked";
  gate.style.removeProperty("animation");
  if (message) {
    const error = $("#gate-error");
    error.textContent = message;
    error.hidden = false;
  }
}

async function unlockGate(candidate) {
  setToken(candidate);
  try {
    // 先打一次真请求再揭幕：这样「令牌错了」发生在闸还开着的时候，
    // 用户不会先看到面板骨架再被弹回来。
    await api("/overview");
  } catch {
    setToken(null);
    return false;
  }
  const gate = $("#gate");
  const shell = $("#shell");
  gate.dataset.state = "unlocked";
  shell.hidden = false;
  $("#gate-error").hidden = true;

  startStream();
  void refreshRailState();
  clearInterval(railTimer);
  railTimer = setInterval(refreshRailState, 20_000);

  await switchView("overview", { force: true });

  setTimeout(() => {
    gate.hidden = true;
  }, 260);
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
      input.select();
    }
  });

  $$(".rail__item").forEach((item) => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  $("#refresh").addEventListener("click", async () => {
    const button = $("#refresh");
    button.classList.add("is-busy");
    await refreshCurrent();
    button.classList.remove("is-busy");
  });

  $("#lock").addEventListener("click", () => lockGate(null));

  // 键盘：数字键快速切换视图，顺序与导航一致。
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.matches("input, select, textarea")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ($("#shell").hidden) return;
    if (!$("#modal").hidden) return;
    const views = Object.keys(VIEWS);
    const index = Number(event.key) - 1;
    if (index >= 0 && index < views.length) switchView(views[index]);
  });

  // 左栏时钟
  const clock = $("#clock");
  const tickClock = () => {
    if (clock) clock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  };
  tickClock();
  setInterval(tickClock, 1000);

  // 当前视图的温和自刷新：只覆盖"数字会变"的三页；配置是编辑器、
  // 日志有实时流，都不该被定时重建。
  setInterval(() => {
    if (document.hidden) return;
    if ($("#shell").hidden) return;
    if (!$("#modal").hidden) return;
    if (!["overview", "queues", "metrics"].includes(currentView)) return;
    void refreshCurrent();
  }, 45_000);
}

/* ── 启动 ──────────────────────────────────────────────── */

bindEvents();
paintLiveBadge();
