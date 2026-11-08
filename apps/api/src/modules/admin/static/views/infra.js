/* ============================================================
   视图 · 基础设施（部署健康构成 + 密集行 + 抽屉）
   ------------------------------------------------------------
   这一版把「一列 100px 的容器选择器 + 常驻详情面板 + 整宽日志」
   换成三件更直接的东西，视觉语言不变（玻璃卡、发丝线、系统字体）：

   1. 容器列表在左，数据库和对象存储在右，同一屏能看见。
      筛选芯片负责「全部 / 异常 / 运行中 / 一次性」。
   2. 每个容器一行密行（名称 + 状态 + CPU/内存小读数），点开**抽屉**：
      事实、CPU/内存仪表、启停重启动作、最近容器日志全在里面。
      日志不再整宽铺在页面上——它只在排查某个容器时才需要。
   3. 数据库与对象存储并排（.cols-2）：连接数用仪表，最大的表用量级条，
      不再是几块等重的 mini-figure。

   动作语义一行未改：仍然是 start / stop / restart 三个白名单动词，
   仍然走同一套 confirmDialog 文案；轮询仍为 POLL_MS=8000，抽屉里的
   统计与列表在同一拍更新，不闪、不重置筛选。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatBytes, formatCount, formatDateTime, formatDuration } from "../format.js";
import { el, section, emptyState, badge, icon, confirmDialog, toast, openDrawer, drawerFacts, drawerSection } from "../ui.js";
import { meterRow, barList } from "./shared.js";

export const view = {
  title: "基础设施", eyebrow: "INFRASTRUCTURE",
  lede: "先看哪个容器不对，再点开看它的资源和日志。",
  load: loadInfra,
};

const POLL_MS = 8000;
const FOLLOW_MS = 5000;
let lastSelectedService = null;
const LEVEL_TOKEN = /\b(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\b/;

/** 跨刷新保留：筛选、搜索、一次性任务是否展开、上次选中的容器。 */
const state = { filter: "all", search: "", showOneoff: false };

/**
 * 容器分组。这是**分类**，不是配色：组的先后就是该看的先后。
 * 一次性任务（migrate / init / role-bootstrap）退出码 0 或尚未启动，
 * 它们不是故障——单独一组、默认折叠，免得把"已完成"读成"挂了"。
 */
function groupOf(container) {
  if (container.tone === "bad") return "abnormal";
  if (container.state === "restarting") return "abnormal";
  if (container.state === "running" && container.health === "unhealthy") return "abnormal";
  if (container.state === "paused") return "abnormal";
  if (container.state === "running") return "running";
  if (container.state === "created") return "oneoff";
  if (container.state === "exited") return container.completion || container.exitCode === 0 ? "oneoff" : "abnormal";
  return "oneoff";
}

const GROUPS = [
  { id: "abnormal", label: "异常容器", note: "不健康 / 重启中 / 非 0 退出", tone: "bad" },
  { id: "running", label: "运行中", note: "正常提供服务", tone: "" },
  { id: "oneoff", label: "一次性任务", note: "已经完成或等待执行，不是故障", tone: "" },
];

function statusText(container) {
  if (container.state === "running") {
    if (container.health === "unhealthy") return "不健康";
    if (container.health === "starting") return "启动中";
    return "运行中";
  }
  if (container.state === "exited") {
    return container.completion ? "已完成" : `已退出（码 ${container.exitCode ?? "?"}）`;
  }
  if (container.state === "restarting") return "重启中";
  if (container.state === "created") return "已创建";
  if (container.state === "paused") return "已暂停";
  return container.state;
}

function statusTone(container) {
  const group = groupOf(container);
  if (group === "abnormal") return "bad";
  if (container.state === "created") return "warn";
  return container.tone === "warn" ? "warn" : "ok";
}

function uptimeSeconds(container) {
  if (container.state !== "running" || !container.startedAt) return null;
  return Math.max(0, (Date.now() - new Date(container.startedAt).getTime()) / 1000);
}

