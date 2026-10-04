/* ============================================================
   视图 · 基础设施（容器 / 数据库 / 对象存储）
   ------------------------------------------------------------
   版式：
     ┌─────────────┬──────────────────────────────────────┐
     │ 容器列表     │ 选中容器：仪表（CPU·内存·重启·时长）    │
     │             │ + 操作 + 事实                          │
     ├─────────────┴──────────────────────────────────────┤
     │ 容器日志（整宽、按级别着色）                            │
     ├───────────────────────┬────────────────────────────┤
     │ 数据库（PostgreSQL）    │ 对象存储（MinIO / S3）      │
     └───────────────────────┴────────────────────────────┘

   日志给整宽：容器日志是排查时真正要读的东西，塞在窄右栏里既看不清也不好扫。
   级别着色在客户端做（INFO/WARN/ERROR 是行内的文本 token，不在固定列）。

   状态文案与语气由服务端算好（tone）：一次性任务（migrate / init / seed）
   退出码 0 显示"已完成"——把它们叫"已退出"会制造并不存在的警报。
   默认选中"最需要看"的容器：第一个不健康的，都健康才回到面板自身。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatBytes, formatCount, formatDateTime, formatDuration } from "../format.js";
import { el, section, table, emptyState, badge, confirmDialog, toast } from "../ui.js";

export const view = {
  title: "基础设施",
  lede: "这套栈的容器、数据库与对象存储。选中一个容器可以看日志、做启动/停止/重启——只作用于本 compose 项目里的服务。",
  load: loadInfra,
};

const POLL_MS = 8000;
const FOLLOW_MS = 5000;
const LEVEL_TOKEN = /\b(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\b/;

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

function uptimeSeconds(container) {
  if (container.state !== "running" || !container.startedAt) return null;
  return Math.max(0, (Date.now() - new Date(container.startedAt).getTime()) / 1000);
}

function miniFigure(label, value, { unit, hint, meterRatio = null, tone = "" } = {}) {
  return el("div", { class: "mini-figure" },
    el("div", { class: "mini-figure__label", text: label }),
    el("div", { class: "mini-figure__value" }, value, unit ? el("span", { class: "mini-figure__unit", text: unit }) : null),
    meterRatio === null ? null : el("div", { class: "meter", dataset: { tone } },
      el("i", { style: `width:${Math.min(100, Math.max(1, meterRatio * 100)).toFixed(1)}%` })),
    hint ? el("div", { class: "mini-figure__hint", text: hint }) : null,
  );
}

function factRow(key, value) {
  return el("div", { class: "facts__row" },
    el("span", { class: "facts__k", text: key }),
    el("span", { class: "facts__v", text: value, style: "white-space:pre-line" }),
  );
}

/** 按级别把一行日志渲染成 [级别 token][正文]，token 单独着色。 */
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
    el("span", { class: "log-line__text", text: `${text.slice(0, start)}${text.slice(end)}` }),
  );
}

