/*
 * 真窗口里量「在场那一排」的处境：被谁裁、跟着谁滚。
 *
 * 只读，不动用户那台 dev 客户端（不 reload、不点击、只读 DOM 与几何）。
 * 用法：node scripts/probe-notebook-presence-live.mjs
 */
import { chromium } from '@playwright/test';
import './load-capture-env.mjs';

const cdp = process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222';
const browser = await chromium.connectOverCDP(cdp);
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
const found = [];
for (const page of pages) {
  const info = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.notebook-presence__peer')];
    if (!nodes.length) return null;
    const describe = (el) => {
      const style = getComputedStyle(el);
      return {
        cls: el.className,
        overflow: `${style.overflowX}/${style.overflowY}`,
        display: style.display,
        position: style.position,
      };
    };
    const scrollAncestor = (el) => {
      let node = el.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        if (/auto|scroll/.test(style.overflowY)) return node;
        node = node.parentElement;
      }
      return null;
    };
    const first = nodes[0];
    const scroller = scrollAncestor(first);
    const stamp = first.getBoundingClientRect();
    const row = first.closest('.notebook-volume__meta') ?? first.parentElement;
    const rowBox = row?.getBoundingClientRect();
    return {
      url: location.href.slice(0, 80),
      title: document.querySelector('.notebook-page-title h1')?.textContent ?? document.title,
      stamps: nodes.length,
      stampRect: { x: Math.round(stamp.x), y: Math.round(stamp.y), w: Math.round(stamp.width), h: Math.round(stamp.height) },
      // 印章自己的盒子与它被画的圆是否一致：border 与 background 有没有被父级切掉。
      stampVisibleBox: (() => {
        const style = getComputedStyle(first);
        return { border: style.borderTopWidth, radius: style.borderRadius, marginRight: style.marginRight, fontSize: style.fontSize };
      })(),
      parents: (() => {
        const chain = [];
        let node = first.parentElement;
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) chain.push(describe(node));
        return chain;
      })(),
      rowRect: rowBox ? { x: Math.round(rowBox.x), y: Math.round(rowBox.y), w: Math.round(rowBox.width), h: Math.round(rowBox.height) } : null,
      rowScrollVsClient: row ? { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth } : null,
      scroller: scroller ? {
        cls: String(scroller.className).slice(0, 60),
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        stampTopInsideScroller: Math.round(stamp.top - scroller.getBoundingClientRect().top),
      } : null,
    };
  }).catch(() => null);
  if (info) found.push(info);
}
console.log(JSON.stringify(found, null, 1));
await browser.close();
