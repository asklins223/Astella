/** Overview: service verdict and actionable issues lead; telemetry supports the decision. */
import { api } from "../api-client.js";
import { formatBytes, formatCount, formatDuration, formatLatency, formatPercent, formatRateValue } from "../format.js";
import { el, section, emptyState, confirmDialog, toast, icon, ICONS } from "../ui.js";
import { SERIES_COLORS, seriesChart, performJobAction, todoItemCard } from "./shared.js";

export const view = {
  title: "总览", eyebrow: "AT A GLANCE",
  lede: "从全局看见状态，从这里开始处理。",
  load: loadOverview,
};
function splitTodo(data) {
  return { urgent: data.items.filter((item) => item.severity !== "info"), later: data.items.filter((item) => item.severity === "info") };
}
function verdictOf({ errorsPerMinute, queuePending, oldestPendingSeconds, lagSeconds, requestsPerMinute, blockingCount, incomplete }) {
  if (incomplete) return { tone: "warn", sentence: "部分状态暂不可用", body: "有数据未能读回。下方保留已知读数，重新刷新后再确认完整状态。" };
  if (blockingCount > 0) return { tone: "block", sentence: `${blockingCount} 项配置需要关注`, body: "部分模型功能受到影响。右侧列出了具体原因与处理入口。" };
  if (errorsPerMinute !== null && errorsPerMinute > 0.5) return { tone: "bad", sentence: "服务出现请求失败", body: `最近每分钟约 ${formatRateValue(errorsPerMinute)} 次失败，打开日志可以定位具体请求。` };
  if (queuePending > 0 && oldestPendingSeconds > 900) return { tone: "warn", sentence: "后台任务正在积压", body: `${formatCount(queuePending)} 个任务等待执行，最久已等待 ${formatDuration(oldestPendingSeconds)}。` };
  if (lagSeconds > 0.5) return { tone: "warn", sentence: "服务响应有所放缓", body: `事件循环延迟 ${formatDuration(lagSeconds)}，可以从性能指标继续排查。` };
  if (requestsPerMinute === null) return { tone: "neutral", sentence: "服务已连接，等待采样", body: "还没有足够的请求速率读数。曲线积累后，可在这里确认当前运行表现。" };
  return { tone: "ok", sentence: requestsPerMinute === 0 ? "一切就绪，当前很安静。" : "一切运行如常。", body: requestsPerMinute === 0 ? "服务已连接，这段时间没有收到请求。" : `最近每分钟处理约 ${formatRateValue(requestsPerMinute)} 次请求，服务保持正常运行。` };
}
function figure(label, value, { unit, hint, tone = "", id, destination, ctx } = {}) {
  return el("button", { class: `figure${tone ? ` figure--${tone}` : ""}`, type: "button", onclick: () => ctx.switchView(destination), "aria-label": `${label} ${value}${unit ?? ""}，查看${destination === "queues" ? "任务与队列" : "指标"}` },
    el("div", { class: "figure__label" }, label, icon(["M9 5l7 7-7 7"], { size: 14 })),
    el("div", { class: "figure__value", dataset: { statId: id } }, value, unit ? el("span", { class: "figure__unit", text: unit }) : null),
    el("div", { class: "figure__hint", text: hint }),
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
  const verdict = verdictOf({ errorsPerMinute: last?.errorsPerMinute ?? null, queuePending: last?.queuePending ?? queues?.totals.pending ?? null,
    oldestPendingSeconds: queues?.totals.oldestPendingSeconds ?? null, lagSeconds: last?.eventLoopLagSeconds ?? null,
    requestsPerMinute: last?.requestsPerMinute ?? null, blockingCount: todo?.counts.block ?? 0, incomplete: !todo || !queues || !series });
  const wrap = el("div", { class: "overview" });
  const health = el("section", { class: "health", dataset: { tone: verdict.tone }, "aria-label": "系统运行状态" },
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
        el("button", { class: "btn btn--primary", type: "button", onclick: () => ctx.switchView(verdict.tone === "block" ? "config" : "logs") },
          icon(verdict.tone === "block" ? ICONS.config : ICONS.logs, { size: 16 }), verdict.tone === "block" ? "查看模型配置" : "查看实时日志"),
        el("button", { class: "link-btn", type: "button", text: "查看基础设施 →", onclick: () => ctx.switchView("infra") }),
      ),
    ),
    el("div", { class: "health__orb", "aria-hidden": "true" }, el("div", { class: "health__orbit" }), el("div", { class: "health__core" }, icon(verdict.tone === "ok" ? ICONS.check : verdict.tone === "neutral" ? ICONS.clock : ICONS.alert, { size: 46, strokeWidth: 1.4 }))),
  );
  const tasks = el("div", { class: "overview__tasks" });
  async function repaintTodo() {
    const fresh = await api("/todo").catch(() => null);
    if (fresh && ctx.isActive()) { tasks.replaceChildren(...buildTodoSections(fresh, ctx, repaintTodo)); ctx.refreshRail(); }
  }
  if (todo) tasks.append(...buildTodoSections(todo, ctx, repaintTodo));
  else tasks.append(section("优先处理", "未能读取", emptyState("暂时无法确认待办", "刷新页面后重试。")));
  wrap.append(el("div", { class: "overview__hero" }, health, tasks));

  const successRate = h.httpSuccessRate;
  wrap.append(el("div", { class: "figures overview__figures" },
    figure("请求速率", formatRateValue(last?.requestsPerMinute ?? null), { unit: "次/分", hint: "当前服务流量", id: "ov-rate", destination: "metrics", ctx }),
    figure("响应耗时 p95", formatLatency(last?.p95Seconds ?? null), { hint: "95% 的操作快于这个时间", tone: (last?.p95Seconds ?? 0) > 1 ? "warn" : "", id: "ov-lat", destination: "metrics", ctx }),
    figure("失败请求", formatRateValue(last?.errorsPerMinute ?? null), { unit: "次/分", hint: "最近一分钟的失败速率", tone: last?.errorsPerMinute == null ? "" : last.errorsPerMinute > 0 ? "bad" : "ok", id: "ov-err", destination: "metrics", ctx }),
    figure("等待任务", queues ? formatCount(queues.totals.pending) : "—", { hint: queues?.totals.pending === 0 ? "队列已清空" : "等待后台执行", tone: (queues?.totals.pending ?? 0) > 20 ? "warn" : "", id: "ov-queue", destination: "queues", ctx }),
    figure("请求成功率", successRate == null ? "—" : formatPercent(successRate), { hint: "没有 5xx 的请求占比", tone: successRate == null ? "" : successRate < 0.99 ? "bad" : "ok", id: "ov-success", destination: "metrics", ctx }),
  ));

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
  const runtime = section("运行资源", `Node ${overview.service.nodeVersion}`, el("div", { class: "facts" },
    factsRow("数据库连接", h.dbPoolActive == null ? "—" : `${formatCount(h.dbPoolActive)}${overview.database.poolMax ? ` / ${overview.database.poolMax}` : ""}`),
    factsRow("堆内存", formatBytes(h.heapUsedBytes)), factsRow("事件循环", last?.eventLoopLagSeconds == null ? "—" : `${Math.round(last.eventLoopLagSeconds * 1000)} ms`),
    factsRow("结算积压", formatCount(h.outboxPendingTotal)), factsRow("RLS 拒绝", formatCount(h.dbRlsDenied)), factsRow("日志缓冲", `${overview.logBuffer.app.size} / ${overview.logBuffer.app.capacity}`),
  ));
  runtime.classList.add("overview__runtime");
  wrap.append(el("div", { class: "overview__telemetry" }, trends, runtime));
  if (queues) wrap.append(section("使用情况", "部署内累计 · 会话为当前活跃", el("div", { class: "usage" },
    ...[["用户", queues.counts.usersTotal], ["学习空间", queues.counts.workspacesTotal], ["有效笔记", queues.counts.notesActive], ["活跃会话", queues.counts.sessionsActive]].map(([label, value]) =>
      el("div", { class: "usage__item" }, el("span", { text: label }), el("strong", { text: formatCount(value) }))),
  )));
  return wrap;
}