/** 按级别把一行日志渲染成 [级别 token][正文]，token 单独着色（沿用旧实现）。 */
function logLine(text) {
  const match = LEVEL_TOKEN.exec(text);
  if (!match) {
    return el("div", { class: "log-line" },
      el("span", { class: "log-line__lvl", text: "" }),
      el("span", { class: "log-line__text", text }));
  }
  const level = match[1].toLowerCase();
  const start = match.index;
  const end = start + match[1].length;
  return el("div", { class: `log-line log-line--${level}` },
    el("span", { class: "log-line__lvl", text: match[1] }),
    el("span", { class: "log-line__text", text: `${text.slice(0, start)}${text.slice(end)}` }));
}

async function loadInfra(ctx) {
  const data = await api("/infra");
  if (!ctx.isActive()) return el("div");

  const wrap = el("div", {});
  const timer = { poll: null };
  ctx.onCleanup?.(() => { if (timer.poll) clearInterval(timer.poll); });

  let containers = data.docker?.containers ?? [];
  let database = data.database;
  let storage = data.storage;

  /** 每 8 秒取一次的容器用量：只拉运行中的，失败不打断页面。 */
  const stats = new Map();
  let statsInFlight = false;
  async function refreshStats() {
    if (statsInFlight) return;
    statsInFlight = true;
    try {
      const running = containers.filter((container) => container.state === "running");
      const results = await Promise.allSettled(running.map((container) =>
        api(`/infra/containers/${encodeURIComponent(container.service)}/stats`)));
      if (!ctx.isActive()) return;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") stats.set(running[index].service, result.value);
      });
      updateRowReadouts();
      if (drawerState) updateDrawerMeters();
    } finally {
      statsInFlight = false;
    }
  }

  /* ── 筛选工具条 ── */
  const filterChips = el("div", { class: "chips", role: "group", "aria-label": "按状态筛选" });
  const search = el("input", {
    class: "field__input", type: "search", value: state.search,
    placeholder: "筛选服务名或镜像…", "aria-label": "筛选服务名或镜像",
  });
  search.addEventListener("input", () => { state.search = search.value; paintList(); paintFilters(); });
  const toolsNote = el("span", { class: "queue-tools__note" });
  const tools = el("div", { class: "queue-tools" }, filterChips,
    el("div", { class: "queue-tools__search" }, search), toolsNote);

  function countsNow() {
    const counts = { all: containers.length, abnormal: 0, running: 0, oneoff: 0 };
    for (const container of containers) counts[groupOf(container)] += 1;
    return counts;
  }

  function paintFilters() {
    const counts = countsNow();
    const filters = [
      ["all", "全部", counts.all, ""],
      ["abnormal", "异常", counts.abnormal, "is-bad"],
      ["running", "运行中", counts.running, ""],
      ["oneoff", "一次性", counts.oneoff, ""],
    ];
    filterChips.replaceChildren(...filters.map(([value, label, count, tone]) => el("button", {
      class: "chip", type: "button",
      "aria-pressed": String(state.filter === value),
      onclick: () => { state.filter = state.filter === value ? "all" : value; paintList(); paintFilters(); },
    }, el("span", { text: label }), el("span", { class: `chips__count ${tone}`.trim(), text: String(count) }))));
    toolsNote.textContent = counts.abnormal > 0
      ? `${counts.all} 个服务 · ${counts.abnormal} 个需要看`
      : `${counts.all} 个服务 · 没有异常`;
  }

  /* ── 容器列表：按组排，组内密行 ── */
  const listBox = el("div", {});
  const rowReadoutNodes = new Map();
  function updateRowReadouts() {
    for (const [service, node] of rowReadoutNodes) {
      const container = containers.find((item) => item.service === service);
      const stat = stats.get(service);
      node.textContent = readoutText(container, stat);
      node.dataset.tone = readoutTone(stat) ?? "";
    }
  }

  function readoutText(container, stat) {
    // 非运行中的容器没有资源读数：返回空串，行里就不留一个孤零零的「—」。
    if (!container || container.state !== "running") return "";
    if (!stat) return "资源读取中…";
    const mem = stat.memoryBytes === null || stat.memoryLimitBytes === null
      ? formatBytes(stat.memoryBytes)
      : `${formatBytes(stat.memoryBytes)} / ${formatBytes(stat.memoryLimitBytes)}`;
    const cpu = stat.cpuPercent === null ? "—" : `${stat.cpuPercent.toFixed(1)}%`;
    return `CPU ${cpu} · 内存 ${mem}`;
  }

  function readoutTone(stat) {
    if (!stat) return null;
    const cpu = stat.cpuPercent ?? 0;
    const memRatio = stat.memoryBytes !== null && stat.memoryLimitBytes ? stat.memoryBytes / stat.memoryLimitBytes : 0;
    if (cpu > 80 || memRatio > 0.85) return "is-bad";
    if (cpu > 40 || memRatio > 0.7) return "is-warn";
    return null;
  }

  function visibleContainers() {
    const needle = state.search.trim().toLowerCase();
    return containers.filter((container) => {
      const group = groupOf(container);
      if (state.filter === "all") {
        // 「全部」下一次性任务是折叠的：它们是已完成的事，不占版面。
        if (group === "oneoff" && !state.showOneoff) return false;
      } else if (group !== state.filter) return false;
      if (!needle) return true;
      return `${container.service} ${container.name} ${container.image}`.toLowerCase().includes(needle);
    });
  }

  function containerRow(container) {
    const group = groupOf(container);
    const tone = statusTone(container);
    const readoutTextValue = readoutText(container, stats.get(container.service));
    const readout = readoutTextValue
      ? el("span", { class: "dim", style: "font-size:10.5px;font-weight:400", text: readoutTextValue })
      : null;
    if (readout) {
      readout.dataset.tone = readoutTone(stats.get(container.service)) ?? "";
      rowReadoutNodes.set(container.service, readout);
    }
    const metaBits = [
      container.image || "—",
      container.ports.length > 0 ? container.ports.join("、") : null,
    ].filter(Boolean).join(" · ");
    return el("button", {
      class: "queue-row", type: "button",
      onclick: () => openContainerDrawer(container.service),
    },
      el("span", { style: "display:block;min-width:0" },
        el("span", { class: "queue-row__name" },
          el("span", { class: "dot", dataset: { tone } }),
          container.service,
          container.isSelf ? el("span", { class: "dim", style: "font-size:11px;margin-left:6px", text: "面板自身" }) : null),
        el("span", { class: "queue-row__meta", text: metaBits }),
      ),
      el("span", { style: "display:grid;gap:2px;justify-items:end;min-width:0" },
        el("span", { class: "queue-row__num", text: statusText(container) }),
        readout),
      el("span", { class: "queue-row__go" }, icon(["M9 5l7 7-7 7"], { size: 14 })),
    );
  }

  function paintList() {
    rowReadoutNodes.clear();
    const visible = visibleContainers();
    if (visible.length === 0) {
      listBox.replaceChildren(emptyState(
        state.search ? `没有匹配「${state.search}」的服务` : "这个筛选下没有容器",
        state.search ? "换个关键词，或清空搜索。" : "切到「全部」看完整列表。",
      ));
      return;
    }

    const blocks = GROUPS.map((group) => {
      const rows = visible.filter((container) => groupOf(container) === group.id);
      if (rows.length === 0) return null;
      const head = el("div", { class: "k-sec", style: "margin:18px 0 4px" },
        el("h3", { text: `${group.label} · ${rows.length}` }),
        el("span", { text: group.note }),
      );
      // 「全部」下一次性任务默认折叠：给一个明确入口，而不是永远消失。
      const toggle = group.id === "oneoff" && state.filter === "all"
        ? el("button", {
            class: "link-btn link-btn--quiet", type: "button",
            text: state.showOneoff ? "收起" : `展开 ${rows.length} 个已完成任务`,
            "aria-expanded": String(state.showOneoff),
            onclick: () => { state.showOneoff = !state.showOneoff; paintList(); },
          })
        : null;
      return el("div", {},
        el("div", { class: "row row--between", style: "align-items:baseline" },
          head, toggle ? el("div", {}, toggle) : null),
        ...rows.map(containerRow),
      );
    }).filter(Boolean);
    listBox.replaceChildren(...blocks);
  }

  /* ── 容器抽屉：事实 + 仪表 + 动作 + 日志 ── */
  let drawerState = null;
  function openContainerDrawer(service) {
    const container = containers.find((item) => item.service === service);
    if (!container) return;
    lastSelectedService = service;
    drawerState?.close?.();

    const factsBox = el("div", {});
    const metersBox = el("div", {});
    const logsBox = el("div", { class: "log-view" }, el("div", { class: "skeleton" }));
    const logNote = el("span", { class: "section__note" });
    const followBox = el("input", { type: "checkbox", id: `infra-log-follow-${service}` });
    const logsRefresh = el("button", { class: "link-btn link-btn--quiet", type: "button", text: "刷新" });
    let followTimer = null;
    let logsRevision = 0;

    function stopFollow() { if (followTimer) { clearInterval(followTimer); followTimer = null; } }
    function current() { return containers.find((item) => item.service === service); }

    function paintFacts() {
      const item = current();
      if (!item) return;
      const uptime = uptimeSeconds(item);
      factsBox.replaceChildren(drawerFacts([
        ["状态", statusText(item)],
        ["镜像", item.image || "—"],
        ["启动时间", uptime === null
          ? (item.completion ? "已完成，无需运行" : "—")
          : `${formatDateTime(item.startedAt)}（${formatDuration(uptime)}前）`],
        ["重启次数", formatCount(item.restartCount)],
        ["容器名", item.name, { mono: true }],
        ["端口", item.ports.length > 0 ? item.ports.join("；") : "未对外发布"],
      ]));
    }

    function paintMeters() {
      const item = current();
      if (!item) return;
      if (item.state !== "running") {
        metersBox.replaceChildren(el("p", { class: "dim", style: "font-size:12px;margin:4px 0 0",
          text: item.state === "created" ? "容器还没启动，没有用量可读。" : "容器不在运行，没有用量可读。" }));
        return;
      }
      const stat = stats.get(service);
      if (!stat) {
        metersBox.replaceChildren(el("p", { class: "dim", style: "font-size:12px;margin:4px 0 0", text: "正在读取容器用量…" }));
        return;
      }
      const memRatio = stat.memoryBytes !== null && stat.memoryLimitBytes ? stat.memoryBytes / stat.memoryLimitBytes : null;
      metersBox.replaceChildren(
        meterRow({
          label: "CPU",
          value: stat.cpuPercent === null ? null : Math.min(1, stat.cpuPercent / 100),
          detail: stat.cpuPercent === null ? null : `${stat.cpuPercent.toFixed(1)}%`,
          warnAt: 0.4,
          badAt: 0.8,
        }),
        meterRow({
          label: "内存",
          value: memRatio,
          detail: stat.memoryLimitBytes ? `${formatBytes(stat.memoryBytes)} / ${formatBytes(stat.memoryLimitBytes)}` : formatBytes(stat.memoryBytes),
          warnAt: 0.7,
          badAt: 0.85,
        }),
      );
    }

    async function fetchLogs() {
      const item = current();
      if (!item) return;
      const requestId = ++logsRevision;
      try {
        const result = await api(`/infra/containers/${encodeURIComponent(service)}/logs?tail=200`);
        if (!ctx.isActive() || requestId !== logsRevision || !drawerState || drawerState.service !== service) return;
        logsBox.replaceChildren(...(result.lines.length > 0
          ? result.lines.map(logLine)
          : [el("div", { class: "empty", style: "padding:20px 14px" },
              el("strong", { text: "这个容器还没有输出日志" }),
              "标准输出为空——有的服务只在启动时打一行，也有的把日志写进文件。")]));
        logNote.textContent = `最近 ${result.lines.length} 行${result.truncated ? "（已截断）" : ""}${followBox.checked ? " · 跟随中" : ""}`;
        logsBox.scrollTop = logsBox.scrollHeight;
      } catch (error) {
        if (!ctx.isActive() || requestId !== logsRevision || !drawerState || drawerState.service !== service) return;
        logsBox.replaceChildren(el("div", { class: "empty", style: "padding:20px 14px" },
          el("strong", { text: "读取失败" }), error.message));
      }
    }

    followBox.addEventListener("change", () => {
      if (followBox.checked) {
        void fetchLogs();
        followTimer = setInterval(() => void fetchLogs(), FOLLOW_MS);
      } else stopFollow();
    });
    logsRefresh.addEventListener("click", () => void fetchLogs());

    const actions = el("div", { style: "display:flex;gap:9px;flex-wrap:wrap" });
    function paintActions() {
      const item = current();
      if (!item) return;
      actions.replaceChildren(...[
        el("button", {
          class: "btn btn--sm", type: "button", text: "启动",
          disabled: item.state === "running",
          onclick: () => void runAction(item.service, "start"),
        }),
        el("button", {
          class: "btn btn--sm", type: "button", text: "停止",
          disabled: item.state !== "running",
          onclick: () => void runAction(item.service, "stop"),
        }),
        el("button", {
          class: "btn btn--sm", type: "button", text: "重启",
          disabled: item.state !== "running",
          onclick: () => void runAction(item.service, "restart"),
        }),
        item.isSelf ? badge("面板自身", "warn") : null,
      ].filter(Boolean));
    }

    const drawer = openDrawer({
      title: container.service,
      eyebrow: container.isSelf ? "面板自身 · 容器" : "容器",
      sub: container.name,
      body: [
        factsBox,
        drawerSection("资源用量", "CPU 与内存有上限，贴上限才会出问题", metersBox),
        drawerSection("操作", "作用于这一个容器", actions),
        drawerSection("最近日志", "tail 200 · 只在需要排查时读",
          el("div", { class: "row row--between", style: "gap:12px;margin-bottom:8px" },
            logNote,
            el("div", { class: "row", style: "gap:14px;flex:none" },
              el("label", { class: "row", style: "gap:5px;font-size:12px;color:var(--ink-3);cursor:pointer" },
                followBox, el("span", { text: "跟随" })),
              logsRefresh)),
          logsBox),
      ],
      foot: [],
    });

    drawerState = {
      service,
      close: () => { stopFollow(); drawer.close(); drawerState = null; },
      update: () => { paintFacts(); paintMeters(); paintActions(); },
      stopFollow,
    };
    // openDrawer 的关闭键/遮罩不经过我们包一层：这里挂一次性 keydown 监听不合适，
    // 所以改为在 wrap 的清理里统一 stopFollow，并在关闭后由 openDrawer 复位。
    paintFacts();
    paintMeters();
    paintActions();
    void fetchLogs();
  }

  function updateDrawerMeters() {
    drawerState?.update?.();
  }

  /* ── 容器动作：confirmDialog 文案与旧版逐字一致 ── */
  async function runAction(service, action) {
    const container = containers.find((item) => item.service === service);
    if (!container) return;
    const verb = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
    const ok = await confirmDialog({
      title: `${verb} ${container.service}？`,
      body: container.isSelf
        ? `${verb}这个容器会断开当前面板页面几秒，随后自动恢复。确认继续？`
        : action === "stop"
          ? "停止后依赖它的功能会不可用，直到再次启动。确认继续？"
          : action === "restart"
            ? `重启会短暂中断它的服务（重启期间请求会失败）。确认继续？`
            : `启动 ${container.service}。`,
      confirmLabel: verb,
      tone: action === "start" ? "primary" : "danger",
    });
    if (!ok) return;
    try {
      await api(`/infra/containers/${encodeURIComponent(service)}/action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      toast(`已${verb} ${service}`);
      // start/restart 后容器要几秒才稳定；等一拍再刷新，避免读到过渡态。
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await refresh();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      ctx.refreshRail?.();
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ── 轮询：原位重建列表与构成，不重置筛选与抽屉 ── */
  async function refresh() {
    try {
      const next = await api("/infra");
      if (!ctx.isActive() || !next.docker?.available) return;
      containers = next.docker.containers;
      database = next.database;
      storage = next.storage;
      paintFilters();
      paintList();
      paintDatabase();
      paintStorage();
      drawerState?.update?.();
      void refreshStats();
    } catch {
      /* 轮询失败保留上一屏；下一次再试 */
    }
  }

  /* ── 数据库：连接仪表 + 最大的表 ── */
  const databaseBox = el("div", {});
  function paintDatabase() {
    const db = database;
    if (!db.ok) {
      databaseBox.replaceChildren(el("div", { class: "banner banner--warn" }, `连接或查询失败：${db.error ?? "未知错误"}`));
      return;
    }
    const ratio = db.connections && db.connections.max > 0 ? db.connections.active / db.connections.max : null;
    databaseBox.replaceChildren(
      meterRow({
        label: "连接",
        value: ratio,
        detail: db.connections ? `${formatCount(db.connections.active)} / ${formatCount(db.connections.max)}` : null,
        warnAt: 0.8,
        badAt: 0.95,
      }),
      el("div", { class: "facts", style: "margin-top:6px" },
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "版本" }),
          el("span", { class: "facts__v", text: db.version?.split(" ")[0] ?? "—" })),
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "库大小" }),
          el("span", { class: "facts__v", text: db.databaseSizeBytes === null ? "—" : formatBytes(db.databaseSizeBytes) })),
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "启动于" }),
          el("span", { class: "facts__v", text: db.startedAt ? formatAgo(db.startedAt) : "—" })),
      ),
      db.largestTables.length > 0
        ? el("div", { style: "margin-top:14px" },
            el("div", { class: "k-sec", style: "margin-bottom:4px" },
              el("h3", { style: "font-size:13px", text: "最大的表" }),
              el("span", { text: "条长 = 占用空间" })),
            barList(db.largestTables.map((table) => ({
              key: table.name,
              label: table.name,
              value: table.bytes,
              note: formatBytes(table.bytes),
            })), {}))
        : null,
    );
  }

  /* ── 对象存储：状态读数 + 可达性，不是四块等重卡片 ── */
  const storageBox = el("div", {});
  function paintStorage() {
    const children = [
      el("div", { class: "row", style: "gap:8px;margin-bottom:2px" },
        badge(storage.reachable ? "可达" : "不可达", storage.reachable ? "ok" : "bad"),
        badge(storage.configured ? "凭证已配置" : "凭证缺失", storage.configured ? "neutral" : "warn"),
        el("span", { class: "section__note", text: storage.reachable
          ? `HeadBucket 探测 ${storage.latencyMs ?? "?"} ms`
          : (storage.error ?? "探测失败") }),
      ),
      el("div", { class: "facts", style: "margin-top:6px" },
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "存储桶" }),
          el("span", { class: "facts__v", text: storage.bucket ?? "—" })),
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "端点" }),
          el("span", { class: "facts__v", text: storage.endpoint ?? "—" })),
        el("div", { class: "facts__row" },
          el("span", { class: "facts__k", text: "探测方式" }),
          el("span", { class: "facts__v", style: "font-family:var(--font);text-align:left", text: "HeadBucket：凭证与桶同时验证，和业务上传走同一条路径" })),
      ),
      storage.error && !storage.reachable ? el("div", { class: "banner banner--warn u-mt-14" }, storage.error) : null,
    ];
    storageBox.replaceChildren(...children.filter(Boolean));
  }

  /* ── 组装 ── */
  const dockerSection = el("div", {});
  if (!data.docker?.available) {
    dockerSection.append(section("容器", "未接入",
      el("div", { class: "banner banner--warn" }, `容器视图未接入：${data.docker?.reason ?? "未知原因"}`)));
  } else if (containers.length === 0) {
    dockerSection.append(section("容器", "0 个", emptyState("没有容器", `compose 项目 ${data.docker.project} 下没有可展示的容器。`)));
  } else {
    dockerSection.append(section("容器", "点一行看用量与日志",
      tools, listBox));
  }

  wrap.append(el("div", { class: "infra-stage" },
    dockerSection,
    el("div", { class: "infra-stage__side" },
      section("数据库", "PostgreSQL · 实时", databaseBox),
      section("对象存储", "MinIO / S3", storageBox),
    ),
  ));
  paintFilters();
  paintList();
  paintDatabase();
  paintStorage();
  void refreshStats();
  timer.poll = setInterval(() => void refresh(), POLL_MS);

  return wrap;
}
