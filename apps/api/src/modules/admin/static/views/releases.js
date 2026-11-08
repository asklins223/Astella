/**
 * 版本控制。
 *
 * ## 这一版改了什么（以及没改什么）
 *
 * 没改视觉语言：仍是玻璃卡 + 发丝线 + 系统字体，颜色只取自既有 token 与
 * `ESCALATION_SHADES`，没有新增边条、标题样式或配色。
 *
 * 改的是**信息的形状**：
 *   - 旧的「三栏并排」（发布线导航 / 当前版本主视觉 / 谱系 / 右侧产物栏）在窄屏
 *     会被压成一栏，而本机 Release Center 全空时三栏里有两栏是空的。现在顶部是
 *     一条**发布状态构成条**：六条线按「已发布 / 未发布」切成一条横带，已发布的
 *     线各占一段（同族色阶），还没有记录的全部并成一段灰。一眼回答「六条线现在
 *     是什么状态」；有数据时再按线拆开当前版本。
 *   - 版本谱系保留时间线形态（这是版本页最合适的表达），但节点点击不再切换
 *     「左侧主视觉」，而是**打开抽屉**：版本号 / tag / 时间 / 提交 / 构建号 /
 *     平台 / 签名 / 发布说明全文 / 全部产物台账都在抽屉里，页面本身不被详情
 *     常驻占位。
 *   - 产物体积在抽屉里用 barList 画（条长 = 体积）：一行「2.3 MB」看不出哪个
 *     包最大，条长可以；完整台账（类型 / 文件名 / 体积 / 打开链接）在其下方。
 *   - 空的发布线不渲染六张空卡：构成条里并成一段灰，谱系区只有**一个**空态
 *     （当前选中的那条线），用一条分段切换器逐条看。
 *   - 搜索词、选中的线、谱系展开状态存在模块级：刷新或重建视图后不会跳回默认。
 *
 * 数据口径没动：仍然走 `/releases` 的 `readLine / groupVersions`，不伪造
 * 「已发布」记录；没有记录就说没有记录。
 */

import { api } from "../api-client.js";
import { formatAgo, formatBytes, formatCount, formatDateTime, formatShortDateTime } from "../format.js";
import {
  el, section, emptyState, icon, ICONS,
  openDrawer, dismissDrawer, drawerFacts, drawerSection,
} from "../ui.js";
import { compositionBar, barList, ESCALATION_SHADES } from "./shared.js";

export const view = {
  title: "版本控制", eyebrow: "RELEASES",
  lede: "先看六条线是否都已发布，再沿版本谱系对到具体产物。",
  load: loadReleases,
};

const KIND_LABELS = { full: "完整包", incremental: "增量包", blockmap: "分块", manifest: "清单", asset: "文件" };
const PLATFORM_LABELS = { macos: "macOS", windows: "Windows", ios: "iOS", android: "Android" };
const CHANNEL_LABELS = { stable: "稳定通道", beta: "测试通道" };
const LINES = [
  { id: "server", label: "服务端", kind: "server", tag: "s-v", hint: "API / worker / shared 一起发" },
  { id: "desktop", label: "桌面客户端", kind: "desktop", tag: "c-v", hint: "macOS 与 Windows 共用一条版本线" },
  { id: "ios", label: "iOS", kind: "app", tag: "i-v", hint: "手机仓库独立发版" },
  { id: "android", label: "Android", kind: "app", tag: "a-v", hint: "手机仓库独立发版" },
  { id: "assets-ios", label: "热更 iOS", kind: "assets", platform: "ios", tag: "资产", hint: "NotesWeb / LaunchMotion" },
  { id: "assets-android", label: "热更 Android", kind: "assets", platform: "android", tag: "资产", hint: "LaunchMotion" },
];
const EMPTY_HINT = {
  server: "打 s-v tag 并跑完发布流水线后，这里会出现服务端版本。",
  desktop: "打 c-v tag 并跑完桌面发布流水线后，这里会出现 macOS / Windows 的版本。",
  app: "打 tag 并跑完发布流水线后，这里会出现历史版本。",
  assets: "资产流水线跑完并把清单登记到 Release Center 后，这里会出现版本。",
};

