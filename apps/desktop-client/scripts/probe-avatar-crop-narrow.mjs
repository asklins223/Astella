/**
 * 头像取景框的窄窗检查（2026-10-06）。
 *
 * Electron 不支持 CDP 的 Browser.setWindowBounds（真窗口尺寸是用户的东西），
 * 所以这里用 `Emulation.setDeviceMetricsOverride` 把布局视口压到 900×700：
 * 要验的本来就是 CSS——取景框（正方形，宽度三重夹逼）与整卡必须仍在视口内、
 * 没有溢出；量的是盒子，不是印象。看完清除仿真、恢复原始页面位置。
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

const session = await context.newCDPSession(page)
await session.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false })
await page.waitForTimeout(700)
console.log('VIEWPORT', JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))))

// 已在设置页的前提下喂一张宽图，打开取景框。
await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1200
  canvas.height = 500
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 1200, 500)
  gradient.addColorStop(0, '#e2b13c')
  gradient.addColorStop(1, '#4d7f5c')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 1200, 500)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const input = document.querySelector('.settings-file-input')
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], 'wide.png', { type: 'image/png' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForSelector('.avatar-crop', { timeout: 15_000 })
await page.waitForSelector('.avatar-crop__preparing', { state: 'detached', timeout: 15_000 })
await page.waitForTimeout(350) // 让入场动画走完，量的是落定后的盒子

const boxes = await page.evaluate(() => {
  const rect = (selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect()
    return box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null
  }
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    card: rect('.avatar-crop'),
    stage: rect('.avatar-crop__stage'),
    canvas: rect('.avatar-crop__canvas'),
  }
})
console.log('BOXES', JSON.stringify(boxes, null, 2))
await page.screenshot({ path: join(outDir, '09-narrow-dialog.png') })

if (boxes.card && boxes.viewport) {
  const inside = boxes.card.x >= 0 && boxes.card.y >= 0
    && boxes.card.x + boxes.card.w <= boxes.viewport.w + 1 && boxes.card.y + boxes.card.h <= boxes.viewport.h + 1
  console.log('CARD_INSIDE_VIEWPORT', inside)
}
if (boxes.stage) console.log('STAGE_SQUARE', Math.abs(boxes.stage.w - boxes.stage.h) <= 1)

// 关掉取景框（Escape 就是取消），清掉仿真、让这一页回到真窗口。
await page.keyboard.press('Escape')
await page.waitForSelector('.avatar-crop', { state: 'detached', timeout: 10_000 })
await session.send('Emulation.clearDeviceMetricsOverride')
await page.waitForTimeout(600)
console.log('VIEWPORT_RESTORED', JSON.stringify(await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))))
await page.screenshot({ path: join(outDir, '10-window-restored.png') })
await browser.close()
