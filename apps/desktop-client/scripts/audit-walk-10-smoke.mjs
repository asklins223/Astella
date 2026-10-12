/** 冒烟：改动后的隔离窗口能否登录、导航、目录标签与 Esc 路径。 */
import { chromium } from 'playwright'
import './load-capture-env.mjs'

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]

if (await page.locator('.desktop-access-gate input[type="email"]').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill('companion-probe@astella.local')
  await page.locator('.desktop-access-gate input[type="password"]').first().fill('probe-c37bpcz4')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
await page.waitForSelector('.hud-rail', { timeout: 90_000 })
await page.waitForTimeout(2200)
const rail = await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail .nav-chip')).map(b => ({ aria: b.getAttribute('aria-label'), title: b.title })))
console.log('RAIL', JSON.stringify(rail))

// 悬停标签
const tagShown = await page.evaluate(() => {
  const chip = Array.from(document.querySelectorAll('.hud-rail .nav-chip')).find(b => (b.getAttribute('aria-label') ?? '') === '今日学习')
  chip?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
  return true
})
await page.waitForTimeout(300)
console.log('TAG', await page.evaluate(() => document.querySelector('.hud-nav-tag')?.textContent ?? null))
await page.screenshot({ path: 'outputs/audit-20261011/60-smoke-home.png' })

// Esc 从笔记回：应回到笔记库（returnTarget）而非首页
await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))?.click())
await page.waitForTimeout(1500)
await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).find(b => (b.textContent ?? '').trim().startsWith('打开笔记：'))?.click())
await page.waitForFunction(() => document.body.innerText.includes('返回笔记库'), null, { timeout: 20000 })
await page.waitForTimeout(1300)
await page.keyboard.press('Escape')
await page.waitForTimeout(1500)
console.log('ESC LANDING', await page.evaluate(() => ({ noteList: document.body.innerText.includes('全部笔记'), home: document.body.innerText.includes('今日下一步') })))
const errs = await page.evaluate(() => (window.__auditErrors ?? []).length)
console.log('DONE errors', errs)
await browser.close()
