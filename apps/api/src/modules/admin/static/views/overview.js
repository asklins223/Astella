/* ============================================================
   视图 · 总览（指挥台）
   ------------------------------------------------------------
   构图原则：**仪器占主区，行动在左，数字挂在物体上**。

     ┌──────────┬───────────────────────────────────────────┐
     │ 需要你处理 │   服务之心（舞台，占满剩余高度）              │
     │ 可以顺手清 │     · 结论牌钉在左上                        │
     │ 业务规模  │     · 请求速率 / p95 / 错误 投影挂在核心旁    │
     │ 部署      │     · 队列环每根柱顶挂"类型 数量"，可点选      │
     │           │   ── 底部读数横带（放不进仪器的数字）──        │
     └──────────┴───────────────────────────────────────────┘

   这里**没有 KPI 卡片网格**：仪器画过的读数（速率/延迟/积压/错误）不在页面上
   再出现一次；横带只放仪器表达不了的离散数字（成功率、RLS、内存…）。
   趋势图也不在这里——那是「指标」页的图墙，总览回答"现在"，指标回答"走势"。
   ============================================================ */

import { api } from "../api-client.js";
import {
  formatBytes, formatCount, formatDuration, formatLatency,
  formatNumber, formatPercent, formatRateValue,
} from "../format.js";
import { el, section, emptyState, confirmDialog, toast } from "../ui.js";
import { performJobAction, todoItemCard } from "./shared.js";

export const view = {
  title: "总览",
  lede: "服务现在怎么样、有多少人在用。仪器上的每一束粒子都是真实流量——环上每根柱是一类任务的积压，点它进任务与队列。",
  load: loadOverview,
};

export function splitTodo(data) {
  return {
    urgent: data.items.filter((item) => item.severity !== "info"),
    later: data.items.filter((item) => item.severity === "info"),
  };
}

function verdictOf({ errorsPerMinute, queuePending, oldestPendingSeconds, lagSeconds, requestsPerMinute, recentActivity, blockingCount }) {
  if (blockingCount > 0) {
    return {
      tone: "block", title: `有 ${blockingCount} 项配置问题`,
      body: "模型密钥没配或配置有错误，对应功能现在调用会失败。先处理左侧「需要你处理」的第一条。",
    };
  }
  if (errorsPerMinute !== null && errorsPerMinute > 0.5) {
    return {
      tone: "bad", title: "有服务在报错",
      body: `最近每分钟约 ${formatRateValue(errorsPerMinute)} 次失败。用户操作可能会失败，红粒子的比例就是它。`,
    };
  }
  if (queuePending !== null && queuePending > 0 && oldestPendingSeconds > 900) {
    return {
      tone: "warn", title: "后台任务堵住了",
      body: `有 ${formatCount(queuePending)} 个任务在排队，最久的已经等了 ${formatDuration(oldestPendingSeconds)}。相关的功能会延迟。`,
    };
  }
  if (lagSeconds !== null && lagSeconds > 0.5) {
    return {
      tone: "warn", title: "服务响应变慢",
      body: `事件循环延迟 ${formatDuration(lagSeconds)}，请求在排队等 CPU。用户会感觉到「点了没反应」。`,
    };
  }
  if (requestsPerMinute !== null && requestsPerMinute === 0) {
    return {
      tone: "", title: "一切正常，当前没人在用",
      body: recentActivity
        ? "服务是活的。刚测完使用情况，现在正好安静下来——这不是故障。"
        : "服务是活的，只是这段时间没有收到请求。这不是故障。",
    };
  }
  return {
    tone: "",
    title: "一切正常",
    body: requestsPerMinute !== null
      ? `服务正常运行，最近每分钟约 ${formatRateValue(requestsPerMinute)} 次操作，没有报错。`
      : "服务正常运行，没有报错。",
  };
}

const VERDICT_HEALTH = { block: "block", bad: "bad", warn: "warn", "": "ok" };

/** 读数横带的一项。 */
function readout(key, value, tone = "") {
  return el("div", { class: "readout__item" },
    el("span", { class: "readout__k", text: key }),
    el("span", {
      class: `readout__v${tone ? ` readout__v--${tone}` : ""}${value === "—" ? " readout__v--empty" : ""}`,
      dataset: { statId: `readout-${key}` },
      text: value,
    }),
  );
}

