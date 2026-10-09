/*
 * 在场那一排的几何走查（离线，不动正在跑的 dev 客户端）。
 *
 * 主进程改了 IPC 通道就要重启客户端，而不该打断用户那台 dev；这一条链路仍能回答
 * 自动化管不到的那一件事：**新摆的这几处在真样式下摆不摆得下**。
 *  - 列表那一行：238px 的纸上多出「印章 + 名字」那一格，会不会横向溢出、把行高撑崩；
 *  - 全屏纸签：册页页眉那条 meta 在全屏下是 `display:none`，那一排改挂到常驻纸签之后，
 *    四个人加自己时纸签会不会顶出视口。
 *
 * 用法（在 apps/desktop-client 下）：
 *   node scripts/probe-notebook-presence-geometry.mjs
 * 证据写到 `outputs/notebook-presence-geometry/`（已被 gitignore）。
 *
 * 量的是**真组件 + 真 CSS**：组件用 esbuild 打成一份临时 bundle，样式按 `styles.ts`
 * 的层序内联（母本 hud-pages.css 在前，hud-surface.css 与 notebook-*.css 在后），
 * 不在这里重写一份样式近似。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import './load-capture-env.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const rendererRoot = join(appRoot, 'src/renderer/src');
const evidence = resolve(appRoot, 'outputs/notebook-presence-geometry');
mkdirSync(evidence, { recursive: true });

const presencePath = join(rendererRoot, 'components/surfaces/notebook/notebook-presence.tsx');

function entryFor(view) {
  return `
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { NotebookPresence, NotebookPresenceReaders } from ${JSON.stringify(presencePath)};

const peers = [
  { clientId: 7, name: "小琳", mode: "editing", block: 2 },
  { clientId: 8, name: "阿斯蒂芬", mode: "reading", block: null },
  { clientId: 9, name: null, mode: "reading", block: null },
  { clientId: 10, name: "Kai", mode: "editing", block: 4 },
];
const twoViewers = [
  { id: "u1", name: "小琳", mode: "editing" },
  { id: "u2", name: "阿斯蒂芬·长名字", mode: "reading" },
];
const manyViewers = peers.map((peer, index) => ({ id: String(index), name: peer.name, mode: peer.mode }));

const row = (title, updated, meta) => h("li", null,
  h("button", { className: "notebook-note-list__item" },
    h("span", { className: "notebook-note-list__title" }, title),
    h("span", { className: "notebook-note-list__meta" }, h("time", null, updated), meta)));

const Paper = () => h("div", { className: "notebook-note-list__paper" },
  h("header", { className: "notebook-note-list__head" }, h("div", null, h("h2", null, "手边的笔记"))),
  h("div", { className: "notebook-note-list__scroll" }, h("nav", { "aria-label": "切换笔记" }, h("ul", null,
    row("没有人看的笔记", "3 天前更新", h("span", null, "当前")),
    row("有两个人在这篇里，标题也长一些些", "2 小时前更新", NotebookPresenceReaders({ viewers: twoViewers })),
    row("四个人都开着这一篇", "刚刚更新", NotebookPresenceReaders({ viewers: manyViewers }))))));

const Ribbon = () => h("div", { className: "notebook-workspace" },
  h("div", { className: "notebook-desk", "data-fullscreen": "" },
    h("div", { className: "notebook-focus-ribbon" },
      h("button", { className: "text-action notebook-focus-ribbon__back" }, "←"),
      h("span", { className: "notebook-focus-ribbon__presence" },
        NotebookPresence({ peers, selfName: "Asklins", selfMode: "editing", failure: null })),
      h("button", { className: "text-action notebook-focus-ribbon__tools" }, "笔记工具", h("small", null, "阅读")),
      h("button", { className: "text-action notebook-focus-ribbon__exit" }, "⤡"))));

const Rack = ({ view }) => h("div", { className: "notebook-workspace" },
  h("div", { className: "notebook-desk", "data-view": view, "data-mode": "preview" },
    h("div", { className: "notebook-desk__chrome" },
      h("nav", { className: "notebook-desk__rack", "aria-label": "笔记工具" },
        h("div", { className: "notebook-desk__modes", role: "group" },
          h("button", { className: "text-action" }, "目录"),
          h("div", { className: "notebook-desk__mode-switch" },
            h("button", { className: "text-action" }, "阅读"),
            h("button", { className: "text-action" }, "编辑"),
            h("button", { className: "text-action" }, "源码"))),
        h("div", { className: "notebook-desk__presence" },
          NotebookPresence({ peers, selfName: "Asklins", selfMode: "editing", failure: null })),
        h("div", { className: "notebook-desk__utilities" },
          h("button", { className: "text-action" }, "全屏"),
          h("button", { className: "text-action" }, "生成学习卡"),
          h("button", { className: "text-action" }, "资料袋"))))));

const Tree = ${view === "list" ? "h(Paper)"
    : view === "ribbon" ? "h(Ribbon)"
      : view === "rack-compact" ? "h(Rack, { view: \"overview\" })"
        : "h(Rack, { view: \"body\" })"};
createRoot(document.body).render(Tree);
`;
}

const cssOrder = [
  'styles.css',
  'components/hud/hud-pages.css',
  'components/hud/hud-surface.css',
  'components/surfaces/notebook/notebook-desk.css',
  'components/surfaces/notebook/notebook-fullscreen.css',
  'components/surfaces/notebook/notebook-note-list.css',
];
const { readFileSync } = await import('node:fs');
const css = cssOrder
  .map((file) => `/* ${file} */\n${readFileSync(join(rendererRoot, file), 'utf8')}`)
  .join('\n');

async function bundle(view) {
  const result = await build({
    stdin: { contents: entryFor(view), resolveDir: appRoot, loader: 'tsx' },
    bundle: true,
    write: false,
    jsx: 'automatic',
    nodePaths: [join(appRoot, 'node_modules'), resolve(appRoot, '../../node_modules')],
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const script = result.outputFiles[0].text;
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${css}</style></head>
<body class="desktop-app hud-surface"><script>${script}</script></body></html>`;
  writeFileSync(join(evidence, `${view}.html`), html);
  return `file://${join(evidence, `${view}.html`)}`;
}

