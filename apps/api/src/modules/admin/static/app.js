/* ============================================================
   运维控制台 · 应用编排
   ------------------------------------------------------------
   结构：token 闸 → 页签路由 → 数据轮询/实时流 → 3D 仪器接线。

   三条不变量：
   1. **令牌只在内存**（模块作用域），刷新页面即失效；锁定 = 关流 + 清缓存 +
      仪器回门厅。
   2. **场景是视图的仪器，不是背景**：overview/queues 在加载时把 canvas 挂进
      自己的舞台（`ctx.mountScene`），其它视图不挂——扁平页面不烧 GPU。
   3. **实时与轮询分工明确**：日志/访问日志走 SSE；仪器数据心跳走 10 秒轮询；
      当前视图 45 秒自刷新一次（配置页与日志页除外）。
   ============================================================ */

import { setToken, hasToken, api, ApiError, openEventStream } from "./api-client.js";
import { createScene } from "./scene.js";
import { el, tickStats } from "./ui.js";
import { formatDuration } from "./format.js";
import { view as overviewView } from "./views/overview.js";
import { view as queuesView } from "./views/queues.js";
import { view as logsView } from "./views/logs.js";
import { view as metricsView } from "./views/metrics.js";
import { view as configView, resetDraft as resetConfigDraft } from "./views/config.js";

const VIEWS = {
  overview: overviewView,
  queues: queuesView,
  logs: logsView,
  metrics: metricsView,
  config: configView,
};

let currentView = "overview";
let stream = null;
let feedTimer = null;
let viewCleanups = [];
let scene = null;
let liveState = { state: "idle", text: "就绪" };
/** 跨视图聚焦：总览点柱 → 队列页选中那一类。 */
let focusJobType = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ── 仪器（3D 场景）───────────────────────────────────── */

function bootScene() {
  scene = createScene();
  if (!scene) {
    // WebGL 不可用：舞台的 CSS 星野兜底，功能完全不受影响。
    document.body.dataset.scene = "off";
  } else if ($("#gate-stage")) {
    scene.mount($("#gate-stage"), "gate");
  }
}

function healthOf({ errors, blocking, oldestPendingSeconds, lagSeconds }) {
  if (blocking > 0) return "block";
  if ((errors ?? 0) > 0.5) return "bad";
  if ((oldestPendingSeconds ?? 0) > 900 || (lagSeconds ?? 0) > 0.5) return "warn";
  return "ok";
}

/** 仪器数据心跳：每 10 秒喂「速率 / 错误 / 延迟 / 队列 / 健康」。与当前视图无关。 */
async function feedScene() {
  if (!scene || !hasToken()) return;
  try {
    const [series, queues, todo] = await Promise.all([
      api("/metrics/series").catch(() => null),
      api("/queues").catch(() => null),
      api("/todo").catch(() => null),
    ]);
    const points = series?.points ?? [];
    const last = points.length ? points[points.length - 1] : null;
    scene.setMetrics({
      requestsPerMinute: last?.requestsPerMinute ?? 0,
      errorsPerMinute: last?.errorsPerMinute ?? 0,
      p95Seconds: last?.p95Seconds ?? 0.2,
    });
    if (queues?.byType) scene.setQueue(queues.byType);
    scene.setHealth(healthOf({
      errors: last?.errorsPerMinute ?? 0,
      blocking: todo?.counts?.block ?? 0,
      oldestPendingSeconds: queues?.totals?.oldestPendingSeconds ?? 0,
      lagSeconds: last?.eventLoopLagSeconds ?? 0,
    }));
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") lockGate("令牌已失效，请重新输入。");
  }
}

/* ── 实时流 ────────────────────────────────────────────── */

const logSubscribers = new Set();
const requestSubscribers = new Set();

function startStream() {
  stream?.close();
  stream = openEventStream({
    onLog(entry) {
      for (const subscriber of logSubscribers) subscriber(entry);
      scene?.pulse(entry.level);
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
      restoreConnectionPill();
    },
  });
}

function setConnection(stateName, text) {
  const pill = $("#conn-pill");
  const label = $("#conn-text");
  if (pill) pill.dataset.state = stateName;
  if (label) label.textContent = text;
}

