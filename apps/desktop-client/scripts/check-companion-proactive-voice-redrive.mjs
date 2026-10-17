/**
 * 真窗口走查：一条**在窗口之外产生**的主动开口，气泡上到底有没有声音（2026-10-16）。
 *
 * 为什么不能只用实时流那条探针（`check-companion-proactive-voice.mjs`）：
 * 主动正文还有两条兜底把字显示出来（快照轮询、跨会话连续历史），而语音段只有实时流
 * 一条路。投递落地时那一轮常常已经结束，客户端 `after=0` 的游标被判 `CURSOR_EXPIRED`，
 * 于是「有字没声」，客户端连一次合成请求都不发。这一条探针复现的就是那个形状：
 *
 *   ① 应用没开的时候先用她自己的接口造一次开口（`POST /me/companion/awareness`，
 *      `topic=result.available`），等投递停在 `queued` 且服务端已签发语音段；
 *   ② 再起窗口（发行渲染包 + 隔离 profile），全程不点不敲；
 *   ③ 断言：气泡出现她的那句话、`voice.segment.ready` 的段真的被合成（
 *      `companion_tts_outcomes.stage='synth'`）、真的起播（`AudioBufferSourceNode.start`
 *      桩）、本机音频缓存落进字节、并且服务端收到 `stage='playback'`/`outcome='ok'`。
 *
 * 跑法（dev 栈在起：api :4000、worker、postgres、edge-tts；先 `npm run build`）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-proactive-voice-redrive.mjs
 */
import { mkdir, readdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const api = process.env.ASTELLA_PROBE_API ?? 'http://127.0.0.1:4000'
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')
const output = resolve(appRoot, 'outputs/companion-proactive-voice-redrive-20261016')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-redrive-'))

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}
const psql = (sql) => execFileSync('docker', ['exec', 'astella-dev-postgres-1', 'psql', '-U', 'astella', '-d', 'astella', '-Atc', sql]).toString().trim()

/** ① 应用没开的时候先让她开口：投递停在 queued，等窗口起来认领。 */
async function stagePendingDelivery() {
  const login = await (await fetch(`${api}/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()
  if (!login.token) throw new Error(`登录失败：${JSON.stringify(login).slice(0, 120)}`)
  const launch = randomUUID()
  /**
   * 用 `result.available`（宿主报告刚产生了一个学习结果）而不是 `app.started`：
   * 启动问候现在会在下一次真实启动时被**作废**（见
   * docs/testing/companion-launch-greeting-supersede-2026-10-16.md），拿它当"上一次没被看见的
   * 主动消息"测不出这条补声链。`result.available` 是触发式话题（不受档位节奏闸门），
   * 不带页面身份要求以外的门槛，正好是"窗口之外产生的主动消息"。
   */
  const res = await fetch(`${api}/me/companion/awareness`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-csrf-token': login.csrfToken },
    body: JSON.stringify({ version: 1, id: randomUUID(), appLaunchId: launch, deviceSessionId: `device:${launch}`, host: 'desktop',
      topic: 'result.available', occurredAt: new Date().toISOString(), elapsedMs: 0,
      evidence: { domain: 'run', entityId: randomUUID(), revision: '1', description: '刚做完一组练习，结果已经出来了。' },
      context: { foreground: true, unlocked: true, typing: false, learning: true, conversationId: null,
        page: { key: 'home', label: '书房', revision: null, context: null } } }) })
  const body = await res.json()
  for (let i = 0; i < 90; i += 1) {
    const [state, runId] = psql(`select d.state, d.payload_ref->'initiative'->>'runId' from assistant_deliveries d
      where d.user_id='${login.ctx.userId}' order by d.created_at desc limit 1`).split('|')
    if (state === 'queued' && runId) {
      const segments = Number(psql(`select count(*) from companion_stream_events where run_id='${runId}' and type='voice.segment.ready'`))
      if (segments > 0) return { status: res.status, accepted: body.accepted, userId: login.ctx.userId, runId, segments }
    }
    await new Promise(r => setTimeout(r, 1_000))
  }
  throw new Error('等待待认领投递超时：她这一次没有产出可补的留档')
}

const staged = await stagePendingDelivery()
check(Number(staged.segments) > 0, '窗口之外那次开口已经签发语音段（留档可补）', { runId: staged.runId, segments: staged.segments })

// 宿主环境里可能带着 ELECTRON_RUN_AS_NODE=1（CI/agent 壳常见）。透传它会让
// Electron 以纯 Node 启动、根本不打印调试行，Playwright 只会报 "Process failed to launch!"。
const launchEnv = { ...process.env }
delete launchEnv.ELECTRON_RUN_AS_NODE
delete launchEnv.ELECTRON_RENDERER_URL

const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`], cwd: appRoot,
  env: launchEnv,
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 810); w.show(); w.focus() })
  await page.waitForFunction(() => document.querySelector('.companion-presence, .desktop-access-gate input[type="email"]'), undefined, { timeout: 45_000 })
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
  await page.evaluate(async () => {
    try { const { useRoomStore } = await import('/app/home/room-store.ts'); useRoomStore.getState().finishOnboarding?.(); useRoomStore.setState({ masterMuted: false }) } catch { /* 发行包没有 /src，默认即未静音 */ }
  })
  // 起播桩：`AudioBufferSourceNode.prototype.start` 是真实声音的唯一出口。
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

  let bubble = ''
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(2_000)
    bubble = await page.evaluate(() => (document.querySelector('.companion-hud')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 140))
    if (bubble.length > 4 && !/^交给我的事$/.test(bubble)) break
  }
  check(bubble.length > 4, '窗口里等到了她那一句', { bubble })

  // 气泡先到、声音后到：留档补声要一次合成往返，必须继续等。
  let plays = []
  for (let i = 0; i < 45; i += 1) {
    await page.waitForTimeout(2_000)
    plays = await page.evaluate(() => window.__plays || [])
    if (plays.length > 0) break
  }
  const files = await readdir(resolve(profile, 'companion-message-audio'), { recursive: true, withFileTypes: false })
    .then(entries => entries.filter(name => String(name).endsWith('.mp3')).length).catch(() => 0)
  const outcomes = psql(`select stage || '|' || outcome || '|' || coalesce(error_code,'') from companion_tts_outcomes
    where run_id='${staged.runId}' order by created_at`)
  const rows = outcomes.split('\n').filter(Boolean)
  check(rows.some(r => r.startsWith('synth|ok')), '服务端留档的段真的被合成', { rows })
  check(plays.length > 0, '真的起播了（AudioBufferSourceNode.start 有计数）', { plays })
  check(files > 0, '本机音频缓存里落进了字节', { files })
  check(rows.some(r => r === 'playback|ok|played'), '客户端把「这一句播成了」报回了服务端', { rows: rows.filter(r => r.startsWith('playback')) })

  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, 'redrive-window.png'), Buffer.from(png, 'base64'))
  await writeFile(resolve(output, 'notes.md'), `# 主动开口留档补声走查 2026-10-16\n\nprofile: ${profile}\n\nrun: ${staged.runId}\n\n气泡：${bubble}\n\n`
    + checks.map(c => `- ${c.ok ? 'x' : ' '} ${c.label} ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`).join('\n') + '\n')
} finally {
  await app.close().catch(() => {})
}
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
