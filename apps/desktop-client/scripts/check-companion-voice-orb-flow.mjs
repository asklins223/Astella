/**
 * 真窗口走查：语音球两路信号的云动效（2026-11-08）。
 *
 * 用户症状：人说话时云流动幅度小；伴星说话时球里高频颤动、不是流动。
 * 根因曾是着色器拿累积时间乘实时音量（音量每跳一次噪声场瞬移一次）。
 * 现在相位在 CPU 积分，音量只改流速；这个脚本在**正在运行的 dev 实例**上
 * 连拍三态帧 burst，用像素判据区分"流动"与"颤动/不动"：
 *   连续 = 相邻帧残差小（颤动是原地重排，残差≈1）；
 *   看得见 = 帧间变化能量过可见线（云是变形流体，刚体平移是错的代理）。
 *
 * 人说话态靠外放一句话被麦克风拾到（系统输出静音时跳过，如实记 SKIP）；
 * 伴星说话态用"文字发一句→开球接回复播放"触发——振幅通道在 AudioContext
 * 输出端之前采样，系统静音也活着，且不依赖 ASR 对扬声器录音的识别质量。
 * 所有开关用 playwright 可信点击：音频解锁只认真实 pointerdown/keydown。
 *
 * 跑法（dev 栈在起，默认 CDP 9222；macOS）：
 *   cd apps/desktop-client && node scripts/check-companion-voice-orb-flow.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from '@playwright/test'

const execFileAsync = promisify(execFile)
const appRoot = resolve(import.meta.dirname, '..')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve(appRoot, `outputs/orb-flow-${stamp}`)
await mkdir(output, { recursive: true })

const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9222')
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('localhost:5173'))
if (!page) throw new Error('no renderer page on CDP')
await page.bringToFront()

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok, label, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}
const activity = () => page.evaluate(() => document.querySelector('.companion-voice')?.dataset.activity ?? null)
const orbRect = () => page.evaluate(() => {
  const r = document.querySelector('.companion-voice__ball')?.getBoundingClientRect()
  return r && r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
})

// ── PNG 解码（CDP 截图是 8bit 非交错 RGB/RGBA）→ 亮度矩阵 ────────────────
function decodeLuma(png) {
  let pos = 8, width = 0, height = 0, colorType = 6, idat = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString('ascii', pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG')
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error('unsupported color type')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  const paeth = (a, b, c) => {
    const p = a + b - c
    const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c)
    return da <= db && da <= dc ? a : db <= dc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0
      const up = y > 0 ? out[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0
      const v = raw[rp + x]
      out[y * stride + x] = (v + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, ul) : 0)) & 255
    }
    rp += stride
  }
  const luma = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = out[i * channels], g = out[i * channels + 1], b = out[i * channels + 2]
    luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return { width, height, luma }
}

// 球心圆形区域降采样到 48x48 亮度。
function orbLuma(png) {
  const { width, height, luma } = decodeLuma(png)
  const size = 48, grid = new Float64Array(size * size)
  const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * 0.42
  for (let gy = 0; gy < size; gy++) for (let gx = 0; gx < size; gx++) {
    const px = Math.round(cx + ((gx + 0.5) / size - 0.5) * 2 * radius)
    const py = Math.round(cy + ((gy + 0.5) / size - 0.5) * 2 * radius)
    grid[gy * size + gx] = luma[py * width + px]
  }
  return grid
}

// 相邻帧判据。残差/方差 小=连续（颤动是原地重排，任何翻译都对不齐，残差≈1）；
// energy=平均绝对亮度差/255，量"看不看得见动静"。云是变形流体，不是刚体，
// 最佳平移对它是错的代理（2026-11-08 实测：明显流动时平移也恒为 0）。
// 阈值用真窗口帧标定：旧弱调参 speaking≈0.011（用户判"看不到动静"），
// 新调参≈0.024；取 0.015 为可见线。
function flowMetric(a, b) {
  const size = 48
  const mean = b.reduce((s, v) => s + v, 0) / b.length
  const variance = b.reduce((s, v) => s + (v - mean) ** 2, 0) / b.length || 1
  let best = Infinity, diff = 0
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    let sum = 0, n = 0
    for (let y = 6; y < size - 6; y++) for (let x = 6; x < size - 6; x++) {
      const d = a[(y + dy) * size + x + dx] - b[y * size + x]
      sum += d * d; n++
    }
    const mse = sum / n
    if (mse < best) best = mse
  }
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return { residual: best / variance, energy: diff / a.length / 255 }
}

async function burst(name, frames, intervalMs) {
  const rect = await orbRect()
  if (!rect) throw new Error(`orb not visible for ${name}`)
  const grids = []
  for (let i = 0; i < frames; i++) {
    const png = await page.screenshot({ clip: rect })
    await writeFile(resolve(output, `${name}-${i}.png`), png)
    grids.push(orbLuma(png))
    if (i < frames - 1) await page.waitForTimeout(intervalMs)
  }
  const metrics = grids.slice(1).map((g, i) => flowMetric(grids[i], g))
  const residual = metrics.reduce((s, m) => s + m.residual, 0) / metrics.length
  const energy = metrics.reduce((s, m) => s + m.energy, 0) / metrics.length
  const result = { residual: Number(residual.toFixed(3)), energy: Number(energy.toFixed(4)), pairs: metrics.length }
  console.log(`${name}: ${JSON.stringify(result)}`)
  return result
}

const openVoice = async () => {
  if (await activity()) return
  await page.getByRole('button', { name: '开始语音对话', exact: true }).click()
  // 带着待回复开球会直接落在 waiting/speaking，不能死等 listening。
  await page.waitForFunction(() => ['listening', 'capturing', 'waiting', 'speaking'].includes(document.querySelector('.companion-voice')?.dataset.activity ?? ''), { timeout: 20_000 })
}
const closeVoice = async () => {
  if (await activity()) await page.locator('.companion-voice__close').click()
}

try {
  await closeVoice()
  await openVoice()
  check(true, '麦克风入口在且点得动（可信手势解锁音频）')
  // 撞上残留播放时等它落定，静音态必须真的安静。
  await page.waitForFunction(() => document.querySelector('.companion-voice')?.dataset.activity === 'listening', { timeout: 60_000 })
  await page.waitForTimeout(600)
  const idle = await burst('idle', 5, 200)

  // 人说话态：外放拾音。系统输出静音时这条路物理上走不通，如实跳过。
  const volume = await execFileAsync('osascript', ['-e', 'get volume settings']).then(r => r.stdout).catch(() => '')
  const muted = /output muted:true/.test(volume) || /output volume:0[,}\s]/.test(volume)
  if (muted) {
    console.log('SKIP input：系统输出静音，外放拾音不可用（不改动用户音量）')
  } else {
    const utterance = resolve(tmpdir(), 'astella-orb-utterance.aiff')
    const sentence = '伴星，给我讲讲你最近在想什么，多说几句，慢慢说。'
    try {
      await execFileAsync('say', ['-v', 'Tingting', '-o', utterance, sentence])
    } catch {
      await execFileAsync('say', ['-o', utterance, sentence])
    }
    const play = spawn('afplay', [utterance])
    await page.waitForFunction(() => ['capturing', 'transcribing', 'waiting'].includes(document.querySelector('.companion-voice')?.dataset.activity ?? ''), { timeout: 20_000 })
    await page.waitForTimeout(700)
    const input = await burst('input', 8, 150)
    await new Promise(res => play.on('exit', res))
    check(input.residual < 0.6 && input.energy >= 0.015, '人说话：云在流动且幅度可见', input)
  }

  // 伴星说话态：文字发一句再开球接播放。合成偶发失败时换一句再试一次。
  await page.waitForFunction(() => !['speaking', 'waiting', 'transcribing'].includes(document.querySelector('.companion-voice')?.dataset.activity ?? ''), { timeout: 60_000 }).catch(() => {})
  let speaking = null
  for (const question of ['给我讲讲辐射雾为什么常在清晨出现，多说几句。', '用三句话讲讲雾和霾的区别。']) {
    await closeVoice()
    const composer = page.getByRole('textbox', { name: /给 .* 的消息/ })
    if (!await composer.count()) await page.getByRole('button', { name: '气泡轻聊', exact: true }).click()
    await composer.fill(question)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await openVoice()
    try {
      await page.waitForFunction(() => document.querySelector('.companion-voice')?.dataset.activity === 'speaking', { timeout: 45_000 })
      await page.waitForTimeout(700)
      speaking = await burst('speaking', 10, 120)
      break
    } catch {
      console.log('这一轮没等到播放，换一句重试')
    }
  }
  if (!speaking) throw new Error('两轮文字都没等到伴星播放')

  // 流动判据：残差小=不颤；能量过可见线=看得见动静。两条都过才算流动。
  check(speaking.residual < 0.6 && speaking.energy >= 0.015, '伴星说话：看得见地流动且不颤动', speaking)
  check(idle.residual < 0.6, '安静：缓慢漂移不颤动', idle)
  const status = await page.evaluate(() => document.querySelector('.companion-voice__status')?.textContent)
  console.log(`status at capture: ${status}`)
} finally {
  // 走查完把麦关上，别把用户的窗口留在收音状态。
  await closeVoice().catch(() => {})
  await writeFile(resolve(output, 'checks.json'), JSON.stringify(checks, null, 2))
  await browser.close()
}
const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed; frames in ${output}`)
process.exit(failed.length ? 1 : 0)