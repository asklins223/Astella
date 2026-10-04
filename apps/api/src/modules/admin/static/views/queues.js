/* ============================================================
   视图 · 任务与队列
   ------------------------------------------------------------
   这里的 3D 柱场是**选择器**，不是装饰：

     · 每类任务一根柱（高度=积压权重，颜色=状态；对数压缩，400 条不会
       把 2 条压成看不见）；
     · 柱顶点选或点柱顶标签 → 右侧换成那一类的详情（失败分组 + 动作）；
     · 图例（颜色点 + 名字 + 数量）与柱场双向同步。

   文字部分只描述**被选中的那类**：总量一行、失败按原因聚合、样例可展开。
   同类失败不再平铺 20 行「unknown · Error」——那是读不出结论的墙。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatCount, formatDateTime, formatDuration } from "../format.js";
import { el, section, table, emptyState, badge } from "../ui.js";
import { performJobAction } from "./shared.js";

export const view = {
  title: "任务与队列",
  lede: "服务在后台替用户做的事。柱场里每根柱是一类任务——点它看这一类为什么堵、失败在哪一步。",
  load: loadQueues,
};

const STATUS_TONE = { dead: "bad", failed: "warn" };

/** 排序规则与场景一致：权重降序（索引 = 柱的序号）。 */
function sortByWeight(rows) {
  return [...rows].sort((a, b) => {
    const weight = (r) => r.pending + r.deadTotal * 1.5 + r.failedRecent * 2;
    return weight(b) - weight(a) || a.jobType.localeCompare(b.jobType);
  });
}

function barTone(row) {
  if (row.deadTotal > 0) return "bad";
  if (row.failedRecent > 0) return "warn";
  if (row.running > 0) return "busy";
  return "ok";
}

const TONE_COLOR = { bad: "var(--red)", warn: "var(--amber)", busy: "var(--blue)", ok: "var(--mint)" };

