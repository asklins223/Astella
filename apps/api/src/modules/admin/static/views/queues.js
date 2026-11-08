/**
 * 任务与队列。
 *
 * ## 这一版改了什么（以及没改什么）
 *
 * 没改视觉语言：仍是一张 `.section` 玻璃卡 + 发丝线分隔的行，配色只沿用
 * 既有的 `--bad / --warn / --ink-*`，没有新增彩色边条、没有新的标题样式。
 *
 * 改的是**信息的位置**：
 *   - 原来左侧一列 17 行「选择器」每行 91px，右边常驻一个详情面板，
 *     页面 2526px 高，而右侧面板大部分时间是空的。
 *   - 现在列表就是页面主体，**点一行开抽屉**看失败分组与处置动作。
 *     抽屉关掉页面就回到原样，不用"先滚过一屏再去看详情"。
 *   - 「先看哪个」的判断交给工具条上的筛选，计数是真实分布；
 *     顺序上死信在失败/等待之前，因为它是唯一需要人工决定、不会自己消失的。
 *   - 审计从页面底部那一整块表格（约 1000px）改成同一张卡里的分段切换。
 *
 * 动作语义没动：仍然只按任务类型 retry / purge，仍然走 performJobAction
 * 的确认与数量文案；失败分组仍按原因聚合、样例才展开。
 */

import { api } from "../api-client.js";
import { formatAgo, formatCount, formatDateTime, formatDuration, formatShortDateTime } from "../format.js";
import { el, section, table, emptyState, badge, icon, openDrawer, drawerFacts, drawerSection } from "../ui.js";
import { performJobAction } from "./shared.js";

export const view = {
  title: "任务与队列", eyebrow: "BACKGROUND WORK",
  lede: "先定位积压，再看失败原因与处理动作。",
  load: loadQueues,
};

const STATUS_TONE = { dead: "bad", failed: "warn" };
const TABS = [
  { id: "jobs", label: "任务" },
  { id: "audit", label: "审计" },
];

/** 跨刷新保留：45 秒自动刷新会重建视图，筛选与分段不能跳回默认。 */
const state = { tab: "jobs", filter: "all", search: "" };

/** 总览点某一类死信时，先写好筛选再切过来。 */
export function openQueue(preset = {}) {
  state.tab = "jobs";
  if (preset.filter) state.filter = preset.filter;
  if (typeof preset.search === "string") state.search = preset.search;
}

/** 积压权重：等待 + 死信 ×1.5 + 近 24 小时失败 ×2。排序与进度条共用一处。 */
const weightOf = (row) => row.pending + row.deadTotal * 1.5 + row.failedRecent * 2;

/**
 * 一类任务落在哪个组。这是**分类**，不是配色——
 * 组的先后顺序与筛选计数已经表达了优先级。
 */
function groupOf(row) {
  if (row.deadTotal > 0) return "dead";
  if (row.failedRecent > 0) return "failed";
  if (row.pending > 0) return "pending";
  return "idle";
}

