import { chromium } from 'playwright'
import './load-capture-env.mjs'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost'))
const chip = page.locator('.hud-rail .nav-chip[aria-label="今日学习"]')
const box = await chip.boundingBox()
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(400)
}
console.log('TAG', await page.evaluate(() => document.querySelector('.hud-nav-tag')?.textContent ?? null))
await page.screenshot({ path: 'outputs/audit-20261011/61-smoke-hover-tag.png' })
await browser.close()