async function loadQueues(ctx) {
  const data = await api("/queues");
  const t = data.totals;
  const wrap = el("div", {});

  const rows = sortByWeight(data.byType ?? []).slice(0, 18);
  const groups = data.failureGroups ?? [];

  /* ── 总量一行（细横带） ── */
  wrap.append(el("div", { class: "row row--between", style: "gap:12px;margin-bottom:12px" },
    el("div", { class: "row", style: "gap:18px" },
      statInline("等待中", formatCount(t.pending), t.pending > 20 ? "warn" : ""),
      statInline("正在做", formatCount(t.running), ""),
      statInline("最近失败", formatCount(t.failedRecent), t.failedRecent > 0 ? "warn" : "ok"),
      statInline("彻底停了", formatCount(t.deadTotal), t.deadTotal > 0 ? "bad" : "ok"),
      statInline("最久等待", t.oldestPendingSeconds > 0 ? formatDuration(t.oldestPendingSeconds) : "—", t.oldestPendingSeconds > 900 ? "warn" : ""),
    ),
    el("span", { class: "section__note", text: rows.length > 0 ? `${data.byType.length} 类任务 · 柱高按积压（对数）` : "" }),
  ));

  /* ── 柱场 + 详情 ── */
  const qdeck = el("div", { class: "qdeck" });
  const main = el("div", {});
  const stage = el("div", { class: "stage stage--tall", id: "queues-stage" });
  stage.append(el("div", { class: "hud-layer", id: "queues-hud" }));
  main.append(stage);

  const legend = el("div", { class: "qlegend u-mt-10" });
  main.append(legend);

  const detail = el("div", { class: "qdetail" });
  qdeck.append(main, detail);
  wrap.append(qdeck);

  /* ── 选择状态 ── */
  let selectedIndex = -1;
  const focus = ctx.takeFocusJobType?.();
  if (focus) {
    const found = rows.findIndex((row) => row.jobType === focus);
    if (found >= 0) selectedIndex = found;
  }
  if (selectedIndex < 0 && rows.length > 0) selectedIndex = 0;

  const hud = stage.querySelector("#queues-hud");
  const barLabels = [];

  function select(index, { fromScene = false } = {}) {
    if (index < 0 || index >= rows.length) return;
    selectedIndex = index;
    if (!fromScene) ctx.selectBar?.(index);
    paintLegend();
    paintLabels();
    paintDetail();
  }

  function paintLegend() {
    legend.replaceChildren(...rows.map((row, index) =>
      el("button", {
        class: "qlegend__item", type: "button",
        "aria-pressed": String(index === selectedIndex),
        onclick: () => select(index),
      },
        el("span", { class: "qlegend__dot", style: `--c:${TONE_COLOR[barTone(row)]}` }),
        el("span", { text: row.label }),
        el("span", { class: "qlegend__count", text: formatCount(row.pending + row.deadTotal + row.failedRecent) }),
      )));
  }

  function paintLabels() {
    for (const { el: node, index } of barLabels) {
      const row = rows[index];
      const selected = index === selectedIndex;
      // 注意：replaceChildren 会把 null 转成文本 "null"，先滤掉再放进 DOM。
      const children = [el("span", { class: "hud__v", text: formatCount(row.pending + row.deadTotal + row.failedRecent) })];
      if (selected) children.push(el("span", { class: "hud__k", text: row.label }));
      node.replaceChildren(...children);
      node.dataset.selected = String(selected);
    }
  }

  function paintDetail() {
    const row = rows[selectedIndex];
    if (!row) {
      detail.replaceChildren(el("div", { class: "table" },
        emptyState("队列是空的", "没有等待或失败的任务——仪器安静是好事。", "good")));
      return;
    }
    const rowGroups = groups.filter((group) => group.jobType === row.jobType);
    detail.replaceChildren(
      el("div", { class: "qdetail__head" },
        el("div", { class: "qdetail__name", text: row.label }),
        badge(barTone(row) === "ok" ? "正常" : barTone(row) === "busy" ? "在跑" : barTone(row) === "warn" ? "有失败" : "有死信",
          barTone(row) === "ok" ? "on" : barTone(row) === "busy" ? "info" : barTone(row) === "warn" ? "warn" : "bad"),
      ),
      el("div", { class: "qdetail__stats" },
        statBlock("等待", formatCount(row.pending)),
        statBlock("在做", formatCount(row.running)),
        statBlock("失败", formatCount(row.failedRecent), row.failedRecent > 0 ? "bad" : ""),
        statBlock("停了", formatCount(row.deadTotal), row.deadTotal > 0 ? "bad" : ""),
        statBlock("最久", row.oldestPendingSeconds > 0 ? formatDuration(row.oldestPendingSeconds) : "—",
          row.oldestPendingSeconds > 900 ? "warn" : ""),
      ),
      rowGroups.length === 0
        ? el("div", { class: "table" }, emptyState("这一类没有失败记录", "24 小时内没有 failed / dead 的实例。"))
        : el("div", { class: "table" },
            table(
              ["结果", "原因", "次数", "最近", ""],
              rowGroups.map((group) => [
                badge(group.statusLabel, STATUS_TONE[group.status] ?? "info"),
                el("span", { class: "mono", text: group.summary }),
                formatCount(group.count),
                el("span", { class: "dim", title: formatDateTime(group.lastSeen), text: formatAgo(group.lastSeen) }),
                el("button", {
                  class: `btn btn--sm${group.status === "dead" ? "" : " btn--primary"}`,
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
                }),
              ]),
              { numericColumns: [2] },
            ),
          ),
      rowGroups.length > 0
        ? el("div", { class: "dim", style: "font-size:11px" },
            `内部分类：${[rowGroups[0].category, rowGroups[0].name, rowGroups[0].code].filter(Boolean).join(" · ") || "unknown"}（原始错误不离开服务端）`)
        : null,
    );
  }

  /* ── 接仪器 ── */
  if (rows.length > 0) {
    ctx.mountScene?.(stage, "queues");
    ctx.setQueue?.(rows);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const label = el("button", {
        class: `hud hud--bar${barTone(row) === "bad" ? " hud--bad" : barTone(row) === "warn" ? " hud--warn" : ""}`,
        type: "button",
        title: `${row.label}：等待 ${row.pending} · 在做 ${row.running} · 失败 ${row.failedRecent} · 停 ${row.deadTotal}`,
        onclick: () => select(index),
      });
      hud.append(label);
      barLabels.push({ el: label, index, key: `bar:${index}` });
    }
    ctx.setLabels?.(barLabels);
    ctx.onCleanup?.(ctx.onBarSelect?.((row, index) => select(index, { fromScene: true })) ?? (() => {}));
    select(selectedIndex, { fromScene: true });
  } else {
    paintLegend();
    paintDetail();
  }

  /* ── 审计 ── */
  const audit = await api("/audit?limit=40").catch(() => ({ entries: [] }));
  if (audit.entries.length > 0) {
    wrap.append(
      section("有人做了重要操作", "导出、删除、移除成员这类动作",
        el("div", { class: "table" },
          table(
            ["做了什么", "对象", "详情", "什么时候"],
            audit.entries.map((row) => [
              row.label,
              row.targetLabel,
              Object.entries(row.detail ?? {}).length > 0
                ? el("span", { class: "dim", text: Object.entries(row.detail).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") })
                : el("span", { class: "dim", text: "—" }),
              formatDateTime(row.createdAt),
            ]),
          ),
        ),
      ),
    );
  }

  return wrap;
}

function statInline(key, value, tone = "") {
  return el("span", { class: "row", style: "gap:7px" },
    el("span", { class: "readout__k", text: key }),
    el("span", {
      class: `readout__v${tone ? ` readout__v--${tone}` : ""}${value === "—" ? " readout__v--empty" : ""}`,
      text: value,
    }),
  );
}

function statBlock(key, value, tone = "") {
  return el("div", { class: "qdetail__stat" },
    el("b", { class: tone === "bad" ? "bad-text" : tone === "warn" ? "warn-text" : "", text: value }),
    el("span", { text: key }),
  );
}
