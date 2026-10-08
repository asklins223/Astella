/**
 * 真窗口核验：全屏覆盖全部子页面（2026-10-08）。
 *
 * 用户决定：全屏是笔记页面的显示模式，速看、回想、往外学、记录（等等）都留在同一张
 * 整窗纸面里——点这些页签不再切换回普通册页。
 *
 * 判据（不是"看起来像"）：
 *   1. 全屏里点四个页签后 `.notebook-desk[data-fullscreen]` 仍在，`.notebook-focus-ribbon`
 *      仍在（退出全屏一直可达）；
 *   2. 每个子页面都有它自己的 `data-view` 与真实排版几何（页面宽、滚动内边距）；
 *   3. 不在全屏时从子页面里也能进全屏（页内的「全屏」按钮与快捷键各验一次）。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/notebook-fullscreen-subpages-20261008')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.waitForLoadState('domcontentloaded')

if (await page.locator('.desktop-access-gate').count()) {
  log('登录门可见，用探测账号进入')
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local')
  await page.locator('.desktop-access-gate input[type="password"]').first().fill(process.env.ASTELLA_PROBE_PASSWORD ?? 'probe-c37bpcz4')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
}
await page.waitForTimeout(2000)

const geometry = () => page.evaluate(() => {
  const desk = document.querySelector('.notebook-desk')
  const paper = document.querySelector('.notebook-desk__page')
  const scroll = document.querySelector('.notebook-desk__scroll')
  const cs = scroll ? getComputedStyle(scroll) : null
  const rect = (el) => el ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) } : null
  return {
    inner: [window.innerWidth, window.innerHeight],
    appFullscreen: document.querySelector('.desktop-app')?.getAttribute('data-notebook-fullscreen') !== null,
    deskFullscreen: desk?.getAttribute('data-fullscreen') !== null,
    view: desk?.getAttribute('data-view') ?? null,
    ribbon: Boolean(document.querySelector('.notebook-focus-ribbon')),
    exitButton: Boolean([...document.querySelectorAll('.notebook-focus-ribbon button')].find(b => b.getAttribute('aria-label') === '退出全屏笔记')),
    desk: rect(desk), paper: rect(paper),
    scrollPadding: cs ? [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' ') : null,
    paperFont: paper ? getComputedStyle(paper).fontSize : null,
    subPage: {
      overview: document.querySelector('.note-overview-paper, .notebook-overview-tabs, .notebook-learning-page')?.className ?? null,
      recall: document.querySelector('.note-recall-paper, .notebook-learning-page')?.className ?? null,
      expansion: document.querySelector('.note-expansion-shelf')?.className ?? null,
      history: document.querySelector('.notebook-journey')?.className ?? null,
    },
  }
})

const openToolsIfClosed = async () => {
  const expand = page.getByRole('button', { name: '展开笔记工具' })
  if (await expand.count()) { await expand.first().click(); await page.waitForTimeout(500) }
}

// —— 进入笔记 ——
if (!(await page.locator('.notebook-desk').count())) {
  const railChip = page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first()
  if (await railChip.count()) { await railChip.click().catch(() => undefined); await page.waitForTimeout(1200) }
  const open = page.locator('.note-open').first()
  if (!(await open.count())) { log('笔记库里找不到可打开的笔记行'); }
  else { await open.click(); await page.waitForTimeout(1800) }
  if (!(await page.locator('.notebook-desk').count()) && await page.locator('.note-shelf-all').count()) {
    await page.locator('.note-shelf-all').first().click().catch(() => undefined)
    await page.waitForTimeout(900)
    if (await open.count()) { await open.click(); await page.waitForTimeout(1800) }
  }
}
await page.locator('.notebook-desk').first().waitFor({ timeout: 30_000 })
const noteTitle = await page.locator('.notebook-volume__trail > span, #notebook-reading-leaf').first().textContent().catch(() => null)
log(`打开的笔记：${(noteTitle ?? '（读不到标题）').trim().slice(0, 40)}`)

// —— 子页面里直接进全屏（页内按钮） ——
await page.getByRole('button', { name: '速看' }).first().click({ force: true }).catch(() => undefined)
await page.waitForTimeout(800)
const entryVisible = await page.getByRole('button', { name: '全屏笔记' }).count()
log(`速看里「全屏」入口：${entryVisible ? '在' : '不在'}`)
if (entryVisible) { await page.getByRole('button', { name: '全屏笔记' }).first().click(); await page.waitForTimeout(700) }
let g = await geometry()
log(`从速看进全屏后：${JSON.stringify({ appFullscreen: g.appFullscreen, deskFullscreen: g.deskFullscreen, view: g.view, ribbon: g.ribbon })}`)

// 退出来，改用快捷键从子页面进
await page.getByRole('button', { name: '退出全屏笔记' }).first().click().catch(() => undefined)
await page.waitForTimeout(600)
await page.keyboard.press('Control+Shift+F')
await page.waitForTimeout(700)
g = await geometry()
log(`速看里 Ctrl+Shift+F 后：deskFullscreen=${g.deskFullscreen} ribbon=${g.ribbon}`)

// —— 全屏里逐个页签截证据 ——
const shots = []
const views = [['速看', 'overview'], ['回想', 'recall'], ['往外学', 'expansion'], ['记录', 'history']]
let index = 0
for (const [label, id] of views) {
  await openToolsIfClosed()
  const tab = page.getByRole('button', { name: label === '记录' ? '学习记录' : label }).first()
  if (!(await tab.count())) { log(`${label}：工具页里找不到页签`); continue }
  await tab.click()
  await page.waitForTimeout(900)
  const state = await geometry()
  const shot = join(outDir, `0${++index}-${id}.png`)
  await page.screenshot({ path: shot })
  shots.push({ label, id, ...state })
  log(`${label}：data-view=${state.view} 全屏=${state.deskFullscreen} 折签=${state.ribbon} 纸面宽=${state.paper?.width} 滚动内边距=[${state.scrollPadding}] 子页内容=${JSON.stringify(state.subPage)}`)
}

await writeFile(join(outDir, 'measurements.json'), JSON.stringify({ shots, notes }, null, 2))

// —— 速看里的脑图：全屏里画布占满整窗，右缘避开伴星座位 ——
await openToolsIfClosed()
await page.getByRole('button', { name: '速看' }).first().click().catch(() => undefined)
await page.waitForTimeout(800)
const brainTab = page.getByRole('button', { name: '脑图' }).first()
if (await brainTab.count()) {
  await brainTab.click()
  await page.waitForTimeout(1400)
  const mapState = await page.evaluate(() => {
    const map = document.querySelector('.note-mind-map')
    const canvas = document.querySelector('.note-mind-map__viewport')
    const toolbar = document.querySelector('.note-mind-map__toolbar')
    const companion = document.querySelector('.companion-presence')
    const right = (el) => el ? Math.round(el.getBoundingClientRect().right) : null
    const left = (el) => el ? Math.round(el.getBoundingClientRect().left) : null
    return { dataFullscreen: map?.getAttribute('data-fullscreen'), canvas: canvas ? { w: Math.round(canvas.getBoundingClientRect().width), h: Math.round(canvas.getBoundingClientRect().height) } : null, toolbarRight: right(toolbar), companionLeft: left(companion) }
  })
  await page.screenshot({ path: join(outDir, '05-mind-map.png') })
  log(`脑图：data-fullscreen=${mapState.dataFullscreen} 画布=${JSON.stringify(mapState.canvas)} 工具条右缘=${mapState.toolbarRight} 伴星左缘=${mapState.companionLeft}`)
} else {
  log('这篇笔记没有「脑图」页签（没有已存脑图），跳过脑图截图')
}

// —— Esc 链：先收工具、再退出全屏，且退出后仍停在刚才的子页面 ——
await openToolsIfClosed()
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
const afterFirstEsc = await geometry()
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const afterSecondEsc = await geometry()
log(`Esc 第一次：全屏=${afterFirstEsc.deskFullscreen}（应先只收工具）；Esc 第二次：全屏=${afterSecondEsc.deskFullscreen} 视图=${afterSecondEsc.view}`)
await page.screenshot({ path: join(outDir, '06-after-exit.png') })

log(`证据写出：${outDir}`)
await browser.close()
