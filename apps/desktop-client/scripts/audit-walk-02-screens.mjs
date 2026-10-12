/**
 * 启发式体验走查（2026-10-11）：主流程逐屏截图。
 * 附着 9223 隔离窗口；HUD 轨道会被拦 pointer events，一律 element.click()。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]

const clickRail = async (name) => {
  await page.evaluate((n) => {
    const btn = Array.from(document.querySelectorAll('.hud-rail button'))
      .find(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(n))
    btn?.click()
  }, name)
}
const settle = (ms = 1600) => page.waitForTimeout(ms)
const shot = (file) => page.screenshot({ path: `${outDir}/${file}` })
const dump = () => page.evaluate(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const label = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 70)
  return [...new Set(Array.from(document.querySelectorAll('main button, [class*="surface"] button, [role="dialog"] button, .task-surface button'))
    .filter(visible).map(label))].slice(0, 80)
})

await page.waitForSelector('.hud-rail', { timeout: 60_000 })

// 来源
await clickRail('来源'); await settle()
log(`SOURCE ${JSON.stringify(await dump())}`)
await shot('02-source.png')

// 笔记
await clickRail('笔记'); await settle()
log(`NOTES ${JSON.stringify(await dump())}`)
await shot('03-notes.png')

// 打开第一篇笔记（若有）
const opened = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label') ?? '').includes('打开笔记') || b.textContent?.includes('打开'))
  if (btn) { btn.click(); return btn.getAttribute('aria-label') ?? btn.textContent }
  return null
})
if (opened) {
  await settle(2200)
  log(`NOTE OPEN ${JSON.stringify({ opened, buttons: await dump() })}`)
  await shot('04-note-reading.png')
}

// 查找
await clickRail('查找'); await settle()
log(`SEARCH ${JSON.stringify(await dump())}`)
await shot('05-search.png')

// 今日学习
await clickRail('今日学习'); await settle()
log(`TODAY ${JSON.stringify(await dump())}`)
await shot('06-today.png')

// 复习
await clickRail('复习'); await settle()
log(`REVIEW ${JSON.stringify(await dump())}`)
await shot('07-review.png')

// 星图
await clickRail('星图'); await settle(2400)
log(`STARMAP ${JSON.stringify(await dump())}`)
await shot('08-starmap.png')

// 设置
await clickRail('设置'); await settle()
log(`SETTINGS ${JSON.stringify(await dump())}`)
await shot('09-settings.png')

// 回首页 → 伴星中心
await clickRail('首页'); await settle(1200)
await page.evaluate(() => document.querySelector('.hud-rail button[aria-label="伴星"]')?.click())
await settle(2400)
log(`COMPANION ${JSON.stringify(await dump())}`)
await shot('10-companion-center.png')

// 对话手记
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes('对话手记'))
  b?.click()
})
await settle(1800)
log(`JOURNAL ${JSON.stringify(await dump())}`)
await shot('11-journal.png')

await writeFile(`${outDir}/walk.md`, '# 主流程逐屏走查 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log(`DONE ${outDir}`)
await browser.close()