function restoreConnectionPill() {
  setConnection(liveState.state, liveState.text);
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
  /** 把仪器挂进舞台。返回后视图可以 setLabels / onBarSelect。 */
  mountScene(stageEl, mode) {
    scene?.mount(stageEl, mode);
  },
  setLabels(list) {
    scene?.setLabels(list);
  },
  setQueue(rows) {
    scene?.setQueue(rows);
  },
  onBarSelect(callback) {
    return scene ? scene.onBarSelect(callback) : () => {};
  },
  selectBar(index) {
    scene?.selectBar(index);
  },
  /** 总览 → 队列的交接：设置/取走要聚焦的作业类型（取走即清）。 */
  setFocusJobType(jobType) {
    focusJobType = jobType ?? null;
  },
  takeFocusJobType() {
    const value = focusJobType;
    focusJobType = null;
    return value;
  },
  updateChrome(overview) {
    const envBadge = $("#env-badge");
    if (envBadge) envBadge.textContent = overview?.service?.nodeEnv ?? "";
    const uptime = $("#uptime");
    if (uptime && overview?.service) uptime.textContent = `已运行 ${formatDuration(overview.service.uptimeSeconds)}`;
    const release = $("#release");
    if (release && overview?.release) {
      const version = overview.release.version ?? "dev";
      const commit = (overview.release.commit ?? "").slice(0, 7);
      release.textContent = commit ? `${version} · ${commit}` : version;
    }
  },
  onVerdict(health) {
    scene?.setHealth(health);
  },
};

/* ── 视图路由 ──────────────────────────────────────────── */

async function switchView(name, { force = false } = {}) {
  if (!VIEWS[name]) return;
  if (name === currentView && !force) return;

  // 上一个视图的订阅/仪器先退场（canvas 摘下来 = 停渲染）。
  for (const cleanup of viewCleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* 清理失败不阻断切换 */
    }
  }
  scene?.unmount();

  currentView = name;
  document.body.dataset.view = name;

  $$(".tab").forEach((tab) => {
    const active = tab.dataset.view === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
  });

  const meta = VIEWS[name];
  const content = $("#content");
  content.replaceChildren(el("div", { class: `view${meta.fill ? " view--fill" : ""}`, id: "view-root" }));
  const root = $("#view-root");
  root.append(
    el("header", { class: "view__head" },
      el("h1", { class: "view__title", text: meta.title }),
      el("p", { class: "view__lede", text: meta.lede }),
    ),
  );
  const body = el("div", { class: "view__body" });
  root.append(body);

  // 不缓存视图 DOM：仪器标签、订阅与选择状态都挂在这次加载上，缓存会让
  // 「回到这一页」拿到一份和场景脱钩的旧 DOM。每次重载的代价只是一次取数。
  body.append(el("div", { class: "grid grid--kpi" },
    ...Array.from({ length: 4 }, () => el("div", { class: "skeleton" })),
  ));

  try {
    setConnection("busy", "载入中");
    const rendered = await meta.load(ctx);
    if (currentView !== name) return; // 加载期间用户已切走
    body.replaceChildren(rendered);
    restoreConnectionPill();
    tickStats(body);
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthorized") {
      lockGate("令牌无效，或该部署未启用运维面板。");
      return;
    }
    setConnection("error", "出错");
    body.replaceChildren(
      el("div", { class: "table" },
        el("div", { style: "padding:14px" },
          el("div", { class: "stat__label", text: "载入失败" }),
          el("div", { class: "mono", text: error.message }),
        ),
      ),
    );
  }
}

/** 重载当前视图（保留滚动位置）。 */
async function refreshCurrent() {
  const content = $("#content");
  const scrollTop = content.scrollTop;
  await switchView(currentView, { force: true });
  content.scrollTop = scrollTop;
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
  scene?.unmount();
  if (scene && $("#gate-stage")) scene.mount($("#gate-stage"), "gate");

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
    void error.offsetWidth;
  }
}

async function unlockGate(candidate) {
  setToken(candidate);
  try {
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
  void feedScene();
  clearInterval(feedTimer);
  feedTimer = setInterval(feedScene, 10_000);

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

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  $("#refresh").addEventListener("click", async () => {
    const button = $("#refresh");
    button.classList.add("is-busy");
    await refreshCurrent();
    button.classList.remove("is-busy");
  });

  $("#lock").addEventListener("click", () => lockGate(null));

  // 键盘：数字键快速切换视图，顺序与页签一致。
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.matches("input, textarea, select")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ($("#shell").hidden) return;
    if (!$("#modal").hidden) return;
    const views = Object.keys(VIEWS);
    const index = Number(event.key) - 1;
    if (index >= 0 && index < views.length) switchView(views[index]);
  });

  // 顶栏时钟
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

bootScene();
bindEvents();
restoreConnectionPill();
