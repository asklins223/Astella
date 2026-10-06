/**
 * 真窗口核验：点击「使用这张」之后的「正在上传…」必须真的出现过（2026-10-06）。
 *
 * 用户反馈「中间 loading 态没有展示，网慢时会以为没传上去」。本地上传很快，肉眼
 * 抓不稳，所以这里在页面里挂 8ms 轮询记录 `.avatar-crop__busy` 的出现与消失——
 * 能不能看见这件事，用时间线说话；截图是尽量抓，抓不到不算失败。
 *
 * 走查会把账号头像换成测试图，结束时按原字节恢复（与 probe-avatar-crop-live.mjs 同法）。
 * 结果落在 outputs/avatar-crop-20261006/。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/avatar-crop-20261006')
await mkdir(outDir, { recursive: true })
const notes = []

const browser = await chromium.connectOverCDP(process.env.AILEARN_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0]

// 整页重载：保证跑的是刚改过的模块，而不是 HMR 留下的旧实例。
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate')),
  undefined,
  { timeout: 60_000 },
)
if (await page.locator('.desktop-access-gate').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 60_000 })
}
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
await page.locator('.hud-rail button[data-label="设置"]').first().click({ force: true })
await page.waitForSelector('.settings-hud', { timeout: 20_000 })
if (!(await page.locator('.settings-identity').count())) {
  await page.locator('.settings-menu button', { hasText: '账户与空间' }).first().click()
}
await page.waitForSelector('.settings-identity__avatar, .settings-identity__seal', { timeout: 20_000 })
const backupSrc = await page.evaluate(() => document.querySelector('.settings-identity__avatar')?.getAttribute('src') ?? null)
notes.push(`原头像：${backupSrc ? '已备份' : '无'}`)

await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 400
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#d9822b'; ctx.fillRect(0, 0, 400, 200)
  ctx.fillStyle = '#3f7f5c'; ctx.fillRect(400, 0, 400, 200)
  ctx.fillStyle = '#2b5d9e'; ctx.fillRect(0, 200, 400, 200)
  ctx.fillStyle = '#b8a13a'; ctx.fillRect(400, 200, 400, 200)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const input = document.querySelector('.settings-file-input')
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], 'progress.png', { type: 'image/png' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForSelector('.avatar-crop', { timeout: 15_000 })
await page.waitForSelector('.avatar-crop__preparing', { state: 'detached', timeout: 15_000 })
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll('.avatar-crop button')].find((b) => b.textContent?.includes('使用这张'))
  return Boolean(button && !button.disabled)
}, undefined, { timeout: 15_000 })

// 8ms 轮询：busy 出现过没有、持续了多久，都会被记下来。
await page.evaluate(() => {
  window.__busySamples = [];
  window.__busyStarted = performance.now();
  window.__busyTimer = setInterval(() => {
    window.__busySamples.push(Boolean(document.querySelector('.avatar-crop__busy')));
  }, 8);
})

const srcBefore = await page.evaluate(() => document.querySelector('.settings-identity__avatar')?.src ?? null)
/**
 * 本地上传约 40ms 就结束，截图（一次 CDP 往返）追不上。`AILEARN_CPU_THROTTLE=20`
 * 让渲染进程像台慢机器，把这段窗口拉宽到看得见——验的是同一段状态，只是显影更慢。
 */
const cpuThrottle = Number(process.env.AILEARN_CPU_THROTTLE ?? 0)
const session = await context.newCDPSession(page)
if (cpuThrottle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })

await page.getByRole('button', { name: '使用这张' }).click()
// 尽量抓一帧「正在上传…」；抓不到也不算失败，时间线才是结论。
for (let attempt = 0; attempt < 6; attempt += 1) {
  const busy = await page.evaluate(() => Boolean(document.querySelector('.avatar-crop__busy')))
  if (!busy) break
  const box = await page.evaluate(() => {
    const rect = document.querySelector('.avatar-crop')?.getBoundingClientRect()
    return rect ? { x: Math.max(0, rect.x - 14), y: Math.max(0, rect.y - 14), width: rect.width + 28, height: rect.height + 28 } : null
  })
  await page.screenshot(box ? { path: join(outDir, '11-uploading.png'), clip: box } : { path: join(outDir, '11-uploading.png') })
  const stillBusy = await page.evaluate(() => Boolean(document.querySelector('.avatar-crop__busy')))
  if (stillBusy) break
}
if (cpuThrottle > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
await page.waitForSelector('.avatar-crop', { state: 'detached', timeout: 60_000 })
const timeline = await page.evaluate(() => {
  clearInterval(window.__busyTimer)
  const samples = window.__busySamples
  const first = samples.indexOf(true)
  const last = samples.lastIndexOf(true)
  return { count: samples.length, busyFrames: samples.filter(Boolean).length, firstBusyAtMs: first < 0 ? null : first * 8, busyWindowMs: first < 0 ? 0 : (last - first + 1) * 8 }
})
notes.push(`「正在上传…」时间线：出现于点击后 ~${timeline.firstBusyAtMs}ms，持续 ~${timeline.busyWindowMs}ms（8ms 采样里 ${timeline.busyFrames}/${timeline.count} 帧）`)

await page.waitForFunction((previous) => {
  const img = document.querySelector('.settings-identity__avatar')
  return Boolean(img && img.complete && img.naturalWidth > 0 && (img.currentSrc || img.src) !== previous)
}, srcBefore, { timeout: 30_000 })
await page.screenshot({ path: join(outDir, '12-after-upload.png') })

if (backupSrc) {
  const restored = await page.evaluate(async (src) => {
    const mime = /^data:(.*?);/.exec(src)?.[1] ?? 'image/png'
    const base64 = src.slice(src.indexOf(',') + 1)
    return window.ailearn.auth.uploadAvatar({
      meta: {
        version: 1,
        contractVersion: 'desktop-ipc-v1',
        requestId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        clientStartedAt: new Date().toISOString(),
      },
      request: { version: 1, fileName: 'restore', mimeType: mime, bytesBase64: base64 },
    })
  }, backupSrc)
  notes.push(`恢复原头像：${restored?.ok ? '成功' : JSON.stringify(restored).slice(0, 120)}`)
}
// 页面 state 还停在新地址上；离开再回来让它重读档案。
await page.locator('.hud-rail button[data-label="首页"]').first().click({ force: true })
await page.waitForSelector('.settings-hud', { state: 'detached', timeout: 20_000 })
await page.locator('.hud-rail button[data-label="设置"]').first().click({ force: true })
await page.waitForFunction((expectedPrefix) => {
  const img = document.querySelector('.settings-identity__avatar')
  return Boolean(img && img.complete && img.naturalWidth > 0 && img.src.startsWith(expectedPrefix))
}, backupSrc ? backupSrc.slice(0, 30) : 'data:image/', { timeout: 30_000 })
await page.waitForTimeout(600)
await page.screenshot({ path: join(outDir, '13-restored.png') })

await writeFile(join(outDir, 'progress-notes.md'), notes.join('\n') + '\n', 'utf8')
console.log(notes.join('\n'))
await browser.close()
