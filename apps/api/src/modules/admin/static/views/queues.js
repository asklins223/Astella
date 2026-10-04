/* ============================================================
   视图 · 任务与队列（主从）
   ------------------------------------------------------------
   左列表是**选择器**：每类任务一行，带积压比例条与关键数字，按积压权重排序；
   右详情是**被选中那类**的失败分组与动作。这样"哪一类最堵"和"这一类怎么
   了"同屏——不用在两张表之间来回滚动对照。

   失败按原因聚合而不是逐条平铺：20 行「记忆提取 · unknown · Error」读不出
   结论；聚合先回答"有几种病、哪种最重"，展开才到单条样例。
   动作边界钉在服务端（0366）：只碰 failed / dead、必须指定类型、上界 500。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatCount, formatDateTime, formatDuration, formatShortDateTime } from "../format.js";
import { el, section, table, emptyState, badge } from "../ui.js";
import { performJobAction } from "./shared.js";

export const view = {
  title: "任务与队列",
  lede: "服务在后台替用户做的事。左边按积压排序列出每类任务——点一行，看这一类为什么堵、失败在哪一步。",
  load: loadQueues,
};

const STATUS_TONE = { dead: "bad", failed: "warn" };

/** 记住上次选中的任务类型：45 秒自刷新重建视图时不该把选中跳回第一条。 */
let lastSelectedJobType = null;

/** 与后续权重计算保持一处：黑点/排序都用它。 */
function weightOf(row) {
  return row.pending + row.deadTotal * 1.5 + row.failedRecent * 2;
}

function toneOf(row) {
  if (row.deadTotal > 0) return "bad";
  if (row.failedRecent > 0) return "warn";
  if (row.running > 0) return "info";
  return "";
}

function figure(label, value, { hint, tone = "", empty = false, id } = {}) {
  return el("div", { class: `figure${tone ? ` figure--${tone}` : ""}` },
    el("div", { class: "figure__label", text: label }),
    el("div", { class: `figure__value${empty ? " figure__value--empty" : ""}`, dataset: id ? { statId: id } : {} }, value),
    hint ? el("div", { class: "figure__hint", text: hint }) : null,
  );
}

