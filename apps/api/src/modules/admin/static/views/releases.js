/* ============================================================
   视图 · 版本控制
   ------------------------------------------------------------
   四条发布线的当前指针与最近历史：服务端（s-v）、桌面客户端
   （c-v，macOS + Windows 共用）、iOS（i-v）、Android（a-v）。

   数据来自 Release Center 的全局表；面板只读，不在这里激活或回滚。
   历史表保留完整版本号与 tag，方便把线上问题对到具体发布。
   ============================================================ */

import { api } from "../api-client.js";
import { formatAgo, formatBytes, formatDateTime } from "../format.js";
import { el, section, table, emptyState, badge } from "../ui.js";

export const view = {
  title: "版本控制", eyebrow: "RELEASES",
  lede: "服务端与客户端的发布记录，从当前版本一路回溯到历史。",
  load: loadReleases,
};

function currentCard(label, version, detail, tone = "") {
  return el("div", { class: `mini-figure${tone ? ` mini-figure--${tone}` : ""}` },
    el("div", { class: "mini-figure__label", text: label }),
    el("div", { class: "mini-figure__value", text: version ?? "未发布" }),
    el("div", { class: "mini-figure__hint", text: detail }),
  );
}

function signedBadge(signed) {
  return signed ? badge("已签名", "ok") : badge("未签名", "warn");
}

function releaseTable(releases) {
  if (!releases?.length) return emptyState("还没有发布记录", "打 tag 并跑完发布流水线后，这里会出现历史版本。");
  return table(
    ["版本", "tag", "发布时间", "签名", "安装包"],
    releases.map((release) => [
      release.version,
      release.tag,
      release.releasedAt ? `${formatDateTime(release.releasedAt)} · ${formatAgo(release.releasedAt)}` : "—",
      signedBadge(release.signed),
      `${(release.packages ?? []).length} 个`,
    ]),
    { className: "table--releases" },
  );
}

function assetTable(releases) {
  if (!releases?.length) return emptyState("还没有热更新资产", "资产流水线跑完并注册后，这里会出现版本。");
  return table(
    ["资产版本", "基线", "发布时间", "文件", "体积"],
    releases.map((asset) => [
      asset.version,
      asset.baseVersion ?? "—",
      asset.releasedAt ? `${formatDateTime(asset.releasedAt)} · ${formatAgo(asset.releasedAt)}` : "—",
      String(asset.fileCount ?? 0),
      formatBytes(asset.totalBytes ?? 0),
    ]),
  );
}

async function loadReleases(ctx) {
  const data = await api("/releases");
  if (!ctx.isActive()) return el("div");

  const server = data.server?.current;
  const desktopCurrent = data.desktop?.current ?? [];
  const ios = data.ios?.current;
  const android = data.android?.current;
  const iosAssets = data.assets?.ios?.current;
  const androidAssets = data.assets?.android?.current;

  const wrap = el("div", { class: "releases" });

  wrap.append(section("当前版本", "PostgreSQL 是唯一事实源 · 客户端不访问 GitHub", el("div", { class: "mini-figures" },
    currentCard("服务端", server?.version, server ? `${server.tag} · ${formatAgo(server.releasedAt)}` : "还没有服务端版本记录"),
    currentCard("桌面客户端", desktopCurrent[0]?.version, desktopCurrent.length
      ? `${desktopCurrent.map((item) => item.tag).join(" / ")}`
      : "macOS / Windows 共用一条版本线"),
    currentCard("iOS", ios?.version, ios ? `${ios.tag} · ${ios.signed ? "已签名" : "未签名"}` : "还没有 iOS 发布记录"),
    currentCard("Android", android?.version, android ? `${android.tag} · ${android.signed ? "已签名" : "未签名"}` : "还没有 Android 发布记录"),
  )));

  wrap.append(section("客户端发布历史", "服务端 / 桌面 / iOS / Android",
    el("h3", { class: "section__title", text: "服务端", style: "font-size:13px;margin:18px 0 8px" }),
    releaseTable(data.server?.history),
    el("h3", { class: "section__title", text: "桌面客户端", style: "font-size:13px;margin:18px 0 8px" }),
    releaseTable(data.desktop?.history),
    el("h3", { class: "section__title", text: "iOS", style: "font-size:13px;margin:18px 0 8px" }),
    releaseTable(data.ios?.history),
    el("h3", { class: "section__title", text: "Android", style: "font-size:13px;margin:18px 0 8px" }),
    releaseTable(data.android?.history),
  ));

  wrap.append(section("热更新资产", "清单由服务端托管；文件在对象存储/CDN",
    el("h3", { class: "section__title", text: "iOS", style: "font-size:13px;margin:18px 0 8px" }),
    iosAssets ? el("p", { class: "section__note", text: `当前：${iosAssets.version} · ${iosAssets.fileCount} 个文件 · ${formatBytes(iosAssets.totalBytes)}` }) : null,
    assetTable(data.assets?.ios?.history),
    el("h3", { class: "section__title", text: "Android", style: "font-size:13px;margin:18px 0 8px" }),
    androidAssets ? el("p", { class: "section__note", text: `当前：${androidAssets.version} · ${androidAssets.fileCount} 个文件 · ${formatBytes(androidAssets.totalBytes)}` }) : null,
    assetTable(data.assets?.android?.history),
  ));

  return wrap;
}
