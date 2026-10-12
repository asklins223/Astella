import { chromium } from 'playwright'
import { resolve } from 'node:path'
import './load-capture-env.mjs'
const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost'))
const settle = (ms = 1200) => page.waitForTimeout(ms)
const log = (l) => console.log(l)

// A. 720×405（200% 缩放验收视口）下的字号
const session = await context.newCDPSession(page)
await session.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 405, deviceScaleFactor: 1, mobile: false })
await settle(1200)
await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('今日学习'))?.click())
await settle(1600)
const fonts = await page.evaluate(() => {
  const pick = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontSize : null }
  const smallest = (() => {
    let min = 99, texts = []
    for (const el of document.querySelectorAll('button, p, small, .sub, .meta')) {
      if (!el.getBoundingClientRect().width) continue
      const fs = parseFloat(getComputedStyle(el).fontSize)
      if (fs && fs < min) { min = fs; texts = [ (el.textContent||'').trim().slice(0,24) ] }
      else if (fs === min) texts.push((el.textContent||'').trim().slice(0,24))
    }
    return { min, texts: texts.slice(0, 5) }
  })()
  return {
    vw: innerWidth,
    button: pick('.button'), sub: pick('.sub'), small: pick('.small'),
    docOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    smallest,
  }
})
log(`FONTS@720x405 ${JSON.stringify(fonts)}`)
await page.screenshot({ path: `${outDir}/50-today-720x405.png` })
await session.send('Emulation.clearDeviceMetricsOverride')
await settle(800)

// B. Esc 返回路径：打开笔记 → Esc → 落点
await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))?.click())
await settle(1500)
await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).find(b => (b.textContent ?? '').trim().startsWith('打开笔记：'))?.click())
await page.waitForFunction(() => document.body.innerText.includes('返回笔记库'), null, { timeout: 20000 })
await settle(1400)
await page.keyboard.press('Escape')
await settle(1500)
const afterEsc = await page.evaluate(() => ({
  onHome: document.body.innerText.includes('今日下一步'),
  onNoteList: document.body.innerText.includes('全部笔记'),
  onNote: document.body.innerText.includes('返回笔记库'),
}))
log(`ESC FROM NOTE ${JSON.stringify(afterEsc)}`)

// C. 目录栏悬停是否有标签提示
const rail = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('今日学习'))
  return btn ? { title: btn.title || null, dataLabel: btn.getAttribute('data-label'), aria: btn.getAttribute('aria-label') } : null
})
log(`RAIL ENTRY ${JSON.stringify(rail)}`)
await browser.close()
