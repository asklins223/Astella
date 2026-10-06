/**
 * 「正在上传…」的视觉核对图（2026-10-06）。
 *
 * 真状态只存在 ~40ms（本地 API 太快），截图追不上；这里在**真实的取景框**上按真实
 * 标记与真实图标（lucide loader-circle 的 path）注入同一段 DOM，拍一张设计核对图。
 * 接线（这段状态真的会出现、持续多久）由 8ms 轮询时间线在
 * probe-avatar-upload-progress.mjs 里证明；本脚本不点确认、不上传、不改任何数据。
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/avatar-crop-20261006')
await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0]

await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
if (!(await page.locator('.settings-hud').count())) {
  await page.locator('.hud-rail button[data-label="设置"]').first().click({ force: true })
  await page.waitForSelector('.settings-hud', { timeout: 20_000 })
}
if (!(await page.locator('.settings-identity').count())) {
  await page.locator('.settings-menu button', { hasText: '账户与空间' }).first().click()
}
await page.waitForSelector('.settings-identity__avatar, .settings-identity__seal', { timeout: 20_000 })

await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 500
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 1200, 500)
  gradient.addColorStop(0, '#d9a03c')
  gradient.addColorStop(1, '#4d7f6a')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 1200, 500)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const input = document.querySelector('.settings-file-input')
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], 'visual.png', { type: 'image/png' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForSelector('.avatar-crop', { timeout: 15_000 })
await page.waitForSelector('.avatar-crop__preparing', { state: 'detached', timeout: 15_000 })
await page.waitForTimeout(300)

await page.evaluate(() => {
  const card = document.querySelector('.avatar-crop')
  const busy = document.createElement('div')
  busy.className = 'avatar-crop__busy'
  busy.setAttribute('role', 'status')
  busy.innerHTML = '<svg class="avatar-crop__spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span>正在上传…</span>'
  card.querySelector('.avatar-crop__stage').appendChild(busy)
  const primary = [...card.querySelectorAll('button')].find((b) => b.textContent.includes('使用这张'))
  primary.disabled = true
  primary.textContent = '正在上传…'
  for (const button of card.querySelectorAll('.avatar-crop__controls button')) button.disabled = true
  card.querySelector('.avatar-crop__zoom input').disabled = true
})

const box = await page.evaluate(() => {
  const rect = document.querySelector('.avatar-crop').getBoundingClientRect()
  return { x: Math.max(0, rect.x - 16), y: Math.max(0, rect.y - 16), width: rect.width + 32, height: rect.height + 32 }
})
await page.screenshot({ path: join(outDir, '11-uploading-visual.png'), clip: box })

// 收工：Escape 关框（没点确认，什么都没上传），再拍一张收尾状态。
await page.keyboard.press('Escape')
await page.waitForSelector('.avatar-crop', { state: 'detached', timeout: 10_000 })
await page.screenshot({ path: join(outDir, '11b-after-visual.png') })
console.log('VISUAL_OK')
await browser.close()