/** 构成条里的灰色段：所有「还没有任何发布记录」的线并成这一段。 */
const UNPUBLISHED_KEY = "__unpublished__";
/** 谱系默认只展开最近几版；长尾收进页内展开，不一次铺满。 */
const VISIBLE_LIMIT = 6;

/** 跨刷新保留：选中的发布线、每条线的搜索词、哪些线的谱系展开了全部。 */
let selectedLineId = null;
const searches = new Map();
const expandedLines = new Set();

const timeOf = (iso) => { const value = Date.parse(iso ?? ""); return Number.isNaN(value) ? 0 : value; };
const short = (value, length = 10) => (value ? (String(value).length > length ? `${String(value).slice(0, length)}…` : String(value)) : "—");
const digest = (value) => (value ? (String(value).length > 26 ? `${String(value).slice(0, 26)}…` : String(value)) : "—");
const basename = (value) => String(value ?? "").split("/").pop() || String(value ?? "");

function lineBucket(data, line) {
  if (line.kind === "assets") return data.assets?.[line.platform] ?? {};
  if (line.kind === "desktop") return data.desktop ?? {};
  if (line.kind === "server") return data.server ?? {};
  return data[line.id] ?? {};
}

/** 记录 → 版本组（桌面线同一版本合成一组）。 */
function groupVersions(records) {
  const groups = new Map();
  for (const record of records ?? []) {
    if (!record?.version) continue;
    const group = groups.get(record.version) ?? { id: record.version, version: record.version, tag: record.tag ?? "", releasedAt: record.releasedAt, records: [], isCurrent: false };
    group.records.push(record);
    group.isCurrent = group.isCurrent || record.isCurrent === true;
    if (timeOf(record.releasedAt) > timeOf(group.releasedAt)) group.releasedAt = record.releasedAt;
    groups.set(record.version, group);
  }
  return [...groups.values()].sort((a, b) => timeOf(b.releasedAt) - timeOf(a.releasedAt));
}

function readLine(data, line) {
  const bucket = lineBucket(data, line);
  const history = [...(bucket.history ?? [])];
  const current = bucket.current ?? null;
  const currentRecords = Array.isArray(current) ? current : current ? [current] : [];
  const known = new Set(history.map((item) => item.version));
  for (const record of currentRecords) if (record?.version && !known.has(record.version)) history.push(record);
  const groups = groupVersions(history);
  const currentGroup = groups.find((group) => group.isCurrent) ?? null;
  return { groups, currentId: currentGroup?.id ?? null, currentVersion: currentGroup?.version ?? null };
}

/** 六条线一次性读成行数据：构成条、谱系、空态都从这一份派发。 */
function readLines(data) {
  return LINES.map((line) => {
    const info = readLine(data, line);
    return { line, ...info, latest: info.groups[0] ?? null };
  });
}

/** 最近一次发布（用于构成条右侧注脚）。 */
function latestRelease(rows) {
  return rows
    .filter((row) => row.latest)
    .sort((a, b) => timeOf(b.latest.releasedAt) - timeOf(a.latest.releasedAt))[0] ?? null;
}

function artifactCount(row, group) {
  if (row.line.kind === "assets") return (group.records[0]?.manifest?.files ?? []).length;
  return group.records.reduce((sum, record) => sum + (record.packages?.length ?? 0), 0);
}

/* ── 发布状态构成条 ───────────────────────────────────────────
   构成条的宽度 = 六条线里「已发布 / 未发布」的比例：已发布的线各占一段，
   用同一族色阶由深到浅（这些线是同一类事物：有记录的发布线）；还没有记录的
   线全部并成一段灰。下方的一条分段切换器负责「看哪一条线的谱系」——灰色段
   无法逐条点击，切换器补上这个入口。
   ──────────────────────────────────────────────────────────── */

