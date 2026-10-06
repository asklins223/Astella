/**
 * 真窗口核验：理解星图（页 19）画布真的有内容。
 *
 * 附着到 `npm run dev` 起的客户端（CDP 9222），登录 → 按 `g` 打开星图，
 * 然后量三件事：画布根的实测盒子、画布的像素缓冲、以及**画布里非透明像素的占比**。
 * 最后一项才是结论——「控件都在、图是空的」这件事只有它能证伪。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, 'graph-verify')
await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0] ?? (await context.newPage())

const consoleErrors = []
const pageErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.waitForFunction(
  () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate')),
  undefined,
  { timeout: 60_000 },
)

const where = await page.evaluate(() => ({
  gate: Boolean(document.querySelector('.desktop-access-gate')),
  rail: Boolean(document.querySelector('.hud-rail')),
  hudPage: document.querySelector('.desktop-app')?.getAttribute('data-hud-page') ?? null,
}))
console.log('WHERE', JSON.stringify(where))

if (where.gate && !where.rail) {
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const deadline = Date.now() + 45_000
  let chosen = false
  while (Date.now() < deadline && !(await page.locator('.hud-rail').count())) {
    const formError = page.locator('.desktop-access-gate__form-error')
    if (await formError.count()) throw new Error(`登录失败：${await formError.innerText()}`)
    const workspaces = page.locator('.desktop-access-gate__workspace-list button')
    if (!chosen && (await workspaces.count())) {
      const owner = workspaces.filter({ hasText: '所有者' }).first()
      await (await owner.count() ? owner : workspaces.first()).click()
      chosen = true
    }
    await page.waitForTimeout(400)
  }
  console.log('SIGNED_IN', Boolean(await page.locator('.hud-rail').count()))
}

if ((await page.evaluate(() => document.querySelector('.desktop-app')?.getAttribute('data-hud-page'))) !== '19') {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press('g')
}
await page.waitForTimeout(2500)

const read = () => page.evaluate(() => {
  const root = document.querySelector('.universe-canvas-root')
  const canvas = document.querySelector('.universe-canvas-surface')
  if (!root || !canvas) return { present: false }
  const ctx = canvas.getContext('2d')
  // 整张读一遍太贵：抽样 400×400 的中心窗格，数非透明像素。
  const w = canvas.width
  const h = canvas.height
  const sw = Math.min(w, 800)
  const sh = Math.min(h, 800)
  let painted = 0
  let sampled = 0
  if (ctx && w > 0 && h > 0) {
    const data = ctx.getImageData(Math.max(0, (w - sw) / 2 | 0), Math.max(0, (h - sh) / 2 | 0), sw, sh).data
    sampled = sw * sh
    for (let i = 3; i < data.length; i += 4 * 37) { if (data[i] > 8) painted += 1 }
  }
  return {
    present: true,
    rootBox: [root.offsetWidth, root.offsetHeight],
    rootPosition: getComputedStyle(root).position,
    canvasCss: [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)],
    backingStore: [canvas.width, canvas.height],
    paintedSamples: painted,
    totalSamples: Math.ceil(sampled / 37),
    telemetry: document.querySelector('.universe-layer-readout')?.textContent?.trim() ?? null,
    filters: [...document.querySelectorAll('.universe-filter')].map((n) => n.textContent?.trim()),
    dpr: window.devicePixelRatio,
  }
})

const withFix = await read()
console.log('UNIVERSE', JSON.stringify(withFix, null, 1))
await page.screenshot({ path: resolve(outDir, '19-graph-fixed.png') })

await writeFile(resolve(outDir, 'universe-live.json'),
  JSON.stringify({ where, withFix, consoleErrors, pageErrors }, null, 1))
console.log('CONSOLE_ERRORS', consoleErrors.length, 'PAGE_ERRORS', pageErrors.length)
if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'))
await browser.close()
