/**
 * 首次进入的时序取证：带路开始与界面（surface）切换到底谁先谁后。
 *
 * 真窗口里看到的现象是「带路自动开始了，但同一秒被伴星中心顶掉并暂停」。
 * 这里不判断对错，只把 DOM 上能看见的事实按毫秒记下来：
 * 哪个界面开着、带路在第几站、通知气泡有没有出现过。
 */
import { chromium } from 'playwright'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const email = `guide-timing-${Math.random().toString(36).slice(2, 7)}@astella.local`
const password = `probe-${Math.random().toString(36).slice(2, 10)}`
const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => !p.url().includes('devtools'))
await page.bringToFront()

if (!(await page.locator('.desktop-access-gate').count())) {
  console.log('不是登出态，先退出登录')
  await page.locator('.hud-rail button[data-label="设置"]').click({ force: true })
  await page.waitForSelector('.settings-hud')
  await page.locator('.settings-menu button', { hasText: '账户与空间' }).first().click()
  await page.waitForTimeout(1000)
  const disc = page.locator('details').filter({ hasText: '退出登录' }).first()
  await disc.locator('summary').click()
  await page.waitForTimeout(600)
  await disc.locator('button').filter({ hasText: /退出/ }).first().click()
  await page.waitForSelector('.desktop-access-gate', { timeout: 30_000 })
}
if (!(await page.getByRole('button', { name: /创建账号/ }).count())) {
  await page.getByRole('button', { name: /还没有账号？注册/ }).click()
  await page.waitForTimeout(400)
}
await page.locator('.desktop-access-gate input[type="email"]').fill(email)
const fields = page.locator('.desktop-access-gate input[type="password"]')
await fields.nth(0).fill(password)
if (await fields.count() > 1) await fields.nth(1).fill(password)

/** 页面里每 80ms 采一次样；采到的原始行先攒着，注册点击后才开始。 */
await page.evaluate(() => {
  const rows = (window.__timeline = [])
  const surfaceNames = ['settings-hud', 'companion-center', 'note-library', 'task-surface']
  const sample = () => rows.push({
    at: Math.round(performance.now()),
    stage: document.querySelector('.guidance-stage')?.dataset.step ?? null,
    surface: surfaceNames.find(name => document.querySelector('.' + name)) ?? (document.querySelector('[data-surface]') ? 'some-surface' : null),
    notice: Boolean(document.querySelector('.companion-notification-paper')),
    firstSpace: Boolean(document.querySelector('.first-space')),
  })
  sample()
  window.__timer = setInterval(sample, 80)
})
await page.getByRole('button', { name: /创建账号/ }).click()
await page.waitForTimeout(14_000)
const rows = await page.evaluate(() => { clearInterval(window.__timer); return window.__timeline })
await browser.close()

let last = null
for (const row of rows) {
  const line = `${String(row.at).padStart(6)}ms 带路=${row.stage ?? '-'} 界面=${row.surface ?? '-'} 通知=${row.notice ? '有' : '-'} 首次那张纸=${row.firstSpace ? '有' : '-'}`
  if (line !== last) console.log(line)
  last = line
}
console.log(`账号：${email} / ${password}`)