function statusComposition(rows) {
  const published = rows.filter((row) => row.groups.length > 0);
  const unpublished = rows.filter((row) => row.groups.length === 0);
  const items = published.map((row, index) => ({
    key: row.line.id,
    label: row.line.label,
    value: 1,
    color: ESCALATION_SHADES[Math.min(index, ESCALATION_SHADES.length - 1)],
    hint: `${row.line.label} · ${row.currentVersion ? `当前 ${row.currentVersion}` : "未标记当前版本"} · ${row.groups.length} 个版本`,
  }));
  if (unpublished.length > 0) {
    items.push({
      key: UNPUBLISHED_KEY,
      label: "未发布的线",
      value: unpublished.length,
      color: "var(--line-strong)",
      hint: `还没有发布记录：${unpublished.map((row) => row.line.label).join("、")}`,
    });
  }
  return { published, unpublished, items };
}

function compositionBlock(rows, onSelect) {
  const { published, unpublished, items } = statusComposition(rows);
  const latest = latestRelease(published);

  const composition = compositionBar({
    items,
    limit: 6,
    ariaLabel: `六条发布线的发布状态：${published.length} 条有记录，${unpublished.length} 条未发布`,
    onLocate: (key) => {
      if (key === null || key === UNPUBLISHED_KEY) {
        if (key === UNPUBLISHED_KEY && unpublished.length > 0) onSelect(unpublished[0].line.id);
        return;
      }
      onSelect(key);
    },
  });

  const note = published.length === 0
    ? "条发布线，都还没有发布记录。"
    : `条发布线有发布记录${unpublished.length > 0 ? `，${formatCount(unpublished.length)} 条还没有` : ""}。`;
  const caption = el("div", { class: "dist__caption" },
    el("div", {},
      el("div", { class: "dist__total", text: published.length === 0 ? String(rows.length) : `${formatCount(published.length)} / ${formatCount(rows.length)}` }),
      el("div", { class: "dist__note", text: note }),
    ),
    el("div", { class: "dist__note", style: "text-align:right;max-width:46ch" },
      latest
        ? `最近一次 · ${latest.line.label} ${formatShortDateTime(latest.latest.releasedAt)}`
        : "打 tag 并跑完发布流水线后，这里会按线拆开。"),
  );

  // 六条线都没发布时，构成条只会是一条 100% 灰的横带——它不区分任何东西，
  // 反而像加载中的骨架。这种时候只留读数与下面那条发布线切换器。
  return published.length === 0 ? el("div", {}, caption) : el("div", {}, caption, composition.node);
}

/** 发布线切换器：六条线一条一格，格内是当前版本读数。 */
function linePicker(rows, onSelect) {
  const seg = el("div", { class: "seg", role: "group", "aria-label": "切换发布线" });
  for (const row of rows) {
    const pressed = row.line.id === selectedLineId;
    seg.append(el("button", {
      class: "seg__item", type: "button",
      "aria-pressed": String(pressed),
      title: row.line.hint,
      onclick: () => onSelect(row.line.id),
    },
      el("span", { text: row.line.label }),
      el("span", { class: "chips__count", text: row.currentVersion ?? "未发布" }),
    ));
  }
  return seg;
}

/* ── 版本谱系（时间线；节点点击开抽屉）──────────────────────── */