function factsRow(key, value) {
  return el("div", { class: "facts__row" },
    el("span", { class: "facts__k", text: key }),
    el("span", { class: "facts__v", text: value }),
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
  const lastPoint = points.length ? points[points.length - 1] : null;
  const h = metrics.headline;

  const wrap = el("div", {});
  const deck = el("div", { class: "deck" });

  /* ── 左列：行动与事实 ── */
  const aside = el("div", { class: "deck__aside" });

  const todoArea = el("div", {});
  async function repaintTodo() {
    const data = await api("/todo").catch(() => null);
    if (data) todoArea.replaceChildren(buildTodoSections(data, ctx, repaintTodo));
  }
  todoArea.append(...buildTodoSections(todo, ctx, repaintTodo));
  aside.append(todoArea);

  if (queues) {
    const counts = queues.counts;
    aside.append(section("业务规模", "跨全部空间", el("div", { class: "facts" },
      factsRow("用户", formatNumber(counts.usersTotal)),
      factsRow("学习空间", formatNumber(counts.workspacesTotal)),
      factsRow("活跃笔记", formatNumber(counts.notesActive)),
      factsRow("任务累计", formatNumber(counts.jobsTotal)),
      factsRow("学习运行", formatNumber(counts.runsTotal)),
      factsRow("活跃会话", formatNumber(counts.sessionsActive)),
    )));
  }

  const release = overview.release ?? {};
  aside.append(section("部署", null, el("div", { class: "facts" },
    factsRow("运行环境", overview.service.nodeEnv === "production" ? "正式" : "开发/测试"),
    factsRow("版本", `${release.version ?? "dev"}${release.commit ? ` · ${release.commit.slice(0, 7)}` : ""}`),
    factsRow("Node", overview.service.nodeVersion),
    factsRow("配置文件", overview.config.exists ? "已就位" : "未找到"),
    factsRow("日志缓冲", `${overview.logBuffer.app.size}/${overview.logBuffer.app.capacity}`),
    factsRow("请求缓冲", `${overview.logBuffer.requests.size}/${overview.logBuffer.requests.capacity}`),
  )));
  deck.append(aside);

  /* ── 右主区：仪器舞台 ── */
  const main = el("div", { class: "deck__main" });
  const stage = el("div", { class: "stage stage--tall", id: "overview-stage" });
  stage.append(el("div", { class: "hud-layer", id: "overview-hud" }));
  main.append(stage);

  // 结论牌：一句话，钉在舞台左上（不投影——跟着物体走反而难读）。
  const v = verdictOf({
    errorsPerMinute: lastPoint?.errorsPerMinute ?? null,
    queuePending: lastPoint?.queuePending ?? queues?.totals.pending ?? null,
    oldestPendingSeconds: queues?.totals.oldestPendingSeconds ?? null,
    lagSeconds: lastPoint?.eventLoopLagSeconds ?? null,
    requestsPerMinute: lastPoint?.requestsPerMinute ?? null,
    recentActivity: (series.points ?? []).some((p) => (p.requestsPerMinute ?? 0) > 0),
    blockingCount: todo.counts.block,
  });
  ctx.onVerdict?.(VERDICT_HEALTH[v.tone] ?? "ok");
  stage.append(
    el("div", { class: "hud-verdict", dataset: { tone: v.tone || "ok" } },
      el("h2", { class: "hud-verdict__title", text: v.title }),
      el("p", { class: "hud-verdict__body", text: v.body }),
    ),
    el("div", { class: "hud-actions" },
      el("button", { class: "btn btn--sm", type: "button", text: "模型配置", onclick: () => ctx.switchView("config") }),
      el("button", { class: "btn btn--sm", type: "button", text: "查日志", onclick: () => ctx.switchView("logs") }),
    ),
  );

  // 读数横带：仪器表达不了的离散数字。
  const successRate = h.httpSuccessRate;
  stage.append(el("div", { class: "readout" },
    readout("成功率", successRate === null ? "—" : formatPercent(successRate),
      successRate === null ? "" : successRate < 0.99 ? "bad" : "ok"),
    readout("5xx 累计", formatCount(h.httpErrors5xxTotal), h.httpErrors5xxTotal > 0 ? "warn" : ""),
    readout("结算积压", formatCount(h.outboxPendingTotal), (h.outboxOldestPendingSeconds ?? 0) > 120 ? "warn" : ""),
    readout("数据库连接", h.dbPoolActive === null ? "—" : formatCount(h.dbPoolActive)),
    readout("RLS 拒绝", formatCount(h.dbRlsDenied), h.dbRlsDenied > 0 ? "warn" : "ok"),
    readout("事件循环", lastPoint?.eventLoopLagSeconds == null ? "—" : `${Math.round(lastPoint.eventLoopLagSeconds * 1000)} ms`,
      (lastPoint?.eventLoopLagSeconds ?? 0) > 0.5 ? "warn" : ""),
    readout("堆内存", formatBytes(h.heapUsedBytes)),
  ));

  deck.append(main);
  wrap.append(deck);

  /* ── 接仪器：先挂场景，再按数据摆标签 ── */
  ctx.mountScene?.(stage, "overview");

  const topRows = (queues?.byType ?? []).slice(0, 18);
  ctx.setQueue?.(topRows);

  const hud = stage.querySelector("#overview-hud");
  const labels = [];

  // 核心旁的三块投影读数。
  const rateLabel = el("div", { class: "hud hud--ok" },
    el("span", { class: "hud__k", text: "请求" }),
    el("span", { class: "hud__v", text: formatRateValue(lastPoint?.requestsPerMinute ?? null) }),
    el("span", { class: "hud__k", text: "次/分" }),
  );
  const latencyLabel = el("div", { class: `hud${(lastPoint?.p95Seconds ?? 0) > 1 ? " hud--warn" : ""}` },
    el("span", { class: "hud__k", text: "p95" }),
    el("span", { class: "hud__v", text: formatLatency(lastPoint?.p95Seconds ?? null) }),
  );
  labels.push({ key: "rate", el: rateLabel }, { key: "latency", el: latencyLabel });

  const errorsPerMinute = lastPoint?.errorsPerMinute ?? 0;
  let errorsLabel = null;
  if (errorsPerMinute > 0) {
    errorsLabel = el("div", { class: "hud hud--bad" },
      el("span", { class: "hud__k", text: "错误" }),
      el("span", { class: "hud__v", text: formatRateValue(errorsPerMinute) }),
      el("span", { class: "hud__k", text: "次/分" }),
    );
    labels.push({ key: "errors", el: errorsLabel });
  }

  // 环上最重的 5 根柱挂「类型 数量」标签；点它 = 进队列页并选中。
  const top5 = topRows.slice(0, 5);
  top5.forEach((row, index) => {
    const weight = row.pending + row.deadTotal + row.failedRecent;
    const tone = row.deadTotal > 0 ? "bad" : row.failedRecent > 0 ? "warn" : "";
    const label = el("button", {
      class: `hud hud--bar${tone ? ` hud--${tone}` : ""}`,
      type: "button",
      title: `${row.label}：等待 ${row.pending} · 在做 ${row.running} · 失败 ${row.failedRecent} · 停 ${row.deadTotal}`,
      onclick: () => {
        ctx.setFocusJobType?.(row.jobType);
        ctx.switchView("queues");
      },
    },
      el("span", { class: "hud__v", text: formatCount(weight) }),
      el("span", { class: "hud__k", text: row.label }),
    );
    labels.push({ key: `bar:${index}`, el: label });
  });

  // 先塞进 HUD 层，再交给场景投影（顺序：先 DOM 后注册）。
  for (const { el: node } of labels) hud.append(node);
  ctx.setLabels?.(labels);

  // 仪器点柱 → 同样跳队列页选中。
  ctx.onCleanup?.(ctx.onBarSelect?.((row) => {
    ctx.setFocusJobType?.(row.jobType);
    ctx.switchView("queues");
  }) ?? (() => {}));

  if (topRows.length === 0) {
    // 没有队列数据时给一句解释，而不是让空舞台自说自话。
    stage.append(el("div", { class: "empty", style: "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3" },
      el("strong", { text: "队列是空的" }),
      "没有等待或失败的任务——仪器安静是好事。",
    ));
  }

  return wrap;
}

/* ── 待办区（可原位重绘）────────────────────────────────── */

function buildTodoSections(todo, ctx, repaint) {
  const { urgent, later } = splitTodo(todo);
  const sections = [
    section(
      todo.counts.block > 0 ? "有事需要你处理" : "需要你处理",
      urgent.length > 0 ? `${urgent.length} 件` : "当前为空",
      el("div", { class: "todo-list" },
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
  const body = el("div", { class: "todo-list u-mt-8", hidden: true });
  const toggle = el("button", {
    class: "btn btn--sm", type: "button", text: "展开明细", "aria-expanded": "false",
    onclick: () => {
      const expanded = body.hidden;
      body.hidden = !expanded;
      toggle.textContent = expanded ? "收起明细" : "展开明细";
      toggle.setAttribute("aria-expanded", String(expanded));
    },
  });
  const purgeAll = el("button", {
    class: "btn btn--sm", type: "button", text: "全部清理",
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

  return section("可以顺手清掉", `${later.length} 类 · ${formatCount(total)} 条 · 不紧急`,
    el("div", { class: "row row--between", style: "gap:10px" },
      el("span", { class: "dim", style: "font-size:11.5px", text: `重试用尽、系统不会再碰的残留` }),
      el("div", { class: "row", style: "flex:none" }, toggle, purgeAll),
    ),
    body,
  );
}
