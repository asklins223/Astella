/**
 * 启发式体验走查（2026-10-11）：登录 + 首页导航结构采集。
 * 附着 `npx electron-vite dev --remoteDebuggingPort 9223 -- --user-data-dir=/tmp/astella-dev-window`。
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

if (await page.locator('.desktop-access-gate input[type="email"]').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill('companion-probe@astella.local')
  await page.locator('.desktop-access-gate input[type="password"]').first().fill('probe-c37bpcz4')
  await page.getByRole('button', { name: '登录', exact: true }).click()
}
await page.waitForSelector('.hud-rail', { timeout: 90_000 })
await page.waitForTimeout(2500)

const dump = await page.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const label = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
  const rail = Array.from(document.querySelectorAll('.hud-rail button, .hud-rail a')).filter(visible).map(label)
  const top = Array.from(document.querySelectorAll('header button, header a, [class*="topbar"] button, [class*="island"] button')).filter(visible).map(label)
  const all = Array.from(document.querySelectorAll('button, a[role="button"]')).filter(visible)
  return {
    title: document.title,
    rail,
    top: [...new Set(top)].slice(0, 40),
    buttons: [...new Set(all.map(label))].slice(0, 120),
    url: location.href,
  }
})
log(`HOME ${JSON.stringify(dump, null, 1)}`)
await page.screenshot({ path: `${outDir}/01-home.png` })

await writeFile(`${outDir}/notes.md`, '# 启发式走查 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log(`DONE ${outDir}`)
await browser.close()