function lineageNode(row, group, onOpen) {
  const { line } = row;
  const summary = String(group.records[0]?.notes ?? "").split("\n")[0] || "这一版没有登记发布说明。";
  const count = artifactCount(row, group);
  const platforms = [...new Set(group.records.map((record) => record.platform).filter(Boolean))];
  const signed = line.kind === "app" || line.kind === "desktop"
    ? group.records.every((item) => item.signed === true)
    : null;
  const pill = (text, modifier = "") => el("span", { class: `k-pill${modifier ? ` ${modifier}` : ""}`, text });

  // button 的内容模型只允许 phrasing content：这里全部用 span（在 grid 里会被
  // 块化，版式与 div 相同），而不是 div/p——否则是无效 HTML，读屏也不稳。
  return el("button", {
    class: `k-node${group.id === row.currentId ? " is-current" : ""}`,
    type: "button",
    style: "appearance:none;width:100%;border:0;background:none;text-align:left;color:inherit;font:inherit;cursor:pointer",
    "aria-haspopup": "dialog",
    title: "点击查看发布说明与全部产物",
    "aria-label": `${group.version}${group.id === row.currentId ? "（当前版本）" : ""}，查看发布说明与全部产物`,
    onclick: () => onOpen(group),
  },
    el("i"),
    el("span", { class: "k-node__body" },
      el("span", { class: "k-node__top" },
        el("span", { class: "k-node__v", text: group.version }),
        group.tag ? el("span", { class: "k-node__tag", text: group.tag }) : null,
        el("span", { class: "k-node__when", text: formatShortDateTime(group.releasedAt) }),
        el("span", { style: "color:var(--ink-4);display:inline-flex;align-items:center", "aria-hidden": "true" }, icon(["M9 5l7 7-7 7"], { size: 12 })),
      ),
      el("span", { class: "k-node__what", text: summary }),
      el("span", { class: "k-chips" },
        pill(group.id === row.currentId ? "当前" : "历史", group.id === row.currentId ? "k-pill--on" : ""),
        pill(`${formatCount(count)} 个产物`),
        signed === true ? pill("已签名", "k-pill--ok") : signed === false ? pill("未签名", "k-pill--warn") : null,
        ...platforms.map((platform) => pill(PLATFORM_LABELS[platform] ?? platform)),
      ),
    ),
  );
}

/** 一个版本组是否命中搜索词：版本号 / tag / 提交 / 说明 / 产物名都算。 */
function matchesGroup(group, needle) {
  if (!needle) return true;
  const parts = [group.version, group.tag];
  for (const record of group.records) {
    parts.push(record.notes, record.channel, record.commit, record.baseVersion, record.platform);
    for (const pkg of record.packages ?? []) parts.push(pkg.name, pkg.kind);
    for (const file of record.manifest?.files ?? []) parts.push(file.path);
  }
  return parts.filter(Boolean).join(" ").toLowerCase().includes(needle);
}

function currentLineRow(rows) {
  return rows.find((row) => row.line.id === selectedLineId)
    ?? rows.find((row) => row.groups.length > 0)
    ?? rows[0];
}

function lineageCard(row, onOpen) {
  const { line, currentId } = row;
  const groups = row.groups;
  const card = section("版本谱系", `${line.label} · 共 ${formatCount(groups.length)} 个版本`);

  if (groups.length === 0) {
    card.append(emptyState(
      `「${line.label}」还没有发布记录`,
      `${EMPTY_HINT[line.kind] ?? EMPTY_HINT.app} 其他线的情况看上面的构成条。`,
    ));
    return card;
  }

  const note = card.querySelector(".section__note");

  const search = el("input", {
    type: "search",
    value: searches.get(line.id) ?? "",
    placeholder: "搜索版本号、tag、发布说明…",
    "aria-label": `搜索${line.label}的版本谱系`,
  });
  const searchBox = el("label", { class: "k-search", style: "flex:1 1 240px;max-width:340px;margin-bottom:0" }, icon(ICONS.search, { size: 15 }), search);
  const nodes = el("div", { class: "k-nodes", "aria-label": `${line.label}版本谱系` });
  const footer = el("div", { class: "row", style: "margin-top:12px;gap:14px" });
  card.append(el("div", { class: "row", style: "gap:12px;margin-bottom:12px;align-items:center" }, searchBox), nodes, footer);

  function paint() {
    const needle = (searches.get(line.id) ?? "").trim().toLowerCase();
    const hits = groups.filter((group) => matchesGroup(group, needle));
    const expanded = expandedLines.has(line.id) || needle.length > 0;
    const visible = expanded ? hits : hits.slice(0, VISIBLE_LIMIT);
    const currentGroup = groups.find((group) => group.id === currentId) ?? null;

    nodes.replaceChildren(...visible.map((group) => lineageNode(row, group, (picked) => openVersionDrawer(row, picked, currentGroup))));
    if (visible.length === 0) nodes.append(emptyState("没有匹配的版本", "换个关键词，或清空搜索看全部版本。"));
    note.textContent = needle
      ? `${line.label} · ${formatCount(hits.length)} / ${formatCount(groups.length)} 个版本匹配`
      : `${line.label} · 共 ${formatCount(groups.length)} 个版本`;

    footer.replaceChildren();
    const hidden = hits.length - visible.length;
    if (!expanded && hidden > 0) {
      footer.append(el("button", {
        class: "link-btn", type: "button",
        text: `展开其余 ${formatCount(hidden)} 个版本`,
        "aria-expanded": "false",
        onclick: () => { expandedLines.add(line.id); paint(); },
      }));
    } else if (expandedLines.has(line.id) && !needle && hits.length > VISIBLE_LIMIT) {
      footer.append(el("button", {
        class: "link-btn link-btn--quiet", type: "button", text: "收起长尾",
        onclick: () => { expandedLines.delete(line.id); paint(); },
      }));
    }
    footer.append(el("p", { class: "k-hint", style: "margin:0 0 0 auto;text-align:right", text: "点任一版本节点，打开发布说明与全部产物。" }));
  }

  search.addEventListener("input", () => {
    searches.set(line.id, search.value);
    paint();
  });
  paint();
  return card;
}