async function loadQueues(ctx) {
  const [data, audit] = await Promise.all([
    api("/queues"),
    api("/audit?limit=40").catch(() => ({ entries: [] })),
  ]);
  if (!ctx.isActive()) return el("div");

  const totals = data.totals;
  const rows = [...(data.byType ?? [])].sort((a, b) => weightOf(b) - weightOf(a));
  const groups = data.failureGroups ?? [];

  const wrap = el("div", {});

  /* ── 分段：任务 / 审计 ── */
  const tabs = el("div", { class: "seg", role: "group", "aria-label": "视图" });
  function renderTabs() {
    tabs.replaceChildren(...TABS.map((tab) => el("button", {
      class: "seg__item", type: "button", text: tab.label,
      "aria-pressed": String(state.tab === tab.id),
      onclick: () => { state.tab = tab.id; renderTabs(); paint(); },
    })));
  }

  const body = el("div", {});
  wrap.append(el("div", { style: "margin-bottom:18px" }, tabs), body);

  /* ── 任务视图 ── */
  function jobsView() {
    const counts = {
      all: rows.length,
      dead: rows.filter((row) => groupOf(row) === "dead").length,
      failed: rows.filter((row) => groupOf(row) === "failed").length,
      pending: rows.filter((row) => groupOf(row) === "pending").length,
      idle: rows.filter((row) => groupOf(row) === "idle").length,
    };
    const visible = rows.filter((row) => {
      if (state.filter !== "all" && groupOf(row) !== state.filter) return false;
      if (!state.search) return true;
      const needle = state.search.trim().toLowerCase();
      return `${row.label} ${row.jobType}`.toLowerCase().includes(needle);
    });

    const filters = [
      ["all", "全部", counts.all, ""],
      ["dead", "死信", counts.dead, "is-bad"],
      ["failed", "失败", counts.failed, "is-warn"],
      ["pending", "等待", counts.pending, ""],
      ["idle", "空闲", counts.idle, ""],
    ];

    const search = el("input", {
      class: "field__input", type: "search", value: state.search,
      placeholder: "筛选任务类型…", "aria-label": "筛选任务类型",
    });
    search.addEventListener("input", () => { state.search = search.value; paint(); });

    const tools = el("div", { class: "queue-tools" },
      el("div", { class: "chips" }, ...filters.map(([value, label, count, tone]) => el("button", {
        class: "chip", type: "button",
        "aria-pressed": String(state.filter === value),
        onclick: () => { state.filter = state.filter === value ? "all" : value; paint(); },
      }, el("span", { text: label }), el("span", { class: `chips__count ${tone}`.trim(), text: String(count) })))),
      el("div", { class: "queue-tools__search" }, search),
    );

    const list = visible.length === 0
      ? emptyState(
          state.search ? `没有匹配「${state.search}」的类型` : "这个筛选下没有任务类型",
          state.search ? "换个关键词，或清空搜索。" : "切到「全部」看完整队列。",
        )
      : el("div", { class: "queue-list" }, ...visible.map((row) => queueRow(row, ctx, groups)));

    return section("任务类型", `${formatCount(totals.deadTotal)} 条死信 · 点一行看原因并处理`,
      tools,
      visible.length === 0 ? list : el("div", {},
        el("div", { class: "ledger__head", "aria-hidden": "true" },
          el("span", { text: "类型" }),
          el("span", { text: "死信" }),
          el("span", { text: "失败" }),
          el("span", { text: "等待" }),
          el("span", { text: "最久等待" }),
          el("span", { text: "" }),
        ),
        list,
      ),
    );
  }

  /* ── 审计视图 ── */
  function auditView() {
    const entries = audit.entries ?? [];
    if (entries.length === 0) {
      return section("审计", "导出、删除、移除成员这类动作",
        emptyState("这段时间没有重要操作", "有人做了会留痕的动作时，会出现在这里。"));
    }
    return section("审计", `${entries.length} 条 · 导出、删除、移除成员这类动作`,
      el("div", { class: "table" }, table(
        ["做了什么", "对象", "详情", "什么时候"],
        entries.map((row) => [
          el("span", { class: "nowrap", text: row.label }),
          // 「空间」「笔记」这类两字标签被挤成竖排是因为列宽不够 + 允许逐字换行，
          // 给这里一个最小宽度并禁止折行。
          el("span", { class: "nowrap", text: row.targetLabel }),
          Object.entries(row.detail ?? {}).length > 0
            ? el("span", { class: "dim", style: "font-size:11.5px", text: Object.entries(row.detail).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") })
            : el("span", { class: "dim", text: "—" }),
          el("span", { class: "nowrap", title: formatDateTime(row.createdAt), text: formatShortDateTime(row.createdAt) }),
        ]),
      )),
    );
  }

  function paint() {
    body.replaceChildren(state.tab === "jobs" ? jobsView() : auditView());
  }

  renderTabs();
  paint();
  return wrap;
}

function countCell(value, tone) {
  const empty = !value;
  return el("span", {
    class: `queue-row__num${empty ? " queue-row__num--quiet" : tone ? ` queue-row__num--${tone}` : ""}`,
    text: empty ? "—" : formatCount(value),
  });
}

/** 一行任务类型。标识和失败原因在抽屉里，行上只留可比较的四个数。 */
function queueRow(row, ctx, groups) {
  return el("button", {
    class: "queue-row queue-row--ledger", type: "button",
    dataset: { jobType: row.jobType },
    onclick: () => openJobDrawer(row, ctx, groups),
  },
    el("span", { class: "queue-row__name", text: row.label }),
    countCell(row.deadTotal, "bad"),
    countCell(row.failedRecent, "warn"),
    countCell(row.pending, ""),
    el("span", {
      class: "queue-row__num queue-row__num--quiet",
      text: row.oldestPendingSeconds > 0 ? formatDuration(row.oldestPendingSeconds) : "—",
    }),
    el("span", { class: "queue-row__go" }, icon(["M9 5l7 7-7 7"], { size: 14 })),
  );
}

/** 点击行打开的详情：事实 + 失败分组（按原因聚合）+ 处置动作。 */
function openJobDrawer(row, ctx, groups) {
  const rowGroups = groups.filter((group) => group.jobType === row.jobType);

  const facts = drawerFacts([
    ["等待", formatCount(row.pending)],
    ["执行中", formatCount(row.running)],
    ["近 24h 失败", formatCount(row.failedRecent)],
    ["死信", formatCount(row.deadTotal)],
    ["最久等待", row.oldestPendingSeconds > 0 ? formatDuration(row.oldestPendingSeconds) : "—"],
    ["类型标识", row.jobType, { mono: true }],
  ]);

  const actions = el("div", { style: "display:flex;gap:9px;flex-wrap:wrap" });
  for (const [action, count, label] of [["retry", row.failedRecent, "重试失败任务"], ["purge", row.deadTotal, "清理死信"]]) {
    if (count <= 0) continue;
    const button = el("button", {
      class: `btn btn--sm${action === "purge" ? " btn--danger" : ""}`,
      type: "button",
      text: `${label} · ${formatCount(Math.min(count, 500))}`,
      onclick: async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          const done = await performJobAction({ jobType: row.jobType, label: row.label, action, count });
          if (done) { drawer.close(); await ctx.reload(); }
        } finally { button.disabled = false; }
      },
    });
    actions.append(button);
  }

  const failureSection = rowGroups.length > 0
    ? drawerSection("失败分组", `${rowGroups.length} 组 · 错误已脱敏`,
        el("div", {}, ...rowGroups.map(failureRow)))
    : drawerSection("失败分组", null,
        el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0", text: "24 小时内没有 failed / dead 的实例。" }));

  const drawer = openDrawer({
    title: row.label,
    eyebrow: row.known ? "作业类型" : "未收录的作业类型",
    sub: row.jobType,
    body: [
      facts,
      failureSection,
      el("p", { class: "k-hint", text: "动作只作用于这一类：重试会重新排队并再次调用模型；清理是永久删除，单次上界 500 条。" }),
    ],
    foot: actions.childElementCount > 0 ? [actions] : [],
  });
}

/**
 * 一条失败分组：结论一行（状态 / 原因 / 次数 / 最近），样例展开才看 id 与时间线。
 * 与旧版一致——聚合先回答"有几种病、哪种最重"。
 */
function failureRow(group) {
  const detail = el("div", { class: "disclosure__body", hidden: true },
    el("div", { class: "row", style: "gap:22px" },
      kv("样例任务", group.sample.id),
      kv("空间", group.sample.workspaceId),
      kv("尝试", `${group.sample.attempts} 次`),
      kv("首次可见", formatDateTime(group.sample.scheduledAt)),
      kv("最近失败", formatDateTime(group.lastSeen)),
    ),
    el("div", { class: "dim", style: "font-size:11.5px;margin-top:6px", text: `内部分类：${[group.category, group.name, group.code].filter(Boolean).join(" · ") || "unknown"}（原始错误不离开服务端）` }),
  );

  const toggle = el("button", {
    class: "link-btn link-btn--quiet", type: "button", text: "样例", "aria-expanded": "false",
    onclick: () => {
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? "样例" : "收起";
      toggle.setAttribute("aria-expanded", String(!detail.hidden));
    },
  });

  return el("div", { class: "disclosure" },
    el("div", { class: "row row--between", style: "padding:11px 0;gap:14px" },
      el("div", { class: "row", style: "gap:10px;flex:1;min-width:0" },
        badge(group.statusLabel, STATUS_TONE[group.status] ?? "neutral"),
        el("span", { class: "mono", style: "font-size:11.5px", text: group.summary }),
      ),
      el("div", { class: "row", style: "gap:14px;flex:none" },
        el("span", { style: "font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums", text: formatCount(group.count) }),
        el("span", { class: "dim", style: "font-size:11px", title: formatDateTime(group.lastSeen), text: formatAgo(group.lastSeen) }),
        toggle,
      ),
    ),
    detail,
  );
}

function kv(key, value) {
  return el("span", { class: "kv__item" },
    el("span", { class: "kv__k", text: key }),
    el("span", { class: "kv__v mono", style: "font-size:11.5px", text: value || "—" }),
  );
}
