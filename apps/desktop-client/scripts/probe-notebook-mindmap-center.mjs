/**
 * 真窗口核验：脑图里选中节点后的居中落点（2026-10-08 用户指出全屏偏右）。
 *
 * 全屏里大纲／分支阅读页开在左边（见 note-mind-map.css），普通册页在右边。
 * 从大纲选节点时要把节点摆到「让开阅读页的那块可见区」正中，而不是整窗正中。
 *
 * 判据：两种模式各量一次节点中心与可见区中心的偏差（<=120px 记 ✓）。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/notebook-mindmap-center-20261008')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const expandRail = async () => {
  const toggle = page.locator('.hud-rail .nav-collapse')
  if (await toggle.count()) { await toggle.first().click().catch(() => undefined); await page.waitForTimeout(700) }
}
const hasMap = () => page.locator('.note-mind-map').count()
const openMindMap = async () => {
  await page.getByRole('button', { name: '速看' }).first().click().catch(() => undefined)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '脑图' }).first().click().catch(() => undefined)
  await page.waitForTimeout(1600)
  return hasMap()
}

await expandRail()
// 先退回普通册页：第一轮量的是阅读页在右的落点。
const exit = page.getByRole('button', { name: '退出全屏笔记' })
if (await exit.count()) { await exit.first().click().catch(() => undefined); await page.waitForTimeout(800) }
if (!(await page.locator('.notebook-desk').count())) {
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click().catch(() => undefined)
  await page.waitForTimeout(1600)
  await page.locator('.note-open').first().click().catch(() => undefined)
  await page.waitForTimeout(1800)
}

// —— 找一篇真的有脑图画布的笔记：没有内容时「脑图」挡只有生成入口，量不到居中 ——
if (!(await openMindMap())) {
  await page.locator('.notebook-note-list[data-fullscreen] .notebook-note-list__toggle, .notebook-note-list__toggle').first().click().catch(() => undefined)
  await page.waitForTimeout(800)
  const titles = await page.locator('.notebook-note-list li button, .notebook-note-list__item').allTextContents()
  for (const [index] of titles.entries()) {
    await page.locator('.notebook-note-list li button, .notebook-note-list__item').nth(index).click().catch(() => undefined)
    await page.waitForTimeout(1800)
    if (await openMindMap()) { log(`改用有脑图内容的一篇：${titles[index].replace(/\s+/g, ' ').slice(0, 30)}`); break }
  }
}
if (!(await hasMap())) { console.error('没有找到带脑图画布的笔记，无法量居中'); await browser.close(); process.exit(1) }

const measure = async (tag) => {
  const outline = page.getByRole('button', { name: '大纲' }).first()
  if (!(await outline.count())) { log(`${tag}：没有大纲入口`); return }
  await outline.click().catch(() => undefined)
  await page.waitForTimeout(700)
  // 先把画布拖开，让「未居中」这件事真的能被量出来。
  const box = await page.locator('.note-mind-map__viewport').boundingBox()
  if (box) { await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * .25, box.y + box.height / 2, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(400) }
  const items = page.locator('.note-mind-map__reading-pane .note-mind-map__outline button')
  if (!(await items.count())) { log(`${tag}：大纲里没有节点`); return }
  await items.nth(Math.min(1, (await items.count()) - 1)).click().catch(() => undefined)
  await page.waitForTimeout(1100)
  const result = await page.evaluate(() => {
    const node = document.querySelector('.note-mind-map__node[data-selected="true"]')
    const canvas = document.querySelector('.note-mind-map__viewport')
    const pane = document.querySelector('.note-mind-map__reading-pane')
    if (!node || !canvas) return null
    const area = canvas.getBoundingClientRect()
    const p = pane?.getBoundingClientRect()
    // 阅读页在左就让开左缘，在右就让开右缘：跟 note-mind-map-paper.tsx 的 readingBounds 同一套判断。
    const onLeft = p && p.left < area.left + area.width / 2
    const visible = p ? (onLeft ? [p.right + 24, area.right - 36] : [area.left + 36, p.left - 24]) : [area.left + 36, area.right - 36]
    const r = node.getBoundingClientRect()
    const center = (r.left + r.right) / 2
    const target = (visible[0] + visible[1]) / 2
    return { side: p ? (onLeft ? 'left' : 'right') : 'none', nodeCenter: Math.round(center), visibleLeft: Math.round(visible[0]), visibleRight: Math.round(visible[1]), visibleCenter: Math.round(target), delta: Math.round(Math.abs(center - target)), inside: center >= visible[0] && center <= visible[1] }
  })
  await page.screenshot({ path: join(outDir, `${tag}.png`) })
  log(`${tag}：阅读页=${result?.side} 节点中心=${result?.nodeCenter} 可见区=[${result?.visibleLeft},${result?.visibleRight}] 中心=${result?.visibleCenter} 偏差=${result?.delta}${result && result.delta <= 120 ? ' ✓' : ' ✗'}`)
  await page.getByRole('button', { name: '收起脑图阅读页' }).first().click().catch(() => undefined)
  await page.waitForTimeout(400)
}

await measure('10-ordinary')

const enter = async () => {
  for (const label of ['全屏脑图', '全屏笔记']) {
    const entry = page.getByRole('button', { name: label })
    if (await entry.count()) { await entry.first().click().catch(() => undefined); await page.waitForTimeout(800); return true }
  }
  await page.keyboard.press('Meta+Shift+f').catch(() => undefined)
  await page.waitForTimeout(800)
  return Boolean(await page.locator('.notebook-desk[data-fullscreen]').count())
}
if (!(await page.locator('.notebook-desk[data-fullscreen]').count())) await enter()
log(`全屏：${Boolean(await page.locator('.notebook-desk[data-fullscreen]').count())}`)
await measure('11-fullscreen')

await writeFile(join(outDir, 'center-geometry.json'), JSON.stringify({ notes }, null, 2))
log(`证据写出：${outDir}`)
await browser.close()