/* ── 版本抽屉：一版的全部事实 + 发布说明全文 + 产物台账 ──────── */

function artifactEntries(row, group) {
  const entries = [];
  if (row.line.kind === "assets") {
    for (const file of group.records[0]?.manifest?.files ?? []) {
      entries.push({ kind: "文件", platform: row.line.platform, name: file.path, size: Number(file.byteLength) || 0, url: file.url });
    }
  } else {
    for (const record of group.records) {
      for (const pkg of record.packages ?? []) {
        entries.push({
          kind: KIND_LABELS[pkg.kind] ?? pkg.kind,
          platform: record.platform,
          name: pkg.name,
          size: Number(pkg.byteLength) || 0,
          url: pkg.url,
        });
      }
    }
  }
  return entries.sort((a, b) => b.size - a.size);
}

function artifactLedger(entries) {
  const multiplePlatforms = new Set(entries.map((entry) => entry.platform)).size > 1;
  return el("div", { class: "k-ledger" }, ...entries.map((entry) => el("div", { class: "k-ledger__row" },
    el("span", {
      class: "k-ledger__k",
      text: multiplePlatforms ? `${PLATFORM_LABELS[entry.platform] ?? entry.platform} · ${entry.kind}` : entry.kind,
    }),
    el("span", { class: "k-ledger__n", text: entry.name, title: entry.name }),
    el("span", { class: "k-ledger__s", text: formatBytes(entry.size) }),
    entry.url
      ? el("a", { class: "k-ledger__a", href: entry.url, target: "_blank", rel: "noreferrer noopener", text: "打开" })
      : el("span", { class: "k-ledger__a", text: "—" }),
  )));
}

