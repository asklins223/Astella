import { chromium } from 'playwright'
import './load-capture-env.mjs'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost'))
const session = await context.newCDPSession(page)
await session.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 405, deviceScaleFactor: 1, mobile: false })
await page.waitForTimeout(1200)
await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('首页'))?.click())
await page.waitForTimeout(2600)
const rail = await page.evaluate(() => {
  const el = document.querySelector('.hud-rail')
  const chips = Array.from(document.querySelectorAll('.hud-rail .nav-chip'))
  const last = chips.at(-1)?.getBoundingClientRect()
  return {
    scrollH: el?.scrollHeight, clientH: el?.clientHeight,
    overflowing: (el?.scrollHeight ?? 0) > (el?.clientHeight ?? 0) + 1,
    lastChip: chips.at(-1)?.getAttribute('aria-label'),
    lastVisible: last ? last.bottom <= (el?.getBoundingClientRect().bottom ?? 0) + 1 : false,
  }
})
console.log('RAIL@720x405', JSON.stringify(rail))
await page.screenshot({ path: 'outputs/audit-20261011/71-rail-720x405.png' })
await session.send('Emulation.clearDeviceMetricsOverride')
await browser.close()
