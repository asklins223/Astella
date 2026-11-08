/** Overview: service verdict and actionable issues lead; telemetry supports the decision. */
import { api } from "../api-client.js";
import { formatBytes, formatCount, formatDuration, formatLatency, formatPercent, formatRateValue } from "../format.js";
import { el, section, emptyState, icon, ICONS } from "../ui.js";
import { SERIES_COLORS, seriesChart, performJobAction, todoItemCard } from "./shared.js";
import { openQueue } from "./queues.js";

export const view = {
  title: "总览", eyebrow: "AT A GLANCE",
  lede: "从全局看见状态，从这里开始处理。",
  load: loadOverview,
};
function splitTodo(data) {
  return { urgent: data.items.filter((item) => item.severity !== "info"), later: data.items.filter((item) => item.severity === "info") };
}
function verdictOf({ errorsPerMinute, deadTotal, queuePending, oldestPendingSeconds, lagSeconds, requestsPerMinute, blockingCount, incomplete }) {
  if (incomplete) return { tone: "warn", sentence: "部分状态暂不可用", body: "有数据未能读回。下方保留已知读数，重新刷新后再确认完整状态。", action: { view: "logs", label: "查看实时日志" } };
  if (blockingCount > 0) return { tone: "block", sentence: `${blockingCount} 项配置需要关注`, body: "部分模型功能受到影响。下方「优先处理」里列了具体原因与处理入口。", action: { view: "config", label: "查看模型配置" } };
  if (errorsPerMinute !== null && errorsPerMinute > 0.5) return { tone: "bad", sentence: "服务出现请求失败", body: `最近每分钟约 ${formatRateValue(errorsPerMinute)} 次失败，打开日志可以定位具体请求。`, action: { view: "logs", label: "查看实时日志" } };
  // 死信是唯一「系统不会自己处理、只能由人决定」的量，它必须出现在判词里——
  // 否则页面顶部会写着「一切运行如常」，而侧栏挂着三位数的死信角标。
  if (deadTotal > 0) return { tone: "warn", sentence: `${formatCount(deadTotal)} 条死信等待决定`, body: "重试用尽的任务不会自己消失：要么重试再试一轮，要么清理。清理不可逆，所以留给你判断。", action: { view: "queues", label: "去任务与队列" } };
  if (queuePending > 0 && oldestPendingSeconds > 900) return { tone: "warn", sentence: "后台任务正在积压", body: `${formatCount(queuePending)} 个任务等待执行，最久已等待 ${formatDuration(oldestPendingSeconds)}。`, action: { view: "queues", label: "去任务与队列" } };
  if (lagSeconds > 0.5) return { tone: "warn", sentence: "服务响应有所放缓", body: `事件循环延迟 ${formatDuration(lagSeconds)}，可以从性能指标继续排查。`, action: { view: "metrics", label: "查看性能指标" } };
  if (requestsPerMinute === null) return { tone: "neutral", sentence: "服务已连接，等待采样", body: "还没有足够的请求速率读数。曲线积累后，可在这里确认当前运行表现。", action: { view: "logs", label: "查看实时日志" } };
  return { tone: "ok", sentence: requestsPerMinute === 0 ? "一切就绪，当前很安静。" : "一切运行如常。", body: requestsPerMinute === 0 ? "服务已连接，这段时间没有收到请求。" : `最近每分钟处理约 ${formatRateValue(requestsPerMinute)} 次请求，服务保持正常运行。`, action: { view: "logs", label: "查看实时日志" } };
}
/** 状态带里的一格：小标签 + 读数，整格可点去对应页面。 */
function bandItem({ label, value, unit, tone = "", destination, ctx }) {
  return el("button", {
    class: "band__item", type: "button", dataset: { tone },
    onclick: () => ctx.switchView(destination),
    "aria-label": `${label} ${value}${unit ?? ""}，查看${destination === "queues" ? "任务与队列" : "指标"}`,
  },
    el("span", { class: "band__label", text: label }, icon(["M9 5l7 7-7 7"], { size: 12 })),
    el("span", { class: "band__value" }, value, unit ? el("small", { text: unit }) : null),
  );
}
function factsRow(key, value) {
  return el("div", { class: "facts__row" }, el("span", { class: "facts__k", text: key }), el("span", { class: "facts__v", text: value }));
}
async function loadOverview(ctx) {
  const [overview, metrics, series, todo, queues] = await Promise.all([
    api("/overview"), api("/metrics"), api("/metrics/series").catch(() => null), api("/todo").catch(() => null), api("/queues").catch(() => null),
  ]);
  if (!ctx.isActive()) return el("div");
  ctx.updateChrome(overview);
  const points = series?.points ?? [];
  const last = points.at(-1);
  const h = metrics.headline;
  const release = overview.release ?? {};
  const deadTotal = queues?.totals.deadTotal ?? 0;
  const verdict = verdictOf({ errorsPerMinute: last?.errorsPerMinute ?? null, deadTotal, queuePending: last?.queuePending ?? queues?.totals.pending ?? null,
    oldestPendingSeconds: queues?.totals.oldestPendingSeconds ?? null, lagSeconds: last?.eventLoopLagSeconds ?? null,
    requestsPerMinute: last?.requestsPerMinute ?? null, blockingCount: todo?.counts.block ?? 0, incomplete: !todo || !queues || !series });
  const wrap = el("div", { class: "overview" });
  const successRate = h.httpSuccessRate;
  const band = el("div", { class: "band", role: "group", "aria-label": "核心读数" },
    bandItem({ label: "请求速率", value: formatRateValue(last?.requestsPerMinute ?? null), unit: "次/分", destination: "metrics", ctx }),
    bandItem({ label: "响应 p95", value: formatLatency(last?.p95Seconds ?? null), tone: (last?.p95Seconds ?? 0) > 1 ? "warn" : "", destination: "metrics", ctx }),
    bandItem({ label: "失败请求", value: formatRateValue(last?.errorsPerMinute ?? null), unit: "次/分", tone: (last?.errorsPerMinute ?? 0) > 0 ? "bad" : "", destination: "metrics", ctx }),
    bandItem({ label: "等待任务", value: queues ? formatCount(queues.totals.pending) : "—", tone: (queues?.totals.pending ?? 0) > 20 ? "warn" : "", destination: "queues", ctx }),
    bandItem({ label: "死信", value: queues ? formatCount(deadTotal) : "—", tone: deadTotal > 0 ? "bad" : "", destination: "queues", ctx }),
    bandItem({ label: "成功率", value: successRate == null ? "—" : formatPercent(successRate), tone: successRate == null ? "" : successRate < 0.99 ? "bad" : "ok", destination: "metrics", ctx }),
  );
  const health = el("section", { class: "health", dataset: { tone: verdict.tone }, "aria-label": "系统运行状态" },
    el("div", { class: "health__main" },
      el("div", { class: "health__content" },
        el("span", { class: "health__label" }, el("i", { "aria-hidden": "true" }), "系统状态"),
        el("h2", { class: "health__title", text: verdict.sentence }),
        el("p", { class: "health__body", text: verdict.body }),
        el("div", { class: "health__meta" },
          el("span", { class: "meta", text: overview.service.nodeEnv === "production" ? "正式环境" : "开发环境" }),
          el("span", { class: "meta", text: `已运行 ${formatDuration(overview.service.uptimeSeconds)}` }),
          el("span", { class: "meta", text: release.version ?? "dev" }),
        ),
        el("div", { class: "health__actions" },
          el("button", { class: "btn btn--primary", type: "button", onclick: () => ctx.switchView(verdict.action.view) },
            icon(verdict.action.view === "config" ? ICONS.config : verdict.action.view === "queues" ? ICONS.queues : ICONS.logs, { size: 16 }), verdict.action.label),
          el("button", { class: "link-btn", type: "button", text: "查看基础设施 →", onclick: () => ctx.switchView("infra") }),
        ),
      ),
    ),
    band,
  );
  const urgentSlot = el("div");
  const deadSlot = el("div");
  async function repaintTodo() {
    const fresh = await api("/todo").catch(() => null);
    if (fresh && ctx.isActive()) { paintBoard(fresh); ctx.refreshRail(); }
  }
  function paintBoard(todoData) {
    if (!todoData) {
      urgentSlot.replaceChildren();
      deadSlot.replaceChildren(section("待清理的死信", "未能读取", emptyState("暂时无法确认待办", "刷新页面后重试。")));
      return;
    }
    const { urgent, later } = splitTodo(todoData);
    urgentSlot.replaceChildren(...(urgent.length
      ? [section("需要你决定", `${urgent.length} 件需要处理`,
          el("div", { class: "task-list" }, ...urgent.map((item) => todoItemCard(item, { onAction: (target) => onTodoAction(target, ctx, repaintTodo) }))))]
      : []));
    deadSlot.replaceChildren(later.length
      ? deadLetterSection(later, ctx)
      : section("待清理的死信", "当前为空", emptyState("没有待清理的死信", "重试用尽的任务会出现在这里。", "good")));
  }
  paintBoard(todo);
  const runtime = section("运行资源", `Node ${overview.service.nodeVersion}`, el("div", { class: "facts" },
    factsRow("数据库连接", h.dbPoolActive == null ? "—" : `${formatCount(h.dbPoolActive)}${overview.database.poolMax ? ` / ${overview.database.poolMax}` : ""}`),
    factsRow("堆内存", formatBytes(h.heapUsedBytes)), factsRow("事件循环", last?.eventLoopLagSeconds == null ? "—" : `${Math.round(last.eventLoopLagSeconds * 1000)} ms`),
    factsRow("结算积压", formatCount(h.outboxPendingTotal)), factsRow("RLS 拒绝", formatCount(h.dbRlsDenied)), factsRow("日志缓冲", `${overview.logBuffer.app.size} / ${overview.logBuffer.app.capacity}`),
  ));
  const usage = queues
    ? section("使用情况", "部署内累计 · 会话为当前活跃", el("div", { class: "usage" },
        ...[["用户", queues.counts.usersTotal], ["学习空间", queues.counts.workspacesTotal], ["有效笔记", queues.counts.notesActive], ["活跃会话", queues.counts.sessionsActive]].map(([label, value]) =>
          el("div", { class: "usage__item" }, el("span", { text: label }), el("strong", { text: formatCount(value) })))))
    : null;
  wrap.append(health, urgentSlot, el("div", { class: "overview__stage" }, deadSlot, el("div", { class: "overview__aside" }, runtime, usage)));

  const trends = section("性能走势", series?.spanMs ? `最近 ${formatDuration(series.spanMs / 1000)}` : "正在采样");
  trends.classList.add("overview__trends");
  const featured = (series?.series ?? []).filter((meta) => ["requestsPerMinute", "p95Seconds"].includes(meta.key));
  if (points.length >= 2 && featured.length) {
    trends.append(el("div", { class: "overview__charts" }, ...featured.map((meta) => el("div", { class: "chart-cell" },
      el("div", { class: "chart-cell__head" }, el("span", { class: "chart-cell__title", title: meta.hint, text: meta.label }),
        el("span", { class: "chart-cell__now", text: meta.key === "requestsPerMinute" ? `${formatRateValue(last?.[meta.key] ?? null)} 次/分` : formatLatency(last?.[meta.key] ?? null) })),
      seriesChart({ points, key: meta.key, label: meta.label, color: SERIES_COLORS[meta.key], unit: meta.unit, tall: true }),
    ))));
  } else trends.append(emptyState("正在积累曲线", "每 15 秒采样一次，数据足够后会显示走势。"));
  trends.append(el("button", { class: "link-btn overview__all-metrics", type: "button", text: "探索全部指标 →", onclick: () => ctx.switchView("metrics") }));
  wrap.append(trends);
  return wrap;
}

