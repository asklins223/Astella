/**
 * 真窗口走查：流式朗读到底连不连续（2026-10-18）。
 *
 * 用户口径是"改用流式音频后一卡一卡的"。物理上只有一种听感会成为"卡"：
 * 音频单元之间出现空隙。这里不靠耳朵、也不靠播放器自报，而是在真窗口里
 * 给 `AudioBufferSourceNode.prototype.start` 打桩，记下每一次起播的
 * *计划时刻*与*实际时长*，然后算出相邻单元之间有没有空档。
 *
 * 判据：
 *   1. 流式通道真的被用了（每个单元的 buffer 不该是整段，而是 ~0.2s）；
 *   2. 相邻单元的计划开始时刻 = 上一个的开始 + 上一个的时长（自排播的缝隙）；
 *   3. 起播参数带 offset（前文裁切），且第一段 offset 为 0。
 *
 * 跑法（dev 栈在起）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-voice-stream-continuity.mjs
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const api = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000'
const email = process.env.ASTELLA_PROBE_EMAIL ?? process.env.OWNER_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD ?? process.env.OWNER_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')

const output = resolve(appRoot, 'outputs/companion-voice-stream-continuity-20261018')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-stream-'))

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5221, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9245'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5221' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const page = await app.firstWindow()

try {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setContentSize(1440, 810); w.show(); w.focus()
  })
  await page.waitForFunction(() => document.querySelector('.companion-presence, .desktop-access-gate input[type="email"]'), { timeout: 45_000 })
  if (!await page.locator('.companion-presence').count()) {
    await page.locator('.desktop-access-gate input[type="email"]').fill(email)
    await page.locator('.desktop-access-gate input[type="password"]').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  for (let i = 0; i < 120; i++) {
    if (await page.locator('.companion-presence').count()) break
    const workspaces = page.locator('.desktop-access-gate__workspace-list button')
    if (await workspaces.count()) await workspaces.first().click()
    await page.waitForTimeout(250)
  }
  check(await page.locator('.companion-presence').count() > 0, '登录进了真窗口')

  // 新 profile 默认可能静音：那样测出来的是"没开声音"，不是"声音卡"。
  // 走界面自己的开关（`HudRoomControl` 的总静音按钮），不绕过应用状态层。
  const unmute = page.getByRole('button', { name: '取消总静音', exact: true })
  if (await unmute.count()) await unmute.first().click()
  check(!await page.getByRole('button', { name: '取消总静音', exact: true }).count(), '总静音是放开的')

  // 起播桩：记下每次 start() 的 (计划时刻, offset, 时长) 与 AudioContext 当前时间。
  //
  // 「流式接管后不再重复整段合成」这条**不在页面里判**：合成请求由主进程发出，
  // 页面里的 fetch 桩看不到。判据在服务端日志与 `companion_tts_outcomes`
  // （`/voice/tts` 的行数是 0），跑完用 docker logs 核对。
  await page.evaluate(() => {
    window.__plays = []
    const proto = window.AudioBufferSourceNode?.prototype
    if (!proto) return
    const original = proto.start
    proto.start = function (...args) {
      const context = this.context
      window.__plays.push({
        at: Date.now(),
        contextTime: context && Number.isFinite(context.currentTime) ? Number(context.currentTime.toFixed(4)) : null,
        when: typeof args[0] === 'number' ? Number(args[0].toFixed(4)) : null,
        offset: typeof args[1] === 'number' ? Number(args[1].toFixed(4)) : 0,
        duration: this.buffer ? Number(this.buffer.duration.toFixed(4)) : null,
        argDuration: typeof args[2] === 'number' ? Number(args[2].toFixed(4)) : null,
      })
      return original.apply(this, args)
    }
  })
  check(await page.evaluate(() => Array.isArray(window.__plays)), '起播桩挂上了')

  // 让伴星真的念一段：走现役会话接口提一个问题，然后等语音通道起播。
  const login = await (await fetch(`${api}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })).json()
  if (!login.token) throw new Error(`登录失败：${JSON.stringify(login).slice(0, 160)}`)

  await page.evaluate(() => { window.__plays = [] })
  // 输入区只在伴星对话台展开时存在：先点开她（界面自己的入口）。
  await page.getByRole('button', { name: '书桌上的 AI 伴星' }).first().click()
  const composer = page.locator('.companion-hud__composer textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill('分三点详细讲讲机会成本，每点两三句话，慢慢说。')
  await composer.press('Enter')

  let plays = []
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2_000)
    plays = await page.evaluate(() => window.__plays || [])
    if (plays.length >= 3) break
  }
  check(plays.length >= 3, '念出了多个音频单元', { count: plays.length })

  const durs = plays.map(p => p.duration).filter(d => typeof d === 'number')
  const short = durs.filter(d => d > 0 && d < 0.6).length
  check(short >= Math.max(1, Math.floor(durs.length * 0.5)), '单元是流式的小块（不是整段一次播）',
    { durations: durs.slice(0, 12), short, total: durs.length })

  const gaps = []
  for (let i = 1; i < plays.length; i++) {
    const prev = plays[i - 1]
    const cur = plays[i]
    if (prev.when === null || cur.when === null) continue
    const prevEnd = prev.when + (prev.argDuration ?? prev.duration ?? 0)
    gaps.push(Number((cur.when - prevEnd).toFixed(4)))
  }
  const audibleGaps = gaps.filter(g => g > 0.02)
  check(audibleGaps.length === 0, '相邻单元首尾相接，没有排播空隙', { gaps: gaps.slice(0, 12), audibleGaps })

  /**
   * 前文裁切：**段内**后续单元 offset>0（跳过前文），**每段第一个单元** offset=0
   * （它没有前文可跳）。不能要求"只有第一个为 0"——一段话会被切成多段，
   * 每段都重新从 0 开始。
   */
  const offsets = plays.map(p => p.offset)
  const segmentStarts = offsets.filter(o => o === 0).length
  const continued = offsets.filter(o => o > 0).length
  const badContinuation = plays
    .map((p, index) => ({ p, index }))
    .filter(({ p, index }) => p.offset > 0 && index > 0 && Math.abs(plays[index].when - (plays[index - 1].when + (plays[index - 1].argDuration ?? plays[index - 1].duration ?? 0))) > 0.02)
  check(segmentStarts >= 1 && continued >= 1 && badContinuation.length === 0,
    '段内后续单元跳过前文，每段起首不跳',
    { offsets: offsets.slice(0, 8), segmentStarts, continued, badContinuation: badContinuation.length })

  /**
   * 句子之间：流式只负责**一段之内**，段与段之间仍是"上一段播完 → 下一段才开始要字节"。
   * 段与段之间若有空隙，听感同样是"一卡一卡"，而单元内再怎么无缝也盖不住它。
   * 这里按"计划起播时刻与上一段结束的差"算，>150ms 记为一处可听空档。
   */
  const segmentGaps = []
  for (let i = 1; i < plays.length; i += 1) {
    const prev = plays[i - 1]
    const cur = plays[i]
    if (prev.when === null || cur.when === null) continue
    const prevEnd = prev.when + (prev.argDuration ?? prev.duration ?? 0)
    const gap = Number((cur.when - prevEnd).toFixed(4))
    // 段落交界：下一个单元不带前文衔接（它自己的 offset 小于前文或等于 0）
    if (cur.offset === 0) segmentGaps.push(gap)
  }
  const audibleSegmentGaps = segmentGaps.filter(g => g > 0.15)
  check(audibleSegmentGaps.length === 0, '句子之间没有可听空档（>150ms）',
    { segmentGaps, audibleSegmentGaps })

  await writeFile(resolve(output, 'plays.json'), JSON.stringify({ plays, gaps, segmentGaps }, null, 1))
} finally {
  await writeFile(resolve(output, 'checks.json'), JSON.stringify(checks, null, 1))
  await app.close().catch(() => undefined)
  await server.close().catch(() => undefined)
}
