/** Control center: tab-scoped session recovery, scoped asynchronous views, live observations. */
import { setToken, hasToken, readSessionToken, rememberSessionToken, forgetSessionToken, api, ApiError, openEventStream } from "./api-client.js";
import { el, icon, ICONS, tickStats, resetStats, reducedMotion, springSelection, trapFocus, reveal, dismissDialog } from "./ui.js";
import { formatDuration } from "./format.js";
import { view as overviewView } from "./views/overview.js";
import { view as queuesView } from "./views/queues.js";
import { view as logsView } from "./views/logs.js";
import { view as metricsView } from "./views/metrics.js";
import { view as infraView } from "./views/infra.js";
import { view as configView, resetDraft as resetConfigDraft } from "./views/config.js";

const VIEWS = { overview: overviewView, queues: queuesView, logs: logsView, metrics: metricsView, infra: infraView, config: configView };
const SEARCH = {
  overview: "系统健康 运行状态 待办 总览 overview",
  queues: "任务 队列 失败 重试 死信 jobs queues",
  logs: "日志 实时 报错 请求 logs",
  metrics: "指标 耗时 性能 曲线 metrics",
  infra: "基础设施 容器 数据库 存储 重启 docker infra",
  config: "模型 配置 密钥 AI config",
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const isUnlocked = () => hasToken() && !$("#shell").hidden;
let currentView = "overview";
let revision = 0;
let session = 0;
let stream = null;
let railTimer = null;
let gateAnimation = null;
let viewCleanups = [];
let liveState = "idle";
let refreshing = false;
const logSubscribers = new Set();
const requestSubscribers = new Set();
const moveSelection = springSelection($("#nav-selection"));

function paintLiveBadge() {
  const badge = $("#nav-live");
  badge.hidden = liveState === "idle";
  badge.className = `rail__badge rail__badge--${liveState === "live" ? "live" : "warn"}`;
  badge.textContent = liveState === "live" ? "实时" : "重连";
  $("#connection").dataset.state = liveState;
  $("#connection-label").textContent = liveState === "live" ? "实时连接" : liveState === "busy" ? "正在重连" : "连接未建立";
}
function startStream() {
  stream?.close();
  stream = openEventStream({
    onLog(entry) { for (const callback of logSubscribers) callback(entry); },
    onRequest(entry) { for (const callback of requestSubscribers) callback(entry); },
    onState(state) {
      if (state === "unauthorized") { lockGate("令牌已失效，请重新输入。"); return; }
      liveState = state === "connected" ? "live" : state === "reconnecting" ? "busy" : "idle";
      paintLiveBadge();
    },
  });
}
function setNavBadge(id, text, tone = "") {
  const badge = $("#" + id);
  badge.hidden = !text;
  badge.className = `rail__badge${tone ? ` rail__badge--${tone}` : ""}`;
  badge.textContent = text;
}
async function refreshRailState() {
  if (!isUnlocked()) return;
  const activeSession = session;
  const [todo, queues, config, infra] = await Promise.all([
    api("/todo").catch(() => null), api("/queues").catch(() => null),
    api("/config").catch(() => null), api("/infra").catch(() => null),
  ]);
  if (activeSession !== session || !hasToken()) return;
  const dead = queues?.totals?.deadTotal ?? 0;
  const pending = queues?.totals?.pending ?? 0;
  setNavBadge("nav-badge-queues", dead > 0 ? String(dead) : pending > 0 ? String(pending) : "", dead > 0 ? "alert" : "warn");
  const configIssues = (config?.issues?.filter((issue) => issue.blocking).length ?? 0) + (config?.unresolvedEnvRefs?.length ?? 0);
  setNavBadge("nav-badge-config", configIssues > 0 ? String(configIssues) : "", "warn");
  const containers = infra?.docker?.available ? infra.docker.containers : [];
  const bad = containers.filter((c) => c.tone === "bad").length;
  const warn = containers.filter((c) => c.tone === "warn").length;
  setNavBadge("nav-badge-infra", bad > 0 ? String(bad) : warn > 0 ? String(warn) : "", bad > 0 ? "alert" : "warn");
  const blocking = todo?.counts?.block ?? 0;
  const urgent = blocking + (todo?.counts?.warn ?? 0);
  setNavBadge("nav-badge-overview", urgent > 0 ? String(urgent) : "", blocking > 0 ? "alert" : "warn");
}
function cleanupView() {
  for (const cleanup of viewCleanups.splice(0)) { try { cleanup(); } catch { /* A failed teardown must not trap navigation. */ } }
}
function viewContext(version, head) {
  const active = () => version === revision && hasToken();
  return {
    switchView: (...args) => active() ? switchView(...args) : undefined,
    reload: () => active() ? refreshCurrent() : undefined,
    isActive: active,
    onLogEvent(callback) {
      if (!active()) return () => {};
      logSubscribers.add(callback);
      return () => logSubscribers.delete(callback);
    },
    onRequestEvent(callback) {
      if (!active()) return () => {};
      requestSubscribers.add(callback);
      return () => requestSubscribers.delete(callback);
    },
    onCleanup(fn) { if (active()) viewCleanups.push(fn); else fn(); },
    setHeadExtra(...nodes) {
      if (!active()) return;
      const slot = $("#head-extra", head);
      const flat = nodes.flat().filter(Boolean);
      slot.replaceChildren(...flat);
      slot.hidden = flat.length === 0;
    },
    setHeadActions(...nodes) { if (active()) $("#head-actions").replaceChildren(...nodes.flat().filter(Boolean)); },
    updateChrome(overview) {
      if (!active() || !overview?.service) return;
      const mode = overview.service.nodeEnv === "production" ? "正式环境" : "开发环境";
      $("#rail-env").textContent = mode;
      const release = overview.release ?? {};
      $("#rail-release").textContent = `${release.version ?? "dev"} · 已运行 ${formatDuration(overview.service.uptimeSeconds)}`;
    },
    refreshRail: () => { if (active()) void refreshRailState(); },
  };
}

async function switchView(name, { force = false, preserve = false, focus = false } = {}) {
  if (!isUnlocked() || !VIEWS[name]) return;
  if (name === currentView && !force) { if (focus) $("#content").focus({ preventScroll: true }); return; }
  cleanupView();
  const version = ++revision;
  currentView = name;
  const content = $("#content");
  const previousScroll = window.scrollY;
  const meta = VIEWS[name];
  $("#location-title").textContent = meta.title;
  $("#head-actions").replaceChildren();
  $$(".rail__item").forEach((item) => {
    const active = item.dataset.view === name;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  const activeItem = $(".rail__item.is-active");
  activeItem.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  moveSelection(activeItem);
  const head = el("div", { class: "page-head" },
    el("div", { class: "page-head__inner" },
      el("span", { class: "eyebrow", text: meta.eyebrow ?? "ASTELLA CONTROL CENTER" }),
      el("h1", { class: "page-head__title", text: meta.title }),
      el("p", { class: "page-head__lede", text: meta.lede }),
      el("div", { id: "head-extra", hidden: true }),
    ),
  );
  const body = el("div", { class: "page-body" });
  const view = el("div", { class: `view view--${name}${meta.fill ? " view--fill" : ""}` }, head, body);
  if (!preserve) {
    content.replaceChildren(view);
    body.append(el("div", { class: "loading-state", role: "status", "aria-label": "正在加载" },
      el("div", { class: "skeleton skeleton--hero" }),
      el("div", { class: "figures" }, ...Array.from({ length: 4 }, () => el("div", { class: "skeleton" }))),
    ));
    window.scrollTo(0, 0);
  }
  content.setAttribute("aria-busy", "true");
  try {
    const rendered = await meta.load(viewContext(version, head));
    if (version !== revision || !hasToken()) return;
    body.replaceChildren(rendered);
    if (preserve) content.replaceChildren(view);
    tickStats(body);
    reveal(body, preserve);
    $("#last-updated").textContent = `${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} 更新`;
    window.scrollTo(0, preserve ? previousScroll : 0);
    if (focus) content.focus({ preventScroll: true });
  } catch (error) {
    if (version !== revision || !hasToken()) return;
    if (error instanceof ApiError && error.code === "unauthorized") { lockGate("令牌无效，请重新输入。"); return; }
    if (preserve) content.replaceChildren(view);
    body.replaceChildren(el("div", { class: "load-error", role: "alert" }, icon(ICONS.alert, { size: 30 }),
      el("h2", { text: "暂时无法读取这个页面" }), el("p", { text: error.message }),
      el("button", { class: "btn btn--primary", type: "button", text: "重新加载", onclick: () => refreshCurrent() })));
  } finally { if (version === revision) content.removeAttribute("aria-busy"); }
}
async function refreshCurrent() {
  if (refreshing || !isUnlocked()) return;
  refreshing = true;
  $("#refresh").classList.add("is-busy");
  try { await switchView(currentView, { force: true, preserve: true }); void refreshRailState(); }
  finally { refreshing = false; $("#refresh").classList.remove("is-busy"); }
}
function lockGate(message) {
  ++session; ++revision;
  forgetSessionToken();
  dismissDialog();
  clearInterval(railTimer);
  gateAnimation?.cancel();
  closeCommand(false);
  stream?.close(); stream = null;
  liveState = "idle";
  resetConfigDraft(); resetStats(); cleanupView();
  logSubscribers.clear(); requestSubscribers.clear();
  $("#content").replaceChildren();
  $("#head-actions").replaceChildren();
  $("#shell").hidden = true; $("#shell").inert = true;
  const gate = $("#gate");
  gate.hidden = false; gate.inert = false; gate.dataset.state = "locked";
  $("#gate-form").hidden = false; $("#gate-resume").hidden = true;
  $("#gate-retry").hidden = true;
  $("#gate-error").textContent = message ?? "";
  $("#gate-error").hidden = !message;
  $("#gate-token").value = "";
  $("#gate-token").focus();
  paintLiveBadge();
}
async function unlockGate(candidate) {
  const attempt = ++session;
  setToken(candidate);
  let overview;
  try { overview = await api("/overview"); }
  catch (error) {
    if (attempt === session) {
      setToken(null);
      if (error instanceof ApiError && error.code === "unauthorized") forgetSessionToken();
    }
    throw error;
  }
  if (attempt !== session) return;
  rememberSessionToken();
  const gate = $("#gate");
  $("#shell").hidden = false; $("#shell").inert = false;
  $("#gate-error").hidden = true;
  gate.inert = true;
  gateAnimation?.cancel();
  if (reducedMotion()) gate.hidden = true;
  else {
    gateAnimation = gate.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-out", fill: "forwards" });
    gateAnimation.finished.then(() => { if (attempt === session) gate.hidden = true; }).catch(() => {});
  }
  startStream(); void refreshRailState();
  clearInterval(railTimer); railTimer = setInterval(refreshRailState, 20_000);
  await switchView("overview", { force: true, focus: true });
  if (attempt === session) viewContext(revision, $("#content")).updateChrome(overview);
}

async function restoreLogin() {
  const saved = readSessionToken();
  if (!saved) return;
  $("#gate-form").hidden = true; $("#gate-resume").hidden = false;
  $("#gate-error").hidden = true;
  try { await unlockGate(saved); }
  catch (failure) {
    $("#gate-form").hidden = false; $("#gate-resume").hidden = true;
    const expired = failure instanceof ApiError && failure.code === "unauthorized";
    $("#gate-error").textContent = expired ? "登录状态已失效，请重新输入运维令牌。" : "暂时无法连接服务，可以重试恢复登录。";
    $("#gate-error").hidden = false;
    $("#gate-retry").hidden = expired;
    if (expired) $("#gate-token").focus();
  }
}

let commandReturnFocus = null;
let releaseCommandFocus = null;
let commandItems = [];
let commandIndex = 0;
function selectCommand(index) {
  commandIndex = index;
  $$(".command__item").forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
  const item = commandItems[index];
  if (item) $("#command-input").setAttribute("aria-activedescendant", `command-${item}`);
  else $("#command-input").removeAttribute("aria-activedescendant");
}
function renderCommand() {
  const query = $("#command-input").value.trim().toLowerCase();
  commandItems = Object.keys(VIEWS).filter((name) => SEARCH[name].includes(query));
  $("#command-results").replaceChildren(...commandItems.map((name, index) =>
    el("button", { class: "command__item", id: `command-${name}`, role: "option", type: "button", tabindex: "-1", "aria-selected": index === 0 ? "true" : "false", onclick: () => { closeCommand(false); void switchView(name, { focus: true }); } },
      el("span", { class: "command__icon" }, icon(ICONS[name === "infra" ? "layers" : name])),
      el("span", {}, el("strong", { text: VIEWS[name].title }), el("span", { class: "command__detail", text: VIEWS[name].lede })),
      el("kbd", { text: String(Object.keys(VIEWS).indexOf(name) + 1) }),
    )));
  if (!commandItems.length) $("#command-results").append(el("div", { class: "empty", text: "没有匹配的页面，试试“日志”或“模型”。" }));
  selectCommand(0);
}
function openCommand() {
  if (!isUnlocked() || !$("#modal").hidden) return;
  commandReturnFocus = document.activeElement;
  $("#command").hidden = false; $("#shell").inert = true;
  $("#command-input").value = ""; renderCommand();
  releaseCommandFocus = trapFocus($("#command"));
  $("#command-input").focus();
}
function closeCommand(restore = true) {
  $("#command").hidden = true; releaseCommandFocus?.(); releaseCommandFocus = null;
  $("#shell").inert = !hasToken();
  if (restore && commandReturnFocus?.isConnected) commandReturnFocus.focus();
}
$("#gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#gate-token"); const submit = $("#gate-submit"); const error = $("#gate-error");
  const candidate = input.value.trim(); if (!candidate) return;
  $("#gate-retry").hidden = true;
  submit.disabled = true; submit.firstElementChild.textContent = "正在连接…"; error.hidden = true;
  try { await unlockGate(candidate); input.value = ""; }
  catch (failure) {
    error.textContent = failure instanceof ApiError && failure.code === "unauthorized" ? "令牌不正确，请检查部署配置后重试。" : "无法连接服务，请检查网络后重试。";
    error.hidden = false; input.select();
  } finally { submit.disabled = false; submit.firstElementChild.textContent = "解锁面板"; }
});
$$(".rail__item").forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
$("#refresh").addEventListener("click", refreshCurrent);
$("#lock").addEventListener("click", () => lockGate(null));
$("#gate-retry").addEventListener("click", restoreLogin);
$("#open-command").addEventListener("click", openCommand);
$("#command-close").addEventListener("click", () => closeCommand());
$("#command-scrim").addEventListener("click", () => closeCommand());
$("#command-input").addEventListener("input", renderCommand);
$("#motion-toggle").addEventListener("click", () => {
  const modes = ["system", "full", "off"];
  document.body.dataset.motion = modes[(modes.indexOf(document.body.dataset.motion) + 1) % modes.length];
  $("#motion-label").textContent = `动效 · ${{ system: "跟随系统", full: "开启", off: "关闭" }[document.body.dataset.motion]}`;
  settleMotion();
  moveSelection($(".rail__item.is-active"));
});
function settleMotion() {
  if (!reducedMotion()) return;
  for (const animation of document.getAnimations()) {
    try { animation.finish(); } catch { animation.cancel(); }
  }
}
window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", settleMotion);
document.addEventListener("keydown", (event) => {
  if (!isUnlocked() || !$("#modal").hidden) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#command").hidden ? openCommand() : closeCommand(); return; }
  if (!$("#command").hidden) {
    if (event.key === "Escape") { event.preventDefault(); closeCommand(); }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && commandItems.length) { event.preventDefault(); selectCommand((commandIndex + (event.key === "ArrowDown" ? 1 : -1) + commandItems.length) % commandItems.length); }
    if (event.key === "Enter" && commandItems[commandIndex]) { event.preventDefault(); const name = commandItems[commandIndex]; closeCommand(false); void switchView(name, { focus: true }); }
    return;
  }
  if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable='true']")) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const name = Object.keys(VIEWS)[Number(event.key) - 1];
  if (name) { event.preventDefault(); void switchView(name, { focus: true }); }
});
new ResizeObserver(() => { if (isUnlocked()) moveSelection($(".rail__item.is-active")); }).observe($(".rail__nav"));
setInterval(() => {
  if (document.hidden || !isUnlocked() || !$("#modal").hidden || !$("#command").hidden) return;
  if (document.activeElement?.closest("input, select, textarea, [contenteditable='true']")) return;
  if (["overview", "queues", "metrics"].includes(currentView)) void refreshCurrent();
}, 45_000);
paintLiveBadge();
void restoreLogin();