/* ── 待办区（可原位重绘）────────────────────────────────── */

function buildTodoSections(todo, ctx, repaint) {
  const { urgent, later } = splitTodo(todo);
  const sections = [
    section(
      "优先处理",
      urgent.length > 0 ? `${urgent.length} 件` : "当前为空",
      el("div", { class: "task-list" },
        urgent.length > 0
          ? urgent.map((item) => todoItemCard(item, { onAction: (target) => onTodoAction(target, ctx, repaint) }))
          : [emptyState("没有待处理事项", "新出现的失败、积压与配置问题会显示在这里。", "good")],
      ),
    ),
  ];
  if (later.length > 0) sections.push(laterSection(later, repaint));
  return sections;
}

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

function laterSection(later, onChanged) {
  const total = later.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const batchLimit = later.reduce((sum, item) => sum + Math.min(item.count ?? 0, 500), 0);
  const body = el("div", { class: "task-list u-mt-8", hidden: true });
  const toggle = el("button", {
    class: "link-btn link-btn--quiet", type: "button", text: "展开明细", "aria-expanded": "false",
    onclick: () => {
      const expanded = body.hidden;
      body.hidden = !expanded;
      toggle.textContent = expanded ? "收起明细" : "展开明细";
      toggle.setAttribute("aria-expanded", String(expanded));
    },
  });
  const purgeAll = el("button", {
    class: "link-btn link-btn--danger", type: "button", text: "批量清理",
    onclick: async () => {
      const ok = await confirmDialog({
        title: "分批清理这些死信？",
        body: `${later.length} 类任务，按类型各处理最多 500 条，本次合计最多 ${formatCount(batchLimit)} 条。将永久删除且不可恢复，失败原因也会一并消失。`,
        confirmLabel: `删除最多 ${formatCount(batchLimit)} 条`,
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
            body: JSON.stringify({ jobType: item.action.jobType, action: "purge", limit: Math.max(1, Math.min(item.count ?? 0, 500)) }),
          });
          affected += result.affected ?? 0;
        } catch {
          failed += 1;
        }
      }
      toast(
        failed > 0 ? `已清理 ${formatCount(affected)} 条，${failed} 类失败（看日志）` : `已清理 ${formatCount(affected)} 条`,
        failed > 0 ? "bad" : "ok",
      );
      await onChanged();
    },
  });

  body.append(...later.map((item) => todoItemCard(item, {
    onAction: async (target) => {
      const done = await performJobAction({
        jobType: target.action.jobType,
        label: target.title,
        action: "purge",
        count: target.count ?? 0,
      });
      if (done) await onChanged();
    },
  })));

  return section("待清理的死信", `${later.length} 类 · ${formatCount(total)} 条`,
    el("div", { class: "row row--between", style: "gap:12px" },
      el("span", { class: "dim", style: "font-size:12px", text: "重试用尽、系统不会再碰的残留" }),
      el("div", { class: "row", style: "flex:none;gap:16px" }, toggle, purgeAll),
    ),
    body,
  );
}
