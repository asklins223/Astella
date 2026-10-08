/**
 * 真窗口核验：全屏里的浮层落位（2026-10-08 用户裁决）。
 *
 * 用户指出三处遮挡（截图红框）：批注旁页被右下伴星压住；脑图的要点/脑图页签顶到原生
 * 红绿灯、信息岛与「笔记列表」相叠；脑图阅读页（大纲/分支）盖住右侧画布。
 * 裁决：全屏里批注旁页与脑图的这些抽屉全部放左边，右侧留给伴星。
 *
 * 判据：量出每个浮层的 rect 与左缘对齐情况、以及两两是否重叠；并留截图。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/notebook-fullscreen-panels-20261008')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const rects = () => page.evaluate(() => {
  const one = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]
  }
  const visible = (sel) => { const el = document.querySelector(sel); return Boolean(el && el.getClientRects().length) }
  return {
    inner: [window.innerWidth, window.innerHeight],
    fullscreen: document.querySelector('.notebook-desk')?.hasAttribute('data-fullscreen') ?? false,
    view: document.querySelector('.notebook-desk')?.getAttribute('data-view') ?? null,
    noteListToggle: visible('.notebook-note-list[data-fullscreen] .notebook-note-list__toggle') ? one('.notebook-note-list[data-fullscreen] .notebook-note-list__toggle') : null,
    overviewTabs: visible('.notebook-overview-tabs') ? one('.notebook-overview-tabs') : null,
    infoIsland: visible('.note-mind-map__info-island') ? one('.note-mind-map__info-island') : null,
    mapNotice: visible('.note-mind-map__notice') ? one('.note-mind-map__notice') : null,
    mapToolbar: visible('.note-mind-map__toolbar') ? one('.note-mind-map__toolbar') : null,
    readingPane: visible('.note-mind-map__reading-pane') ? one('.note-mind-map__reading-pane') : null,
    ribbon: visible('.notebook-focus-ribbon') ? one('.notebook-focus-ribbon') : null,
    toolsPage: visible('.notebook-desk[data-fullscreen] .notebook-desk__chrome') ? one('.notebook-desk[data-fullscreen] .notebook-desk__chrome') : null,
    sidePage: visible('.notebook-desk__side-page') ? one('.notebook-desk__side-page') : null,
    index: visible('.notebook-desk__index:not([inert])') ? one('.notebook-desk__index:not([inert])') : null,
    sceneAnchor: visible('.companion-presence .companion-scene-anchor') ? one('.companion-presence .companion-scene-anchor') : null,
    hud: visible('.companion-hud__panel') ? one('.companion-hud__panel') : null,
    badge: visible('.note-annotation-badge') ? one('.note-annotation-badge') : null,
  }
})

const overlap = (a, b) => {
  if (!a || !b) return null
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  return w > 0 && h > 0 ? [w, h] : null
}

// —— 确认在笔记 + 全屏 ——
// 目录纸签条可能处于收起态（nav-collapsed），此时 .nav-chip 全部叠在同一位置、点不到。
const expandRail = async () => {
  const toggle = page.locator('.hud-rail .nav-collapse')
  if (await toggle.count()) { await toggle.first().click().catch(() => undefined); await page.waitForTimeout(700) }
}
await expandRail()
if (!(await page.locator('.notebook-desk').count())) {
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click().catch(() => undefined)
  await page.waitForTimeout(1200)
  await page.locator('.note-open').first().click().catch(() => undefined)
  await page.waitForTimeout(1800)
}
if (!(await page.getByRole('button', { name: '退出全屏笔记' }).count())) {
  for (const label of ['全屏笔记', '全屏脑图']) {
    const entry = page.getByRole('button', { name: label })
    if (await entry.count()) { await entry.first().click().catch(() => undefined); await page.waitForTimeout(700); break }
  }
  // 都点不到时按快捷键：全屏现在是这一页的显示模式，⌘/Ctrl+Shift+F 在所有视图都该生效。
  if (!(await page.locator('.notebook-desk[data-fullscreen]').count())) {
    await page.keyboard.press('Meta+Shift+f').catch(() => undefined)
    await page.waitForTimeout(700)
  }
}
log(`起点：${JSON.stringify(await rects())}`)

const openToolsIfClosed = async () => {
  const expand = page.getByRole('button', { name: '展开笔记工具' })
  if (await expand.count()) { await expand.first().click(); await page.waitForTimeout(500) }
}

// —— 一：旁页落位（批注/资料袋共用同一张旁页） ——
const badge = page.locator('.note-annotation-badge').first()
if (await badge.count()) {
  await badge.click({ force: true }).catch(() => undefined)
  await page.waitForTimeout(900)
  const r = await rects()
  await page.screenshot({ path: join(outDir, '01-annotation-side.png') })
  log(`批注旁页：旁页=${JSON.stringify(r.sidePage)} 伴星座=${JSON.stringify(r.sceneAnchor)} 重叠=${JSON.stringify(overlap(r.sidePage, r.sceneAnchor))}`)
  await page.getByRole('button', { name: '收起批注' }).first().click().catch(() => undefined)
  await page.waitForTimeout(500)
} else {
  log('这篇没有批注角标；改用资料袋量同一张旁页')
}
if (!(await page.locator('.notebook-desk__side-page').count())) {
  await openToolsIfClosed()
  await page.getByRole('button', { name: '资料袋' }).first().click().catch(() => undefined)
  await page.waitForTimeout(900)
  const r = await rects()
  await page.screenshot({ path: join(outDir, '01b-source-side.png') })
  log(`资料袋旁页：旁页=${JSON.stringify(r.sidePage)} 伴星座=${JSON.stringify(r.sceneAnchor)} 重叠=${JSON.stringify(overlap(r.sidePage, r.sceneAnchor))} 与纸面右缘=[${r.inner[0] - 298}]`)
  await page.getByRole('button', { name: '合起资料袋' }).first().click().catch(() => undefined)
  await page.waitForTimeout(500)
}

// —— 二：速看脑图里的抽屉 ——
await openToolsIfClosed()
await page.getByRole('button', { name: '速看' }).first().click().catch(() => undefined)
await page.waitForTimeout(800)
await page.getByRole('button', { name: '脑图' }).first().click().catch(() => undefined)
await page.waitForTimeout(1400)
const mapBase = await rects()
await page.screenshot({ path: join(outDir, '02-mind-map-base.png') })
log(`脑图（无抽屉）：页签=${JSON.stringify(mapBase.overviewTabs)} 笔记列表=${JSON.stringify(mapBase.noteListToggle)} 信息岛=${JSON.stringify(mapBase.infoIsland)} 页签×列表重叠=${JSON.stringify(overlap(mapBase.overviewTabs, mapBase.noteListToggle))} 列表×信息岛重叠=${JSON.stringify(overlap(mapBase.noteListToggle, mapBase.infoIsland))} 工具条=${JSON.stringify(mapBase.mapToolbar)}`)
if (mapBase.toolsPage) log(`工具页（贴右缘）：${JSON.stringify(mapBase.toolsPage)} 右缘距窗口=${mapBase.inner[0] - mapBase.toolsPage[2]} 与伴星座重叠=${JSON.stringify(overlap(mapBase.toolsPage, mapBase.sceneAnchor))}`)

// 脑图里打开旁页：信息岛应先让开，旁页落左列
await page.getByRole('button', { name: '资料袋' }).first().click().catch(() => undefined)
await page.waitForTimeout(900)
const sideInMap = await rects()
await page.screenshot({ path: join(outDir, '02b-mind-map-side.png') })
if (sideInMap.sidePage) log(`脑图里资料袋：旁页=${JSON.stringify(sideInMap.sidePage)} 信息岛可见=${Boolean(sideInMap.infoIsland)} 与伴星座重叠=${JSON.stringify(overlap(sideInMap.sidePage, sideInMap.sceneAnchor))}`)
await page.getByRole('button', { name: '合起资料袋' }).first().click().catch(() => undefined)
await page.waitForTimeout(500)

const outline = page.getByRole('button', { name: '大纲' }).first()
if (await outline.count()) {
  await outline.click()
  await page.waitForTimeout(700)
  const r = await rects()
  await page.screenshot({ path: join(outDir, '03-mind-map-outline.png') })
  log(`脑图大纲：阅读页=${JSON.stringify(r.readingPane)} 与画布中心区重叠（右侧内容）=${JSON.stringify(overlap(r.readingPane, [r.inner[0] / 2, 0, r.inner[0], r.inner[1]]))} 与信息岛重叠=${JSON.stringify(overlap(r.readingPane, r.infoIsland))}`)
  // 全屏里阅读页在左：拖开画布后从大纲选节点，应居中在「旁页右侧的可见区」而不是整窗中心。
  const canvas = page.locator('.note-mind-map__viewport')
  const box = await canvas.boundingBox()
  if (box) { await page.mouse.move(box.x + 900, box.y + 400); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 400, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(400) }
  await page.locator('.note-mind-map__reading-pane .note-mind-map__outline button').nth(1).click().catch(() => undefined)
  await page.waitForTimeout(1000)
  const centered = await page.evaluate(() => {
    const node = document.querySelector('.note-mind-map__node[data-selected="true"]')
    const pane = document.querySelector('.note-mind-map__reading-pane')
    if (!node || !pane) return null
    const paneRight = pane.getBoundingClientRect().right
    const visible = [paneRight + 24, window.innerWidth - 36]
    const nodeCenter = (node.getBoundingClientRect().left + node.getBoundingClientRect().right) / 2
    return { nodeCenter: Math.round(nodeCenter), visibleCenter: Math.round((visible[0] + visible[1]) / 2), delta: Math.round(Math.abs(nodeCenter - (visible[0] + visible[1]) / 2)) }
  })
  await page.screenshot({ path: join(outDir, '03b-mind-map-recenter.png') })
  log(`全屏里从大纲选节点：节点中心=${centered?.nodeCenter} 可见区中心=${centered?.visibleCenter} 偏差=${centered?.delta}${centered && centered.delta <= 120 ? " ✓" : " ✗"}`)
  await page.getByRole('button', { name: '收起脑图阅读页' }).first().click().catch(() => undefined)
  await page.waitForTimeout(400)
}

// —— 三：把窗口内容（不带工具页）再照一张 ——
await openToolsIfClosed()
await page.waitForTimeout(300)
await page.screenshot({ path: join(outDir, '04-mind-map-clean.png') })

await writeFile(join(outDir, 'panel-geometry.json'), JSON.stringify({ notes }, null, 2))
log(`证据写出：${outDir}`)
await browser.close()