async function loadInfra(ctx) {
  const data = await api("/infra");
  const wrap = el("div", {});

  const timers = { poll: null, follow: null };
  ctx.onCleanup?.(() => {
    if (timers.poll) clearInterval(timers.poll);
    if (timers.follow) clearInterval(timers.follow);
  });

  /* ── 容器：列表 + 详情 ── */
  if (!data.docker.available) {
    wrap.append(el("div", { class: "banner banner--warn" },
      el("span", {}, `容器视图未接入：${data.docker.reason ?? "未知原因"}`)));
  } else if (data.docker.containers.length === 0) {
    wrap.append(section("容器", "0 个", emptyState("没有容器", `compose 项目 ${data.docker.project} 下没有可展示的容器。`)));
  } else {
    const split = el("div", { class: "split" });
    const list = el("div", { class: "list", role: "tablist", "aria-label": "容器" });
    const detail = el("div", { class: "detail" });
    split.append(list, detail);
    wrap.append(section("容器", `${data.docker.containers.length} 个 · 项目 ${data.docker.project}`,
      el("div", { class: "dim", style: "font-size:11.5px;margin-bottom:12px" },
        "只列出并操作本 compose 项目里的服务；启停/重启都会留下服务日志。"),
      split));

    let containers = data.docker.containers;
    // 默认选中"最需要看"的那个：第一个不健康的；都健康就选面板自己。
    let selected = containers.findIndex((c) => c.tone !== "ok");
    if (selected < 0) selected = containers.findIndex((c) => c.isSelf);
    if (selected < 0) selected = 0;

    const rowNodes = new Map();
    function paintList() {
      list.replaceChildren(...containers.map((container) => {
        let node = rowNodes.get(container.service);
        if (!node) {
          node = el("button", {
            class: "list-row", type: "button", role: "tab", "aria-pressed": "false",
            onclick: () => select(containers.findIndex((c) => c.service === container.service)),
          },
            el("span", { class: "list-row__name" },
              el("span", { class: "dot", dataset: { tone: container.tone } }),
              container.service,
              container.isSelf ? el("span", { class: "dim", style: "font-size:11px;margin-left:6px", text: "面板自身" }) : null,
            ),
            el("span", { class: "list-row__nums" }, el("span", { text: statusText(container) })),
          );
          rowNodes.set(container.service, node);
        } else {
          node.querySelector(".dot").dataset.tone = container.tone;
          node.querySelector(".list-row__nums").firstElementChild.textContent = statusText(container);
        }
        node.setAttribute("aria-pressed", String(containers[selected]?.service === container.service));
        return node;
      }));
    }

    /* 详情里可原位更新的部件 */
    const metersBox = el("div", { class: "mini-figures" });
    const actionsRow = el("div", { class: "row", style: "gap:8px" });
    const infoBox = el("div", { class: "facts" });

    function paintInfo(container) {
      infoBox.replaceChildren(
        factRow("镜像", container.image || "—"),
        factRow("状态", statusText(container)),
        factRow("启动时间", uptimeSeconds(container) === null
          ? (container.completion ? "已完成，无需运行" : "—")
          : `${formatDateTime(container.startedAt)}（${formatDuration(uptimeSeconds(container))}前）`),
        factRow("重启次数", formatCount(container.restartCount)),
        factRow("容器名", container.name),
        factRow("端口", container.ports.length > 0 ? container.ports.join("\n") : "未对外发布"),
      );
    }

    function paintDetail() {
      const container = containers[selected];
      if (!container) {
        detail.replaceChildren(el("div", { class: "empty" }, el("strong", { text: "没有可展示的容器" })));
        return;
      }
      actionsRow.replaceChildren(
        el("button", {
          class: "btn btn--sm", type: "button", text: "启动",
          disabled: container.state === "running",
          onclick: () => void runAction(container, "start"),
        }),
        el("button", {
          class: "btn btn--sm", type: "button", text: "停止",
          disabled: container.state !== "running",
          onclick: () => void runAction(container, "stop"),
        }),
        el("button", {
          class: "btn btn--sm", type: "button", text: "重启",
          disabled: container.state !== "running",
          onclick: () => void runAction(container, "restart"),
        }),
        container.isSelf ? el("span", { class: "badge badge--warn", text: "面板自身" }) : null,
      );
      paintInfo(container);

      metersPainted = false;
      detail.replaceChildren(
        el("div", { class: "detail__head" },
          el("div", {},
            el("div", { class: "detail__title", text: container.service }),
            el("div", { class: "dim", style: "font-size:11.5px;margin-top:3px", text: container.name }),
          ),
          badge(statusText(container), container.tone === "ok" ? "ok" : container.tone === "warn" ? "warn" : "bad"),
        ),
        el("div", { class: "u-mt-14" }, metersBox),
        el("div", { class: "section" },
          el("div", { class: "section__head" },
            el("span", { class: "section__label", text: "操作" }),
            el("span", { class: "section__note", text: "作用于这一个容器" }),
          ),
          actionsRow,
        ),
        el("div", { class: "section" },
          el("div", { class: "section__head" },
            el("span", { class: "section__label", text: "容器信息" }),
          ),
          infoBox,
        ),
      );
      void fetchStats(container);
    }

    let metersPainted = false;
    async function fetchStats(container, { silent = false } = {}) {
      // 首次加载给占位；轮询时保持旧值（每 8 秒闪一次"…"比暂时读旧值更糟）。
      if (!metersPainted || !silent) {
        metersBox.replaceChildren(miniFigure("CPU", "…"), miniFigure("内存", "…"));
      }
      if (container.state !== "running") {
        metersBox.replaceChildren(miniFigure("资源用量", "未运行", { hint: "容器不在运行，没有用量可读" }));
        metersPainted = true;
        return;
      }
      try {
        const stats = await api(`/infra/containers/${encodeURIComponent(container.service)}/stats`);
        const uptime = uptimeSeconds(container);
        const cpu = stats.cpuPercent;
        const memRatio = stats.memoryBytes !== null && stats.memoryLimitBytes
          ? stats.memoryBytes / stats.memoryLimitBytes : null;
        metersBox.replaceChildren(
          miniFigure("CPU", cpu === null ? "—" : cpu.toFixed(1), {
            unit: "%",
            meterRatio: cpu === null ? null : Math.min(1, cpu / 100),
            tone: (cpu ?? 0) > 80 ? "bad" : (cpu ?? 0) > 40 ? "warn" : "",
          }),
          miniFigure("内存", stats.memoryBytes === null ? "—" : formatBytes(stats.memoryBytes), {
            hint: stats.memoryLimitBytes ? `上限 ${formatBytes(stats.memoryLimitBytes)}` : null,
            meterRatio: memRatio,
            tone: (memRatio ?? 0) > 0.85 ? "warn" : "",
          }),
          miniFigure("重启次数", formatCount(container.restartCount), {
            hint: container.restartCount > 0 ? "非零说明它曾经异常退出" : "启动以来没有重启",
          }),
          miniFigure("运行时长", uptime === null ? "—" : formatDuration(uptime), {
            hint: container.state === "running" ? "本次启动至今" : "当前不在运行",
          }),
        );
        metersPainted = true;
      } catch {
        if (!metersPainted) metersBox.replaceChildren(miniFigure("资源用量", "读取失败", { hint: "下一次轮询会重试" }));
      }
    }

    async function runAction(container, action) {
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
        await api(`/infra/containers/${encodeURIComponent(container.service)}/action`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        toast(`已${verb} ${container.service}`);
        // start/restart 后容器要几秒才稳定；等一拍再刷新，避免读到过渡态。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await refresh({ full: true });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        ctx.refreshRail?.();
      } catch (error) {
        toast(error.message, "bad");
      }
    }

    function select(index) {
      if (index < 0 || index >= containers.length) return;
      selected = index;
      paintList();
      paintDetail();
      stopFollow();
      followBox.checked = false;
      void fetchLogs();
    }

    /** 轮询：原位更新列表与仪表，不重置选中。 */
    async function refresh({ full = false } = {}) {
      try {
        const next = await api("/infra");
        if (!next.docker.available) return;
        containers = next.docker.containers;
        paintList();
        const container = containers[selected];
        if (!container) return;
        if (full) {
          paintDetail();
        } else {
          paintInfo(container);
          void fetchStats(container, { silent: true });
        }
      } catch {
        /* 轮询失败保留上一屏；下一次再试 */
      }
    }

    /* ── 日志（整宽）── */
    const logView = el("div", { class: "log-view" });
    const logNote = el("span", { class: "section__note" });
    const followBox = el("input", { type: "checkbox", id: "log-follow" });
    const logRefreshBtn = el("button", { class: "link-btn link-btn--quiet", type: "button", text: "刷新" });
    let followTimer = null;
    function stopFollow() {
      if (followTimer) { clearInterval(followTimer); followTimer = null; }
      timers.follow = null;
    }
    followBox.addEventListener("change", () => {
      if (followBox.checked) {
        void fetchLogs();
        followTimer = setInterval(() => void fetchLogs(), FOLLOW_MS);
        timers.follow = followTimer;
      } else {
        stopFollow();
      }
    });
    logRefreshBtn.addEventListener("click", () => void fetchLogs());

    async function fetchLogs() {
      const container = containers[selected];
      if (!container) return;
      try {
        const result = await api(`/infra/containers/${encodeURIComponent(container.service)}/logs?tail=200`);
        logView.replaceChildren(
          ...(result.lines.length > 0
            ? result.lines.map(logLine)
            : [el("div", { class: "empty", style: "padding:20px 14px" },
                el("strong", { text: "这个容器还没有输出日志" }),
                "标准输出为空——有的服务只在启动时打一行，也有的把日志写进文件。")]),
        );
        logNote.textContent = `${container.service} · 最近 ${result.lines.length} 行${result.truncated ? "（已截断）" : ""}${followBox.checked ? " · 跟随中" : ""}`;
        logView.scrollTop = logView.scrollHeight;
      } catch (error) {
        logView.replaceChildren(el("div", { class: "empty", style: "padding:20px 14px" },
          el("strong", { text: "读取失败" }), error.message));
        logNote.textContent = "";
      }
    }

    paintList();
    paintDetail();
    void fetchLogs();
    timers.poll = setInterval(() => void refresh(), POLL_MS);

    wrap.append(section("容器日志", null,
      el("div", { class: "row row--between", style: "gap:12px" },
        logNote,
        el("div", { class: "row", style: "gap:14px;flex:none" },
          el("label", { class: "row", style: "gap:5px;font-size:12px;color:var(--ink-3);cursor:pointer" },
            followBox, el("span", { text: "跟随" })),
          logRefreshBtn,
        ),
      ),
      el("div", { class: "u-mt-10" }, logView),
    ));
  }

  /* ── 数据库 / 对象存储：并排两栏 ── */
  const bottom = el("div", { class: "cols-2" });

  const db = data.database;
  if (db.ok) {
    bottom.append(section("数据库", "PostgreSQL · 实时",
      el("div", { class: "mini-figures" },
        miniFigure("版本", db.version?.split(" ")[0] ?? "—"),
        miniFigure("库大小", db.databaseSizeBytes === null ? "—" : formatBytes(db.databaseSizeBytes)),
        miniFigure("连接", db.connections ? formatCount(db.connections.active) : "—", {
          unit: db.connections ? `/ ${formatCount(db.connections.max)}` : null,
          meterRatio: db.connections && db.connections.max > 0 ? db.connections.active / db.connections.max : null,
          tone: db.connections && db.connections.active / db.connections.max > 0.8 ? "warn" : "",
        }),
        miniFigure("启动于", db.startedAt ? formatAgo(db.startedAt) : "—", {
          // formatAgo 超过一天就退回绝对时间；那种情况下 hint 不再重复一遍。
          hint: db.startedAt && formatAgo(db.startedAt) !== formatDateTime(db.startedAt)
            ? formatDateTime(db.startedAt) : null,
        }),
      ),
      db.largestTables.length > 0
        ? el("div", { class: "table u-mt-14" },
            table(
              ["最大的表", "占用"],
              db.largestTables.map((item) => [
                el("span", { class: "mono", text: item.name }),
                formatBytes(item.bytes),
              ]),
              { numericColumns: [1] },
            ))
        : null,
    ));
  } else {
    bottom.append(section("数据库", "读取失败",
      el("div", { class: "banner banner--warn" }, `连接或查询失败：${db.error ?? "未知错误"}`)));
  }

  const storage = data.storage;
  bottom.append(section("对象存储", "MinIO / S3",
    el("div", { class: "mini-figures" },
      miniFigure("可达性", storage.reachable ? "正常" : "不可达", {
        hint: storage.reachable ? `HeadBucket 探测 ${storage.latencyMs ?? "?"} ms` : (storage.error ?? "探测失败"),
      }),
      miniFigure("凭证", storage.configured ? "已配置" : "未配置", {
        hint: storage.configured ? "与业务侧同一份凭证" : "缺 MINIO_ACCESS_KEY / MINIO_SECRET_KEY",
      }),
      miniFigure("存储桶", storage.bucket ?? "—"),
      miniFigure("端点", storage.endpoint ?? "—"),
    ),
    el("div", { class: "facts u-mt-14" },
      factRow("探测方式", "HeadBucket：凭证与桶同时验证，和业务上传走同一条路径"),
      storage.error && !storage.reachable ? factRow("错误", storage.error) : null,
    ),
  ));

  wrap.append(bottom);

  return wrap;
}
