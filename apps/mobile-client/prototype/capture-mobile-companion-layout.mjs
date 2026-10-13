/* Optional reproducible browser smoke runner. Actual delivery evidence is saved
 * separately from the Codex browser walkthrough; this script is not that record. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:4196';
const output = fileURLToPath(new URL('../../../docs/plans/learning-companion/assets/51-mobile-companion/reproduced/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.ASTELLA_LAYOUT_BROWSER ? { executablePath: process.env.ASTELLA_LAYOUT_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1450, height: 1060 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = { scope: 'Frontend local fixture, local account simulation; no model, real authentication, native keyboard or real sync.', checks: [], geometry: [], screenshots: [] };
const button = name => page.getByRole('button', { name, exact: true });
// The delivery card now carries the version and save time instead of a fixed
// 「打开正文」 caption, so its accessible name changes with the clock.
const deliveryCard = (...texts) => texts.reduce((set, text) => set.filter({ hasText: text }), page.locator('#device .delivery'));
const save = async name => { await page.screenshot({ path: `${output}/${name}`, fullPage: true }); report.screenshots.push(name); };
const geometry = async () => page.locator('#device').evaluate(root => {
  const page = root.querySelector('.page-scroll');
  const mode = root.dataset.dialogue;
  const reply = root.querySelector('.assistant-text');
  const range = document.createRange(); if (reply) range.selectNodeContents(reply);
  const contentRect = page.getBoundingClientRect();
  const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom }; };
  return { mode, device: rect(root), content: rect(page), header: rect(root.querySelector('.topbar')), companion: rect(root.querySelector(mode === 'scene' ? '.live2d-seat' : '.identity .portrait')), bubble: rect(root.querySelector('.scene-speech')), horizontalOverflow: page.scrollWidth - page.clientWidth, visibleReplyLines: reply ? [...range.getClientRects()].filter(r => r.top >= contentRect.top && r.bottom <= contentRect.bottom).length : 0 };
});
// The phone chrome animates its height, so a rect taken one frame later still measures
// the transition instead of the window the reader actually gets.
const settle = () => page.waitForFunction(() => {
  const height = document.querySelector('#device .topbar').getBoundingClientRect().height;
  const previous = window.__settleHeight;
  window.__settleHeight = height;
  return previous !== undefined && Math.abs(previous - height) < .5;
}, null, { polling: 'raf', timeout: 5000 });
try {
  await page.goto(`${base}/apps/mobile-client/prototype/mobile-companion-layout.html`, { waitUntil: 'networkidle' });
  // This reproduction checks the retained history journey. Scene evidence uses CUA.
  await page.locator('[data-action="dialogue-mode"][data-mode="history"]').click();
  await page.locator('.lab-controls summary').click();
  await button('重置演示数据').click();
  await save('01-conversation.png');
  await button('打开菜单').click();
  await page.locator('#device [data-action="settings"]').click();
  await page.locator('#device [data-action="consent-info"]').click();
  assert.equal(await page.locator('.sheet').getAttribute('data-depth'),'0');
  await button('关闭面板').click();
  assert.equal(await page.locator('.page-scroll').getAttribute('aria-label'),'设置');
  await button('返回上一页').click();
  report.checks.push('menu > settings page > consent > dismiss > return to source');
  await page.getByRole('tab', { name: '手记', exact: true }).click();
  await page.locator('#device [data-action="open-note"][data-id="note-history"]').click();
  assert.equal(await page.locator('#device [role="tablist"]').count(), 0);
  assert.equal(await page.locator('#chat-input').count(),0);
  await button('引用第 2 段').click();
  await page.locator('#device .detail-dock [data-action="ask"]').click();
  await page.locator('#ask-input').fill('用一个例子讲清楚');
  await page.locator('.sheet .send').click();
  await page.locator('.ask-results .assistant-text').waitFor();
  await save('02-contextual-reading.png');
  await button('关闭面板').click();
  await button('返回上一页').click();
  assert.equal(await page.getByRole('tab', { name: '手记', exact: true }).getAttribute('aria-selected'), 'true');
  report.checks.push('notes > reader > quoted ask > back returns to notes');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await button('递示例图片').click();
  await button('发送消息').click();
  await page.locator('#device').getByText('相邻两次分别增加 10、20、30。', { exact: false }).waitFor();
  await button('整理成笔记').click();
  await button('发送消息').click();
  await deliveryCard('已保存 · 我的书房', '怎样读一张增长图').first().waitFor();
  await button('第二段改成表格').click();
  await button('发送消息').click();
  await deliveryCard('已更新 · 原来的笔记', '第 2 版').last().waitFor();
  assert.equal(await page.locator('#desktop-mirror [data-mirror-note]').filter({ hasText: '怎样读一张增长图' }).count(), 1);
  await button('看修改对照').click();
  await button('修改前 · 第 1 版').click();
  assert.equal(await page.locator('.page-scroll table').count(), 0);
  await button('修改后 · 第 2 版').click();
  assert.equal(await page.locator('.page-scroll table').count(), 1);
  await save('03-same-note-edit.png');
  await button('回到笔记正文').click();
  assert.equal(await page.locator('.page-scroll').getAttribute('aria-label'), '笔记正文');
  await button('返回上一页').click();
  report.checks.push('image > explanation > create > edit same object > comparison > reader > conversation');
  await button('重置演示数据').click();
  await button('递示例图片').click();
  for (const size of ['390,844', '360,720', '320,640']) {
    await page.locator('#device-size').selectOption(size);
    await page.locator('#text-size').selectOption(size === '320,640' ? '1.5' : '1');
    await page.locator('#keyboard-toggle').setChecked(true);
    await settle();
    const g = await geometry();
    assert.equal(g.mode, 'history', `the record view is what the reader scrolls at ${size}`);
    assert(g.horizontalOverflow <= 1);
    assert(g.content.height >= 160, `readable keyboard window at ${size}: ${g.content.height}`);
    assert(g.visibleReplyLines >= 1, `actual reply text remains visible at ${size}`);
    report.geometry.push(g);
    await page.locator('#keyboard-toggle').setChecked(false);
  }
  // With the keyboard up the short window hands the scene over to the composer on
  // purpose, so her own room is measured with the keyboard away.
  await page.locator('#device .dialogue-modes [data-mode="scene"]').click();
  await settle();
  const scene = await geometry();
  assert.equal(scene.mode, 'scene');
  assert(scene.companion?.width >= 60 && scene.companion?.height >= 60, `companion still has room at 320,640: ${JSON.stringify(scene.companion)}`);
  assert(scene.bubble?.height >= 40, `her speech bubble is readable in the smallest window: ${JSON.stringify(scene.bubble)}`);
  assert(scene.horizontalOverflow <= 1);
  report.geometry.push(scene);
  await page.locator('#device .dialogue-modes [data-mode="history"]').click();
  await page.locator('#motion-toggle').setChecked(true);
  await button('打开菜单').click();
  await button('关闭面板').click();
  assert.equal(await page.locator('.modal-host').isVisible(),false);
  await page.getByRole('tab',{name:'手记',exact:true}).click();
  assert.equal(await page.locator('.route-ghost').count(),0);
  assert.equal(await page.locator('#chat-input').count(),0);
  report.checks.push('motion off has no delayed overlay or input on the content tab');
  assert.deepEqual(errors, []);
  report.checks.push('three representative keyboard sizes; DOM width and readable space; companion keeps her seat and bubble in the smallest window; no page errors');
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