async function loadQueues(ctx) {
  const [data, audit] = await Promise.all([
    api("/queues"),
    api("/audit?limit=40").catch(() => ({ entries: [] })),
  ]);
  const t = data.totals;
  const rows = [...(data.byType ?? [])].sort((a, b) => weightOf(b) - weightOf(a));
  const groups = data.failureGroups ?? [];
  const wrap = el("div", {});

  /* ── 总量 ── */
  wrap.append(el("div", { class: "figures" },
    figure("等待中", formatCount(t.pending), {
      hint: t.pending === 0 ? "队列是空的" : "排在后台等着执行",
      tone: t.pending > 20 ? "warn" : "", id: "q-pending",
    }),
    figure("正在做", formatCount(t.running), { hint: "此刻正在后台跑的任务", id: "q-running" }),
    figure("最近失败", formatCount(t.failedRecent), {
      hint: "24 小时内失败过的任务",
      tone: t.failedRecent > 0 ? "warn" : "ok", id: "q-failed",
    }),
    figure("彻底停了", formatCount(t.deadTotal), {
      hint: "重试用尽、需要人工看一眼",
      tone: t.deadTotal > 0 ? "bad" : "ok", id: "q-dead",
    }),
    figure("最久等待", t.oldestPendingSeconds > 0 ? formatDuration(t.oldestPendingSeconds) : "—", {
      hint: t.pending > 0 ? "排最久的那个已经等了多久" : "当前没有等待中的任务",
      tone: t.oldestPendingSeconds > 900 ? "warn" : "",
      empty: t.pending === 0, id: "q-oldest",
    }),
  ));

  /* ── 主从：列表 + 详情 ── */
  if (rows.length === 0) {
    wrap.append(section("任务", "0 类", emptyState("队列是空的", "没有等待、失败或重试用尽的任务——这本身就是好消息。", "good")));
    return wrap;
  }

  const split = el("div", { class: "split u-mt-14" });
  const list = el("div", { class: "list", role: "tablist", "aria-label": "任务类型" });
  const detail = el("div", { class: "detail" });
  split.append(list, detail);
  wrap.append(section("任务类型", `${rows.length} 类 · 按积压排序`, split));

  const maxWeight = Math.max(1, ...rows.map(weightOf));
  let selected = Math.max(0, rows.findIndex((row) => row.jobType === lastSelectedJobType));

  const rowNodes = rows.map((row, index) => {
    const tone = toneOf(row);
    const badgeTone = { bad: "bad", warn: "warn", info: "info" }[tone] ?? "";
    const bar = el("span", { class: "list-row__bar" },
      el("i", {
        style: `--c:${tone ? `var(--${tone === "info" ? "accent" : tone})` : "var(--ink-4)"}`,
      }),
    );
    bar.firstElementChild.style.width = `${Math.max(2, (weightOf(row) / maxWeight) * 100)}%`;

    const node = el("button", {
      class: "list-row", type: "button", role: "tab",
      "aria-pressed": "false",
      onclick: () => select(index),
    },
      el("span", { class: "list-row__name", text: row.label }),
      el("span", { class: "list-row__nums" },
        row.pending > 0 ? el("span", {}, el("b", { text: formatCount(row.pending) }), " 等") : null,
        row.failedRecent > 0 ? el("span", { class: "is-warn", text: `失 ${formatCount(row.failedRecent)}` }) : null,
        row.deadTotal > 0 ? el("span", { class: "is-bad", text: `停 ${formatCount(row.deadTotal)}` }) : null,
        row.pending === 0 && row.failedRecent === 0 && row.deadTotal === 0
          ? el("span", { class: badgeTone ? "" : "dim", text: "空" })
          : null,
      ),
      bar,
    );
    return node;
  });
  list.append(...rowNodes);

  function select(index) {
    selected = index;
    lastSelectedJobType = rows[index]?.jobType ?? null;
    rowNodes.forEach((node, i) => node.setAttribute("aria-pressed", String(i === index)));
    paintDetail(rows[index]);
  }

  function paintDetail(row) {
    if (!row) return;
    const rowGroups = groups.filter((group) => group.jobType === row.jobType);
    const node = el("div", {});

    node.append(
      el("div", { class: "detail__head" },
        el("div", {},
          el("div", { class: "detail__title", text: row.label }),
          el("div", { class: "dim", style: "font-size:11.5px;margin-top:3px", text: row.known ? "已被面板收录的作业类型" : `未收录的类型标识：${row.jobType}` }),
        ),
        badge(toneOf(row) === "bad" ? "有死信" : toneOf(row) === "warn" ? "有失败" : toneOf(row) === "info" ? "在跑" : "正常",
          toneOf(row) === "bad" ? "bad" : toneOf(row) === "warn" ? "warn" : toneOf(row) === "info" ? "info" : "ok"),
      ),
      el("div", { class: "detail__stats" },
        stat("等待", formatCount(row.pending)),
        stat("在做", formatCount(row.running)),
        stat("失败", formatCount(row.failedRecent), row.failedRecent > 0 ? "bad" : ""),
        stat("停了", formatCount(row.deadTotal), row.deadTotal > 0 ? "bad" : ""),
        stat("最久等待", row.oldestPendingSeconds > 0 ? formatDuration(row.oldestPendingSeconds) : "—", row.oldestPendingSeconds > 900 ? "warn" : ""),
      ),
    );

    if (rowGroups.length === 0) {
      node.append(el("div", { class: "u-mt-14" },
        emptyState("这一类没有失败记录", "24 小时内没有 failed / dead 的实例。")));
    } else {
      node.append(el("div", { class: "section" },
        el("div", { class: "section__head" },
          el("span", { class: "section__label", text: "失败分组" }),
          el("span", { class: "section__note", text: `${rowGroups.length} 组 · 错误已脱敏` }),
        ),
        failureTable(rowGroups, ctx),
      ));
    }

    node.append(el("div", { class: "dim", style: "font-size:11.5px;margin-top:12px" },
      "动作只作用于这一类：重试会重新排队并再次调用模型；清理是永久删除。"));

    detail.replaceChildren(node);
  }

  select(selected);

  /* ── 审计（默认只给最近几条：它占满整页时反而把队列挤没了）── */
  if (audit.entries.length > 0) {
    const AUDIT_PREVIEW = 8;
    let expanded = false;
    const tableBox = el("div", { class: "u-mt-10" });
    const toggle = el("button", {
      class: "link-btn link-btn--quiet", type: "button",
      text: `展开全部 ${audit.entries.length} 条`,
      "aria-expanded": "false",
      onclick: () => {
        expanded = !expanded;
        toggle.textContent = expanded ? "收起" : `展开全部 ${audit.entries.length} 条`;
        toggle.setAttribute("aria-expanded", String(expanded));
        paintAudit();
      },
    });
    function paintAudit() {
      const rows = expanded ? audit.entries : audit.entries.slice(0, AUDIT_PREVIEW);
      tableBox.replaceChildren(el("div", { class: "table" },
        table(
          ["做了什么", "对象", "详情", "什么时候"],
          rows.map((row) => [
            row.label,
            row.targetLabel,
            Object.entries(row.detail ?? {}).length > 0
              ? el("span", { class: "dim", text: Object.entries(row.detail).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") })
              : el("span", { class: "dim", text: "—" }),
            el("span", { class: "nowrap", title: formatDateTime(row.createdAt), text: formatShortDateTime(row.createdAt) }),
          ]),
        ),
      ));
    }
    paintAudit();
    wrap.append(section("有人做了重要操作", "导出、删除、移除成员这类动作", toggle, tableBox));
  }

  return wrap;
}

function stat(key, value, tone = "") {
  return el("div", { class: "detail__stat" },
    el("b", { class: tone === "bad" ? "bad-text" : tone === "warn" ? "warn-text" : "", text: value }),
    el("span", { text: key }),
  );
}

/**
 * 失败聚合表：每个分组是「主行 + 隐藏的详情行」。
 * 主行就是一行结论——为什么、多少次、最近什么时候；展开才是 id / 空间 / 时间线。
 */
function failureTable(groups, ctx) {
  const tbody = el("tbody");
  for (const group of groups) {
    const { row, detail } = buildGroupRow(group, ctx);
    tbody.append(row, detail);
  }
  const headers = ["结果", "原因", "次数", "最近", ""];
  return el("div", { class: "table" },
    el("div", { class: "table__scroll" },
      el("table", {},
        el("thead", {}, el("tr", {}, ...headers.map((h, i) =>
          el("th", { class: i === 2 ? "num" : null, text: h })))),
        tbody,
      ),
    ),
  );
}

function buildGroupRow(group, ctx) {
  const detailRow = el("tr", { class: "row-detail", hidden: true });
  detailRow.append(el("td", { colspan: "5" },
    el("div", { class: "row-detail__box" },
      el("div", { class: "row", style: "gap:22px" },
        kv("样例任务", group.sample.id),
        kv("空间", group.sample.workspaceId),
        kv("尝试", `${group.sample.attempts} 次`),
        kv("首次可见", formatDateTime(group.sample.scheduledAt)),
        kv("最近失败", formatDateTime(group.lastSeen)),
      ),
      el("div", { class: "dim", style: "font-size:11.5px", text: `内部分类：${[group.category, group.name, group.code].filter(Boolean).join(" · ") || "unknown"}（原始错误不离开服务端）` }),
    ),
  ));

  const toggle = el("button", {
    class: "link-btn link-btn--quiet", type: "button", text: "样例",
    onclick: () => {
      detailRow.hidden = !detailRow.hidden;
      toggle.textContent = detailRow.hidden ? "样例" : "收起";
    },
  });

  const action = el("button", {
    class: `link-btn${group.status === "dead" ? " link-btn--danger" : ""}`,
    type: "button",
    text: group.status === "dead" ? "清理" : "重试",
    title: group.status === "dead"
      ? `永久删除这 ${group.count} 条`
      : `重新排队这 ${group.count} 条（会再次调用模型）`,
    onclick: async () => {
      const done = await performJobAction({
        jobType: group.jobType,
        label: `${group.label}（${group.summary}）`,
        action: group.status === "dead" ? "purge" : "retry",
        count: group.count,
      });
      if (done) await ctx.reload();
    },
  });

  const row = el("tr", {},
    el("td", {}, badge(group.statusLabel, STATUS_TONE[group.status] ?? "neutral")),
    el("td", {}, el("span", { class: "mono", text: group.summary })),
    el("td", { class: "num", text: formatCount(group.count) }),
    el("td", { class: "dim", title: formatDateTime(group.lastSeen), text: formatAgo(group.lastSeen) }),
    el("td", { class: "num" },
      el("div", { class: "row", style: "gap:12px;justify-content:flex-end" }, toggle, action),
    ),
  );

  return { row, detail: detailRow };
}

function kv(key, value) {
  return el("span", { class: "kv__item" },
    el("span", { class: "kv__k", text: key }),
    el("span", { class: "kv__v mono", style: "font-size:11.5px", text: value || "—" }),
  );
}