/* ── 待办区（可原位重绘）────────────────────────────────── */

async function onTodoAction(item, ctx, repaint) {
  if (item.action.kind === "goto_config") return ctx.switchView("config");
  if (item.action.kind === "goto_queues") return ctx.switchView("queues");
  const done = await performJobAction({
    jobType: item.action.jobType,
    label: item.title,
    action: item.action.kind === "purge_dead" ? "purge" : "retry",
    count: item.count ?? 0,
  });
  if (done) await repaint();
}

/** 死信台账：总览只排前几类，点一行去队列页并带上这一类的筛选。清理留在抽屉里。 */
function deadLetterSection(later, ctx) {
  const total = later.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const ranked = [...later].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const shown = ranked.slice(0, 8);
  const rows = shown.map((item) => {
    const name = item.title.replace(/ 有 \d+ 条重试用尽$/, "");
    const jobType = item.action?.jobType ?? "";
    return el("button", {
      class: "queue-row", type: "button",
      onclick: () => {
        openQueue({ filter: "dead", search: jobType || name });
        ctx.switchView("queues");
      },
    },
      el("span", { class: "queue-row__name", text: name }),
      el("span", { class: "queue-row__num queue-row__num--bad", text: `${formatCount(item.count ?? 0)} 条` }),
      el("span", { class: "queue-row__go" }, icon(["M9 5l7 7-7 7"], { size: 14 })),
    );
  });
  return section("待清理的死信", `${later.length} 类 · ${formatCount(total)} 条`,
    el("p", { class: "dim", style: "font-size:12px;margin:0 0 4px", text: "重试用尽，系统不会再碰。点一行去处理这一类。" }),
    el("div", {}, ...rows),
    el("button", {
      class: "link-btn", type: "button",
      text: ranked.length > shown.length ? `其余 ${ranked.length - shown.length} 类在任务与队列 →` : "在任务与队列里处理 →",
      onclick: () => { openQueue({ filter: "dead", search: "" }); ctx.switchView("queues"); },
    }),
  );
}
