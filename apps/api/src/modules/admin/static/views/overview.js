/* ============================================================
   视图 · 总览（工作台）
   ------------------------------------------------------------
   版式按"读的顺序"排，目标是**一屏之内**给出完整判断：

     页头带（常驻）：状态句 + 环境/版本/运行时长 + 两个动作
     数值排：        速率 / p95 / 失败 / 排队 / 成功率
     三栏：          待办（要做什么）│ 走势（两张主曲线）│ 现场（队列与资源的事实）

   数字不套卡片：大号等宽数字 + 微标签 + 发丝线，层次就成立；再套框是噪音。
   ============================================================ */

import { api } from "../api-client.js";
import {
  formatBytes, formatCount, formatDuration, formatLatency,
  formatPercent, formatRateValue,
} from "../format.js";
import { el, section, emptyState, confirmDialog, toast } from "../ui.js";
import { SERIES_COLORS, seriesChart, performJobAction, todoItemCard } from "./shared.js";

export const view = {
  title: "总览",
  lede: "服务现在怎么样、有多少人在用。要处理的事按轻重列在左边，走势在中间——更多曲线在「指标」。",
  load: loadOverview,
};

function splitTodo(data) {
  return {
    urgent: data.items.filter((item) => item.severity !== "info"),
    later: data.items.filter((item) => item.severity === "info"),
  };
}

function verdictOf({ errorsPerMinute, queuePending, oldestPendingSeconds, lagSeconds, requestsPerMinute, recentActivity, blockingCount }) {
  if (blockingCount > 0) {
    return {
      tone: "block",
      sentence: `有 ${blockingCount} 项配置问题`,
      body: "模型密钥没配或配置有错误，对应功能现在调用会失败。先处理下面「需要你处理」的第一条。",
    };
  }
  if (errorsPerMinute !== null && errorsPerMinute > 0.5) {
    return {
      tone: "bad",
      sentence: "有服务在报错",
      body: `最近每分钟约 ${formatRateValue(errorsPerMinute)} 次失败。用户操作可能会失败，建议先去「日志」看最上面几条。`,
    };
  }
  if (queuePending !== null && queuePending > 0 && oldestPendingSeconds > 900) {
    return {
      tone: "warn",
      sentence: "后台任务堵住了",
      body: `有 ${formatCount(queuePending)} 个任务在排队，最久的已经等了 ${formatDuration(oldestPendingSeconds)}。功能不会立刻坏，但会变慢。`,
    };
  }
  if (lagSeconds !== null && lagSeconds > 0.5) {
    return {
      tone: "warn",
      sentence: "服务响应变慢",
      body: `事件循环延迟 ${formatDuration(lagSeconds)}，请求在排队等 CPU。用户会感觉到「点了没反应」。`,
    };
  }
  if (requestsPerMinute !== null && requestsPerMinute === 0) {
    return {
      tone: "",
      sentence: "一切正常，当前没人在用",
      body: recentActivity
        ? "服务是活的，刚测完使用情况，现在正好安静下来——这不是故障。"
        : "服务是活的，只是这段时间没有收到请求。这不是故障。",
    };
  }
  return {
    tone: "",
    sentence: "一切正常",
    body: requestsPerMinute !== null
      ? `服务正常运行，最近每分钟约 ${formatRateValue(requestsPerMinute)} 次操作，没有报错。`
      : "服务正常运行，没有报错。",
  };
}

function figure(label, value, { unit, hint, tone = "", empty = false, id } = {}) {
  return el("div", { class: `figure${tone ? ` figure--${tone}` : ""}` },
    el("div", { class: "figure__label", text: label }),
    el("div", { class: `figure__value${empty ? " figure__value--empty" : ""}`, dataset: id ? { statId: id } : {} },
      value,
      unit ? el("span", { class: "figure__unit", text: unit }) : null,
    ),
    hint ? el("div", { class: "figure__hint", text: hint }) : null,
  );
}