function openVersionDrawer(row, group) {
  const { line } = row;
  const record = group.records[0] ?? {};
  const entries = artifactEntries(row, group);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const platforms = [...new Set(group.records.map((item) => item.platform).filter(Boolean))];
  const isCurrent = group.id === row.currentId;

  const facts = [
    ["发布线", line.label],
    ["版本", group.version, { mono: true }],
    ["tag", group.tag || "—", { mono: true }],
    ["发布时间", el("span", {}, formatDateTime(group.releasedAt), el("span", { class: "dim", text: ` · ${formatAgo(group.releasedAt)}` }))],
    ["发布记录", `${formatCount(group.records.length)} 条`],
  ];
  if (line.kind === "server") {
    facts.push(["提交", short(record.commit, 12), { mono: true }]);
    const digests = Object.entries(record.imageDigests ?? {});
    if (digests.length > 0) facts.push(["镜像", `${formatCount(digests.length)} 个服务`]);
  }
  if (line.kind === "app" || line.kind === "desktop") {
    facts.push(["构建号", record.build ? `#${record.build}` : "未登记"]);
    facts.push(["平台", platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform).join(" / ") || "—"]);
    facts.push(["签名", group.records.every((item) => item.signed === true) ? "已签名" : "未签名"]);
    if (record.channel) facts.push(["通道", CHANNEL_LABELS[record.channel] ?? record.channel]);
    if (record.clientAssetsVersion) facts.push(["热更资产", record.clientAssetsVersion, { mono: true }]);
  }
  if (line.kind === "assets") {
    facts.push(["基线版本", record.baseVersion ?? "无（整包基线）", { mono: true }]);
    facts.push(["文件", `${formatCount(record.fileCount ?? entries.length)} 个`]);
    facts.push(["体积", formatBytes(record.totalBytes ?? totalBytes)]);
  }

  const notesText = record.notes
    || (line.kind === "assets" ? "资产版本没有登记发布说明。" : "这一版没有登记发布说明。");
  const body = [
    drawerFacts(facts),
    drawerSection("发布说明", null,
      el("p", { class: `k-notes__text${record.notes ? "" : " dim"}`, style: "margin:8px 0 0", text: notesText })),
  ];

  if (line.kind === "server") {
    const digests = Object.entries(record.imageDigests ?? {});
    if (digests.length > 0) {
      body.push(drawerSection("镜像摘要", `${formatCount(digests.length)} 个服务`,
        drawerFacts(digests.map(([service, value]) => [`镜像 · ${service}`, digest(value), { mono: true }]))));
    }
  }

  if (entries.length === 0) {
    body.push(drawerSection("产物", null,
      el("p", { class: "dim", style: "font-size:12px;margin:8px 0 0", text: "这一版没有登记产物。" })));
  } else {
    const shown = entries.slice(0, 8);
    body.push(drawerSection("产物", `${formatCount(entries.length)} 个 · 合计 ${formatBytes(totalBytes)}`,
      // 条长 = 体积：一眼看出这批包里哪个最重。
      barList(shown.map((entry) => ({
        key: entry.name,
        label: basename(entry.name),
        value: entry.size,
        note: formatBytes(entry.size),
      }))),
      entries.length > shown.length
        ? el("p", { class: "k-hint", style: "margin:8px 0 0", text: `条形只画最大的 ${formatCount(shown.length)} 个，下面台账是全部 ${formatCount(entries.length)} 个。` })
        : null,
      el("div", { style: "margin-top:16px" }, artifactLedger(entries)),
    ));
  }

  openDrawer({
    title: group.version,
    eyebrow: `${line.label} · ${isCurrent ? "当前版本" : "历史版本"}`,
    sub: `${formatShortDateTime(group.releasedAt)}${group.tag ? ` · ${group.tag}` : ""}`,
    body,
  });
}

/* ═══════════════════════════════════════════════════════════════
   页面装配
   ═══════════════════════════════════════════════════════════════ */

async function loadReleases(ctx) {
  const data = await api("/releases");
  if (!ctx.isActive()) return el("div");

  const rows = readLines(data);
  ctx.onCleanup?.(() => dismissDrawer());

  const lineageSlot = el("div", {});
  const pickerSlot = el("div", { style: "margin-top:16px" });

  function paint() {
    const row = currentLineRow(rows);
    selectedLineId = row.line.id;
    pickerSlot.replaceChildren(linePicker(rows, (id) => { selectedLineId = id; paint(); }));
    lineageSlot.replaceChildren(lineageCard(row, (group) => openVersionDrawer(row, group)));
  }

  // 构成条只在有发布记录时存在；空态下这句提示不能还讲「每段宽度」。
  const hasPublished = rows.some((row) => row.groups.length > 0);
  const status = section("发布状态", "六条线 · 已发布 vs 未发布",
    compositionBlock(rows, (id) => { selectedLineId = id; paint(); }),
    pickerSlot,
    el("p", {
      class: "k-hint",
      style: "margin-top:10px",
      text: hasPublished
        ? "构成条里每段宽度 = 该状态下发布线的占比；灰色段是还没有任何发布记录的线（合计一段）。下方分段切换器逐条查看谱系。"
        : "下方分段切换器可以逐条查看每条线的谱系；有发布记录后，这里会出现构成条。",
    }),
  );

  paint();
  return el("div", {}, status, lineageSlot);
}
