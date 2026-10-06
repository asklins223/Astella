/**
 * 真窗口核验：头像取景框（2026-10-06）。
 *
 * 附着 `npm run dev` 起的客户端（CDP 9222）：登录 → 设置 → 头像取景框，用一张
 * 四象限测试图走「拖动 → 缩放 → 旋转 → 确认」。结论靠像素：取景框画布与上传后的
 * 头像在同样的取样点上必须同色——「预览即所得」只有这样才算数，截图只是过程记录。
 *
 * 宽图 1600×400 的默认取景是居中裁切：四象限取样应为 红 / 绿 / 蓝 / 黄；
 * 向左拖 150 屏幕 px 后应变成 绿 / 绿 / 黄 / 黄（源码集右移 200px）。
 *
 * 走查会把账号头像换成测试图，结束时恢复原样：有原头像就按原字节重传，没有就清掉。
 * 结论与截图落在 outputs/avatar-crop-20261006/。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/avatar-crop-20261006')
await mkdir(outDir, { recursive: true })
const notes = []

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages()[0] ?? (await context.newPage())

const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))

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

/** 截图编号按走查顺序排；文件名就是这段流程的记录。 */
const shot = async (name) => page.screenshot({ path: join(outDir, `${name}.png`) })

// ── 进设置：账户与空间是默认第一屏 ────────────────────────────────
await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
const settingsChip = page.locator('.hud-rail button[data-label="设置"]')
if (!(await settingsChip.count())) {
  // 折叠态的 rail 芯片带 aria-hidden，直接派发点击也够它导航。
  await page.evaluate(() => document.querySelector('.hud-rail button[data-label="设置"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
} else {
  await settingsChip.click({ force: true })
}
await page.waitForSelector('.settings-hud', { timeout: 20_000 })
// 页面可能停在上次看的那一屏：这一轮要的是「账户与空间」。
if (!(await page.locator('.settings-identity').count())) {
  await page.locator('.settings-menu button', { hasText: '账户与空间' }).first().click()
}
await page.waitForSelector('.settings-identity__avatar, .settings-identity__seal', { timeout: 20_000 })
await shot('01-settings-account')

// ── 备份现在的头像（没有就记 null，收尾时清掉测试图）──────────────
const backupSrc = await page.evaluate(() => document.querySelector('.settings-identity__avatar')?.getAttribute('src') ?? null)
notes.push(`原头像：${backupSrc ? `${backupSrc.slice(0, 30)}…（${Math.round(backupSrc.length / 1024)}KB base64）` : "无"}`)

// ── 造一张四象限测试图，直接从页面喂给文件输入（不落地文件）────────
await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1600
  canvas.height = 400
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#e02020'; ctx.fillRect(0, 0, 800, 200)
  ctx.fillStyle = '#20a020'; ctx.fillRect(800, 0, 800, 200)
  ctx.fillStyle = '#2040e0'; ctx.fillRect(0, 200, 800, 200)
  ctx.fillStyle = '#e0c020'; ctx.fillRect(800, 200, 800, 200)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const input = document.querySelector('.settings-file-input')
  const transfer = new DataTransfer()
  transfer.items.add(new File([blob], 'quadrants.png', { type: 'image/png' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForSelector('.avatar-crop', { timeout: 15_000 })
await page.waitForSelector('.avatar-crop__preparing', { state: 'detached', timeout: 15_000 }) // 「正在准备照片…」散了才是 ready
await shot('02-cropper-open')

/** 取景框画布与头像 img 都按"画布设备像素的比例"取样，两边同一套坐标。 */
const sampleRgba = async (selector) => page.evaluate((sel) => {
  const image = sel === '.avatar-crop__canvas'
    ? document.querySelector(sel)
    : document.querySelector(sel)
  const canvas = document.createElement('canvas')
  const w = image instanceof HTMLCanvasElement ? image.width : image.naturalWidth
  const h = image instanceof HTMLCanvasElement ? image.height : image.naturalHeight
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, w, h)
  const at = (fx, fy) => {
    const d = ctx.getImageData(Math.round(fx * (w - 1)), Math.round(fy * (h - 1)), 1, 1).data
    return [d[0], d[1], d[2]]
  }
  return { q1: at(.25, .25), q2: at(.75, .25), q3: at(.25, .75), q4: at(.75, .75) }
}, selector)

const quadClass = ([r, g, b]) => {
  if (r > 150 && g < 130 && b < 130) return 'red'
  if (g > 130 && r < 130 && b < 130) return 'green'
  if (b > 150 && r < 130 && g < 150) return 'blue'
  if (r > 150 && g > 130 && b < 130) return 'yellow'
  return `other(${r},${g},${b})`
}

const center = await page.evaluate(() => {
  const rect = document.querySelector('.avatar-crop__canvas').getBoundingClientRect()
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width }
})

const before = await sampleRgba('.avatar-crop__canvas')
notes.push(`默认取景取样：${[before.q1, before.q2, before.q3, before.q4].map(quadClass).join(' / ')}（期望 red / green / blue / yellow）`)

// ── 向左拖 150px：源码集右移 200px → 右半张图 ─────────────────────
await page.mouse.move(center.x, center.y)
await page.mouse.down()
await page.mouse.move(center.x - 150, center.y, { steps: 12 })
await page.mouse.up()
const afterPan = await sampleRgba('.avatar-crop__canvas')
notes.push(`拖动后取样：${[afterPan.q1, afterPan.q2, afterPan.q3, afterPan.q4].map(quadClass).join(' / ')}（期望 green / green / yellow / yellow）`)
await shot('03-cropper-panned')

// ── 滚轮放大：25% 与 75% 处仍应落在同一象限 ───────────────────────
await page.mouse.move(center.x, center.y)
await page.mouse.wheel(0, -240)
await page.waitForTimeout(120)
const afterZoom = await sampleRgba('.avatar-crop__canvas')
notes.push(`滚轮放大后取样：${[afterZoom.q1, afterZoom.q2, afterZoom.q3, afterZoom.q4].map(quadClass).join(' / ')}`)
const slider = await page.evaluate(() => Number(document.querySelector('.avatar-crop__zoom input')?.value ?? 1))
notes.push(`缩放滑块读数：${slider}（应 > 1）`)
await shot('04-cropper-zoomed')

// ── 旋转：右转 90° 象限应当搬家，左转回来角度归零 ─────────────────
await page.getByRole('button', { name: '右转' }).click()
await page.waitForTimeout(400)
const afterTurn = await sampleRgba('.avatar-crop__canvas')
notes.push(`右转 90° 后取样：${[afterTurn.q1, afterTurn.q2, afterTurn.q3, afterTurn.q4].map(quadClass).join(' / ')}`)
await shot('05-cropper-rotated')
await page.getByRole('button', { name: '左转' }).click()
await page.waitForTimeout(400)

// ── 确认：上传前先记下取景框此刻的颜色，作为"所见即所得"的基准 ────
const previewBeforeUpload = await sampleRgba('.avatar-crop__canvas')
const srcBefore = await page.evaluate(() => document.querySelector('.settings-identity__avatar')?.src ?? null)
await page.getByRole('button', { name: '使用这张' }).click()
await page.waitForSelector('.avatar-crop', { state: 'detached', timeout: 20_000 })

// 等的是「头像地址真的换了」：页面上的旧图在回执回来前一直可读，只等 naturalWidth 会读到旧脸。
await page.waitForFunction((previous) => {
  const img = document.querySelector('.settings-identity__avatar')
  if (!img || !img.complete || !img.naturalWidth) return false
  const failure = document.querySelector('.settings-notice--error')?.textContent ?? ''
  if (failure) throw new Error(`上传失败：${failure}`)
  return (img.currentSrc || img.src) !== previous
}, srcBefore, { timeout: 30_000 })
const uploaded = await sampleRgba('.settings-identity__avatar')
await shot('06-after-upload')

const delta = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
const worst = Math.max(
  delta(previewBeforeUpload.q1, uploaded.q1), delta(previewBeforeUpload.q2, uploaded.q2),
  delta(previewBeforeUpload.q3, uploaded.q3), delta(previewBeforeUpload.q4, uploaded.q4),
)
notes.push(`上传后头像取样：${[uploaded.q1, uploaded.q2, uploaded.q3, uploaded.q4].map(quadClass).join(' / ')}`)
notes.push(`预览与成品的最大通道差：${worst}（webp 编码允许小偏差）`)
notes.push(`hud 药丸上的头像：${await page.locator('.room-control-account__photo').count() ? '已换成照片' : '仍是首字母印章'}`)

// ── 收尾：恢复原头像（有则按原字节重传，无则清除测试图）───────────
if (backupSrc) {
  const restored = await page.evaluate(async (src) => {
    const mime = /^data:(.*?);/.exec(src)?.[1] ?? 'image/png'
    const base64 = src.slice(src.indexOf(',') + 1)
    const response = await window.astella.auth.uploadAvatar({
      meta: {
        version: 1,
        contractVersion: 'desktop-ipc-v1',
        requestId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        clientStartedAt: new Date().toISOString(),
      },
      request: { version: 1, fileName: 'restore', mimeType: mime, bytesBase64: base64 },
    })
    return response
  }, backupSrc)
  notes.push(`恢复原头像：${JSON.stringify(restored).slice(0, 160)}`)
} else {
  await page.getByRole('button', { name: '清除' }).first().click()
  await page.waitForTimeout(1200)
  notes.push('原本没有头像：已把测试图清掉')
}
/**
 * 恢复是直接走 IPC 的：页面 state 还停在上一次上传的地址上，「换回来」要等它
 * 重新读档案。离开设置再回来（设置面重新挂载）才会看到恢复后的那张脸。
 */
await page.locator('.hud-rail button[data-label="首页"]').first().click({ force: true })
await page.waitForSelector('.settings-hud', { state: 'detached', timeout: 20_000 })
await page.locator('.hud-rail button[data-label="设置"]').first().click({ force: true })
await page.waitForFunction((expectedPrefix) => {
  const img = document.querySelector('.settings-identity__avatar')
  return Boolean(img && img.complete && img.naturalWidth > 0 && img.src.startsWith(expectedPrefix))
}, backupSrc ? backupSrc.slice(0, 30) : 'data:image/', { timeout: 30_000 })
await page.waitForTimeout(800)
notes.push('离开设置再回来：界面与顶栏都显示出恢复后的头像')
await shot('07-restored')

await writeFile(join(outDir, 'notes.md'), notes.join('\n') + `\n\nconsole errors: ${consoleErrors.length ? consoleErrors.join(' | ') : '无'}\n`, 'utf8')
console.log(notes.join('\n'))
console.log('CONSOLE_ERRORS', consoleErrors.length)
await browser.close()