function factsRow(key, value, { dim = false } = {}) {
  return el("div", { class: "facts__row" },
    el("span", { class: "facts__k", text: key }),
    el("span", { class: `facts__v${dim ? " facts__v--dim" : ""}`, text: value }),
  );
}

async function loadOverview(ctx) {
  const [overview, metrics, series, todo, queues] = await Promise.all([
    api("/overview"),
    api("/metrics"),
    api("/metrics/series").catch(() => ({ points: [], series: [], spanMs: 0 })),
    api("/todo").catch(() => ({ items: [], counts: { total: 0, block: 0, warn: 0, info: 0 } })),
    api("/queues").catch(() => null),
  ]);

  ctx.updateChrome?.(overview);

  const points = series.points ?? [];
  const last = points.length ? points[points.length - 1] : null;
  const h = metrics.headline;
  const release = overview.release ?? {};

  /* ── 页头带：状态句与运行现场（滚动时保持可见）── */
  const v = verdictOf({
    errorsPerMinute: last?.errorsPerMinute ?? null,
    queuePending: last?.queuePending ?? queues?.totals.pending ?? null,
    oldestPendingSeconds: queues?.totals.oldestPendingSeconds ?? null,
    lagSeconds: last?.eventLoopLagSeconds ?? null,
    requestsPerMinute: last?.requestsPerMinute ?? null,
    recentActivity: points.some((p) => (p.requestsPerMinute ?? 0) > 0),
    blockingCount: todo.counts.block,
  });
  ctx.setHeadExtra?.(
    el("div", { class: "sentence", dataset: { tone: v.tone || "ok" }, text: v.sentence }),
    el("p", { class: "sentence__body", text: v.body }),
    el("div", { class: "head-meta" },
      el("span", { class: "meta", text: overview.service.nodeEnv === "production" ? "正式环境" : "开发环境" }),
      el("span", { class: "meta", text: `${release.version ?? "dev"}${release.commit ? ` · ${release.commit.slice(0, 7)}` : ""}` }),
      el("span", { class: "meta", text: `已运行 ${formatDuration(overview.service.uptimeSeconds)}` }),
      el("span", { class: "meta", text: `Node ${overview.service.nodeVersion}` }),
    ),
  );
  ctx.setHeadActions?.(
    el("button", { class: "btn btn--sm", type: "button", text: "模型配置", onclick: () => ctx.switchView("config") }),
    el("button", { class: "btn btn--sm", type: "button", text: "查日志", onclick: () => ctx.switchView("logs") }),
  );

  const wrap = el("div", {});

  /* ── 数值排 ── */
  const successRate = h.httpSuccessRate;
  wrap.append(el("div", { class: "figures" },
    figure("请求速率", formatRateValue(last?.requestsPerMinute ?? null), {
      unit: "次/分", hint: "每分钟打到服务的操作数", empty: last?.requestsPerMinute == null, id: "ov-rate",
    }),
    figure("响应耗时 p95", formatLatency(last?.p95Seconds ?? null), {
      hint: "95% 的操作快于这个时间",
      tone: (last?.p95Seconds ?? 0) > 1 ? "warn" : "",
      empty: last?.p95Seconds == null, id: "ov-lat",
    }),
    figure("失败速率", formatRateValue(last?.errorsPerMinute ?? null), {
      unit: "次/分",
      hint: (last?.errorsPerMinute ?? 0) > 0 ? "用户操作失败的频率" : "当前没有失败请求",
      tone: (last?.errorsPerMinute ?? 0) > 0 ? "bad" : "ok",
      empty: last?.errorsPerMinute == null, id: "ov-err",
    }),
    figure("排队任务", queues ? formatCount(queues.totals.pending) : "—", {
      hint: queues && queues.totals.pending === 0 ? "队列是空的" : "排在后台等执行",
      tone: (queues?.totals.pending ?? 0) > 20 ? "warn" : "",
      empty: !queues, id: "ov-queue",
    }),
    figure("成功率", successRate === null ? "—" : formatPercent(successRate), {
      hint: successRate === null ? "还没有请求" : "没有 5xx 的请求占比",
      tone: successRate === null ? "" : successRate < 0.99 ? "bad" : "ok",
      empty: successRate === null, id: "ov-success",
    }),
  ));

  /* ── 三栏：待办 │ 走势 │ 现场 ── */
  const board = el("div", { class: "board u-mt-14" });

  const todoArea = el("div", {});
  async function repaintTodo() {
    const data = await api("/todo").catch(() => null);
    if (data) {
      todoArea.replaceChildren(...buildTodoSections(data, ctx, repaintTodo));
      ctx.refreshRail?.();
    }
  }
  todoArea.append(...buildTodoSections(todo, ctx, repaintTodo));
  board.append(todoArea);

  const trends = el("div", {});
  const featured = (series.series ?? []).filter((meta) => ["requestsPerMinute", "p95Seconds"].includes(meta.key));
  if (points.length >= 2 && featured.length > 0) {
    trends.append(section("走势", series.spanMs ? `最近 ${formatDuration(series.spanMs / 1000)}` : null,
      ...featured.map((meta) => el("div", { class: "chart-cell" },
        el("div", { class: "chart-cell__head" },
          el("span", { class: "chart-cell__title", title: meta.hint, text: meta.label }),
          el("button", { class: "link-btn link-btn--quiet", type: "button", text: "全部 →", onclick: () => ctx.switchView("metrics") }),
        ),
        seriesChart({ points, key: meta.key, color: SERIES_COLORS[meta.key], unit: meta.unit }),
      )),
    ));
  } else {
    trends.append(section("走势", "采样中",
      emptyState("正在积累数据", "面板每 15 秒采一次点，几分钟后这里会出现曲线。")));
  }
  board.append(trends);

  board.append(section("运行现场", null, el("div", { class: "facts" },
    factsRow("数据库连接", h.dbPoolActive === null ? "—" : `${formatCount(h.dbPoolActive)}${overview.database.poolMax ? ` / ${overview.database.poolMax}` : ""}`),
    factsRow("结算积压", formatCount(h.outboxPendingTotal)),
    factsRow("RLS 拒绝", formatCount(h.dbRlsDenied)),
    factsRow("事件循环", last?.eventLoopLagSeconds == null ? "—" : `${Math.round(last.eventLoopLagSeconds * 1000)} ms`),
    factsRow("堆内存", formatBytes(h.heapUsedBytes)),
    factsRow("活跃会话", queues ? formatCount(queues.counts.sessionsActive) : "—"),
    factsRow("日志缓冲", `${overview.logBuffer.app.size}/${overview.logBuffer.app.capacity}`, { dim: true }),
  )));

  wrap.append(board);
  return wrap;
}

/* ── 待办区（可原位重绘）────────────────────────────────── */

function buildTodoSections(todo, ctx, repaint) {
  const { urgent, later } = splitTodo(todo);
  const sections = [
    section(
      todo.counts.block > 0 ? "有事需要你处理" : "需要你处理",
      urgent.length > 0 ? `${urgent.length} 件` : "当前为空",
      el("div", { class: "task-list" },
        urgent.length > 0
          ? urgent.map((item) => todoItemCard(item, { onAction: (target) => onTodoAction(target, ctx, repaint) }))
          : [emptyState("没有需要你处理的事", "失败任务、积压和配置问题都没有。它们一旦出现，会带着动作出现在这里。", "good")],
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
    class: "link-btn link-btn--danger", type: "button", text: "全部清理",
    onclick: async () => {
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

  return section("可以顺手清掉", `${later.length} 类 · ${formatCount(total)} 条`,
    el("div", { class: "row row--between", style: "gap:12px" },
      el("span", { class: "dim", style: "font-size:12px", text: "重试用尽、系统不会再碰的残留" }),
      el("div", { class: "row", style: "flex:none;gap:16px" }, toggle, purgeAll),
    ),
    body,
  );
}
