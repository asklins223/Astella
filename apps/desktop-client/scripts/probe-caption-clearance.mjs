/**
 * Windows/Linux 贴右落位走查：原生标题按钮带（右侧 138×40）不该被任何常驻浮层压住，
 * 浮层仍然贴右缘、从 --native-caption-band 那条线起。
 *
 * 跑法：`npm run dev`（带 --remoteDebuggingPort 9222）后 `node scripts/probe-caption-clearance.mjs`。
 * 在 macOS 上跑会把根节点强制成 data-platform="win32" 并钉住 52px 这条带，
 * 所以量到的是 Windows 的几何，不是本机的 env() 值。
 */
import { chromium } from 'playwright'

const CAPTION = { width: 138, height: 40 }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost:5173'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)

if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="email"]', 'companion-probe@astella.local')
  await page.fill('input[type="password"]', 'probe-c37bpcz4')
  await page.getByRole('button', { name: /登录/ }).click()
}
await page.waitForSelector('.room-control', { timeout: 60000 })
await page.waitForTimeout(1200)

await page.evaluate((caption) => {
  const root = document.querySelector('.desktop-app')
  root.dataset.platform = 'win32'
  root.style.setProperty('--native-caption-band', `calc(${caption.height}px + 12px)`)
}, CAPTION)

const probe = (selectors) => page.evaluate(({ selectors, caption }) => {
  const box = { left: innerWidth - caption.width, top: 0, right: innerWidth, bottom: caption.height }
  return selectors.map((sel) => {
    const el = document.querySelector(sel)
    const cs = el ? getComputedStyle(el) : null
    if (!el || cs.display === 'none' || !el.getBoundingClientRect().height) return { sel, hidden: true }
    const b = el.getBoundingClientRect()
    return {
      sel, top: Math.round(b.top), bottom: Math.round(b.bottom),
      rightGap: Math.round(innerWidth - b.right),
      overlapsCaption: b.right > box.left && b.left < box.right && b.bottom > box.top && b.top < box.bottom,
    }
  })
}, { selectors, caption: CAPTION })

const rows = []
rows.push(...await probe(['.room-control', '.hud-rail']))
await page.locator('.room-control-trigger').click()
await page.waitForTimeout(600)
rows.push(...await probe(['.room-control']))
await page.locator('.room-control-trigger').click()
await page.waitForTimeout(600)

await page.getByRole('button', { name: /^笔记$/ }).first().click()
await page.waitForTimeout(2500)
await page.getByRole('button', { name: /^打开笔记/ }).first().click()
await page.waitForTimeout(3000)
await page.keyboard.press('Control+Shift+F')
await page.waitForTimeout(2000)
rows.push(...await probe(['.notebook-focus-ribbon', '.notebook-note-list__toggle', '.notebook-desk__chrome']))
await page.screenshot({ path: '/tmp/caption-clearance-win32-fullscreen.png' })

console.log(JSON.stringify(rows, null, 1))
const hit = rows.filter(r => r.overlapsCaption)
console.log(hit.length ? `FAIL 压住原生按钮: ${JSON.stringify(hit)}` : 'PASS 全部浮层未压住原生标题按钮，且仍贴右缘')
await page.reload({ waitUntil: 'networkidle' })
await browser.close()
process.exit(0)