const measures = {
  list: () => {
    const paper = document.querySelector('.notebook-note-list__paper');
    return {
      paperWidth: Math.round(paper.getBoundingClientRect().width),
      rows: [...document.querySelectorAll('.notebook-note-list__item')].map((row) => {
        const meta = row.querySelector('.notebook-note-list__meta');
        const readers = row.querySelector('.notebook-note-list__readers');
        const line = readers?.lastElementChild;
        return {
          title: row.querySelector('.notebook-note-list__title').textContent,
          rowHeight: Math.round(row.getBoundingClientRect().height),
          // >0 就是那一格横向溢出了（纸只有 238px 宽）。
          metaOverflowX: meta.scrollWidth - meta.clientWidth,
          readersClipped: line ? line.scrollWidth - line.clientWidth : null,
          readersText: line?.textContent ?? null,
          stamps: readers ? readers.querySelectorAll('.notebook-presence__peer').length : 0,
        };
      }),
    };
  },
  ribbon: () => {
    const ribbon = document.querySelector('.notebook-focus-ribbon');
    const presence = document.querySelector('.notebook-focus-ribbon__presence');
    const stamp = document.querySelector('.notebook-focus-ribbon .notebook-presence__peer');
    const rect = ribbon.getBoundingClientRect();
    return {
      ribbonRect: { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewportWidth: window.innerWidth,
      fitsViewport: rect.left >= 0 && rect.right <= window.innerWidth,
      presenceWidth: Math.round(presence.getBoundingClientRect().width),
      stampSize: Math.round(stamp.getBoundingClientRect().width),
      stamps: presence.querySelectorAll('.notebook-presence__peer').length,
      tagText: presence.querySelector('.tag')?.textContent ?? null,
    };
  },
  rack: () => {
    const desk = document.querySelector('.notebook-desk');
    const rack = document.querySelector('.notebook-desk__rack');
    const presence = document.querySelector('.notebook-desk__presence');
    const stamp = presence.querySelector('.notebook-presence__peer');
    const utilities = document.querySelector('.notebook-desk__utilities');
    const stampBox = stamp.getBoundingClientRect();
    const clipper = (() => {
      let node = stamp.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const box = node.getBoundingClientRect();
          if (stampBox.top < box.top - 0.5 || stampBox.bottom > box.bottom + 0.5) return node.className;
        }
        node = node.parentElement;
      }
      return null;
    })();
    return {
      dataView: desk.dataset.view,
      rackOverflowX: rack.scrollWidth - rack.clientWidth,
      // 工具条右端那颗按钮有没有被挤出纸面（>0 就是挤出去了）。
      utilitiesRight: Math.round(utilities.getBoundingClientRect().right),
      viewportWidth: window.innerWidth,
      stampRect: { w: Math.round(stampBox.width), h: Math.round(stampBox.height) },
      // 圆印章应当是 19×19（全屏纸签里 17×17）；被切的话这里会小于它自己的盒子。
      stampClippedBy: clipper,
      tagShown: Boolean(presence.querySelector('.tag') && getComputedStyle(presence.querySelector('.tag')).display !== 'none'),
      tagText: presence.querySelector('.tag')?.textContent ?? null,
    };
  },
};

const report = [];
const executable = process.env.ASTELLA_PROBE_CHROMIUM
  ?? `${(await import('node:os')).homedir()}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
const browser = await chromium.launch({ executablePath: executable });
for (const width of [1680, 1280, 900]) {
  for (const view of ['list', 'ribbon', 'rack', 'rack-compact']) {
    const url = await bundle(view);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(url, { waitUntil: 'load' });
    // 展开动画期间量的 rect 会被 transform 缩小几个 px，等一拍再下结论。
    await page.waitForTimeout(220);
    const measure = page.evaluate(view.startsWith('rack') ? measures.rack : measures[view]);
    report.push({ width, view, ...(await measure) });
    if (view === 'list' && width === 1280) {
      await page.screenshot({ path: join(evidence, `list-1280.png`), fullPage: true });
    }
    if (view === 'rack' && width === 900) {
      await page.screenshot({ path: join(evidence, 'rack-900.png'), fullPage: true });
    }
    if (view === 'ribbon' && width === 900) {
      await page.screenshot({ path: join(evidence, 'ribbon-900.png'), fullPage: true });
    }
    await page.close();
  }
}
writeFileSync(join(evidence, 'geometry.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
await browser.close();
