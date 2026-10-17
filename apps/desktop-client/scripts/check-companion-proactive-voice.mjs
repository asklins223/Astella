/**
 * 真窗口走查：她主动开口那一条，声音到底出不出（2026-10-16，⑤最后一条）。
 *
 * 为什么要在窗口里跑：服务端签了段（`voice.segment.ready`）不等于用户听见了。
 * 这一条的链路是「主动轮 → 气泡 → 段进常驻队列 → 取字节 → AudioBufferSourceNode 起播 → 落本机缓存」，
 * 中间每一环都可能把声音丢在窗口外（v1.8.4 之前就是这么坏的）。
 * jsdom 与生产读数都证明不了"这一趟真响了"，所以按用户口径改在**本地 dev 栈**验：
 *   ① 起一个隔离 profile 的实例（本机从没存过任何音频），登录 dev 探测账号、放开总静音；
 *   ② 打 `AudioBufferSourceNode.prototype.start` 的桩，记下每一次起播的 buffer 时长；
 *   ③ 用她自己的接口造一次主动开口（`POST /me/companion/awareness`，`topic=app.started`，
 *      foreground+unlocked、不打字），走的是现役那条主动参与判定，不是手插库；
 *   ④ 断言：气泡上出现她的话、起播计数 > 0、本机音频缓存里真长出文件。
 *
 * 跑法（dev 栈在起：api :4000、worker、postgres、edge-tts）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-proactive-voice.mjs
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const api = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000'
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')
const output = resolve(appRoot, 'outputs/companion-proactive-voice-20261016')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-proactive-'))

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5219, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9243'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5219' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const page = await app.firstWindow()

// 造一次主动开口的观测：走的是应用自己在用的那个接口，判定与真人无异。
async function triggerObservation() {
  const login = await (await fetch(`${api}/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()
  if (!login.token) throw new Error(`登录失败：${JSON.stringify(login).slice(0, 120)}`)
  const cid = execFileSync('docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-Atc',
    `select id from companion_conversations where user_id='${login.ctx.userId}' and status='active' order by last_message_at desc nulls last limit 1`]).toString().trim()
  const launch = randomUUID()
  const body = { version: 1, id: randomUUID(), appLaunchId: launch, deviceSessionId: `device:${launch}`, host: 'desktop',
    topic: 'app.started', occurredAt: new Date().toISOString(), elapsedMs: 0,
    context: { foreground: true, unlocked: true, typing: false, learning: false, conversationId: cid,
      page: { key: 'home', label: '书房', revision: null, context: null } } }
  const res = await fetch(`${api}/me/companion/awareness`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-csrf-token': login.csrfToken },
    body: JSON.stringify(body) })
  return { status: res.status, body: await res.json(), userId: login.ctx.userId }
}

try {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 810); w.show(); w.focus() })
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

  // 声音放开：新 profile 默认可能静音，那样"没声"就测不出是链路的锅还是开关的锅。
  const audio = await page.evaluate(async () => {
    const { useRoomStore } = await import('/app/home/room-store.ts')
    useRoomStore.getState().finishOnboarding?.()
    useRoomStore.setState({ masterMuted: false })
    return { masterMuted: useRoomStore.getState().masterMuted }
  })
  check(audio.masterMuted === false, '总静音是放开的', audio)

  // 起播桩：`AudioBufferSourceNode.prototype.start` 是最后一段真实声音的唯一出口。
  await page.evaluate(() => {
    window.__plays = []
    const proto = window.AudioBufferSourceNode?.prototype
    if (!proto) return
    const original = proto.start
    proto.start = function (...args) {
      window.__plays.push({ duration: this.buffer ? Number(this.buffer.duration.toFixed(2)) : null, at: Date.now() })
      return original.apply(this, args)
    }
  })
  check(await page.evaluate(() => Array.isArray(window.__plays)), '起播桩挂上了（有 AudioBufferSourceNode）')

  const before = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  const trig = await triggerObservation()
  check(trig.status === 200 && trig.body?.accepted === true, '主动开口的观测被服务端接了', { status: trig.status, observationId: trig.body?.observationId })

  let bubbleText = ''
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2_000)
    const seen = await page.evaluate((prev) => {
      const bubbles = [...document.querySelectorAll('.companion-message, [class*="proactive"], .companion-bubble')]
        .filter(el => el.getBoundingClientRect().width > 0)
      const sr = document.querySelector('.companion-hud__sr-status')
      return { bubble: (bubbles.at(-1)?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
        sr: (sr?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140),
        plays: (window.__plays || []).length }
    }, before)
    const text = seen.bubble && seen.bubble !== before.slice(-140) ? seen.bubble : (seen.sr || seen.bubble)
    if (text && text.length > 4 && !/正在想|正在看/.test(text)) { bubbleText = text; break }
    if (i % 10 === 9) console.log(`note: 第 ${i * 2}s 还没等到主动气泡，plays=${seen.plays}`)
  }

  check(Boolean(bubbleText), '窗口里等到了她主动说的那句', { bubbleText })

  // 气泡先到、声音后到是正常顺序：主动轮的语音段要在正文说完之后才签出来，
  // 所以这里必须继续等，不能在看见字的那一刻就判"没声"（第一版就是这么误判的）。
  const counted = async () => {
    const plays = await page.evaluate(() => (window.__plays || []).map(p => p.duration))
    const files = await readdir(resolve(profile, 'companion-message-audio'), { recursive: true, withFileTypes: false })
      .then(entries => entries.filter(name => String(name).endsWith('.mp3') || String(name).endsWith('record.json')).length)
      .catch(() => 0)
    return { plays, files }
  }
  let plays = [], files = 0
  for (let i = 0; i < 45; i++) {
    const seen = await counted()
    plays = seen.plays; files = seen.files
    if (plays.length > 0 && files > 0) break
    await page.waitForTimeout(2_000)
  }
  const dbRow = execFileSync('docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-Atc',
    `select r.status, (select count(*) from companion_stream_events e where e.run_id=r.id and e.type='voice.segment.ready')
     from companion_turn_runs r where r.input_source->>'kind'='initiative' order by r.created_at desc limit 1`]).toString().trim()
  check(Boolean(dbRow), 'dev 库里这条主动轮的结局与服务端签段数', { dbRow })
  check(plays.length > 0, '真的起播了（AudioBufferSourceNode.start 有计数）', { plays })
  check(files > 0, '本机音频缓存里落进了字节', { files })

  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, 'proactive-window.png'), Buffer.from(png, 'base64'))
  await writeFile(resolve(output, 'notes.md'), `# 主动消息出声走查 2026-10-16\n\nprofile: ${profile}\n\n气泡：${bubbleText}\n\n`
    + checks.map(c => `- ${c.ok ? 'x' : ' '} ${c.label} ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`).join('\n') + '\n')
} finally {
  await app.close().catch(() => {})
  await server.close().catch(() => {})
}
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
