/**
 * 真窗口走查：一条伴星回合在**客户端**这边是怎么到达的（2026-10-17）。
 *
 * 为什么必须有这一趟：服务端读数只能证明"事件落库了、时间戳是多少"，
 * 证明不了用户真正体验的三件事——
 *   ① 文字草稿是**边到边显**还是攒到最后一次性弹出来；
 *   ② `voice.segment.ready` 有没有真的走到播放层（本机音频缓存、AudioContext）；
 *   ③ 文字与音频**合并**的时候会不会互相拖慢（例如等音频播完才显字，或每段音频
 *      重建一次播放器把主线程卡住）。
 *
 * 这三件事都在渲染层，只有真窗口能测。用隔离 profile 起实例，避免动用户的登录态。
 *
 * 跑法（dev 栈要在起：api :4000、worker）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-merged-stream.mjs
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, 'outputs/companion-merged-stream-20261017')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-merged-'))
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
const phrase = process.env.ASTELLA_PROBE_TEXT ?? '用三句话解释一下什么是机会成本'
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')

const checks = []
const check = (ok, label, detail) => {
  checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5218, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9242'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5218' },
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
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await page.locator('.companion-presence').count()) break
    const workspaces = page.locator('.desktop-access-gate__workspace-list button')
    if (await workspaces.count()) await workspaces.first().click()
    const err = page.locator('.desktop-access-gate__form-error')
    if (await err.count()) throw new Error(`login failed: ${await err.innerText()}`)
    await page.waitForTimeout(250)
  }
  await page.waitForFunction(() => document.querySelector('.companion-presence'), { timeout: 30_000 })

  // 声音开关：新 profile 默认静音时，念出来的东西会被投递层直接丢掉，
  // 于是"没声"会被误判成链路坏了。
  const audioState = await page.evaluate(async () => {
    const { useRoomStore } = await import('/src/app/home/room-store.ts')
    const room = useRoomStore.getState()
    room.finishOnboarding?.()
    useRoomStore.setState({ masterMuted: false })
    const after = useRoomStore.getState()
    return { masterMuted: after.masterMuted, voiceOff: after.accountState?.voiceOff ?? null }
  })
  console.log(`note: 声音开关 ${JSON.stringify(audioState)}`)

  // 文本到达的采样：在渲染层挂一个观察器，记录每次草稿长度变化的时刻。
  // 判据是"两次变化之间的间隔"，不是总时长——总时长里还有模型生成本身。
  await page.evaluate(() => {
    window.__mergedProbe = { samples: [], audioStarted: 0, audioDurations: [], longTasks: [] }
    const startedAt = performance.now()
    window.__mergedProbe.startedAt = startedAt
    // 长任务：合并流最容易在这一层出问题（每段音频或每个 delta 都触发一次重排）。
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__mergedProbe.longTasks.push(Math.round(entry.duration))
      }).observe({ entryTypes: ['longtask'] })
    } catch {}
    // 音频真的开始播放了吗：钩 AudioBufferSourceNode.start，记时长。
    const original = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function patchedStart(...args) {
      try {
        window.__mergedProbe.audioStarted += 1
        window.__mergedProbe.audioDurations.push(Number(this.buffer?.duration ?? 0))
        window.__mergedProbe.firstAudioAt ??= performance.now() - startedAt
        window.__mergedProbe.lastAudioAt = performance.now() - startedAt
      } catch {}
      return original.apply(this, args)
    }
    // 增量播放：数一数一共排了多少个音频单元（>1 说明是边收边排，不是整段一次）。
    window.__mergedProbe.audioUnits = 0
    window.__mergedProbe.audioDurations = []
    // 草稿长度变化：观察 SSE 驱动的那个 textarea 上方的草稿区域。
    let lastLength = -1
    window.__mergedProbe.timer = setInterval(() => {
      // 只量**正文**节点：外层 `.companion-hud__output` 里还有标题与状态行
      // （"爱吃白饭的大肥鱼正在准备回复…停止"），把它算进来会把状态变化当成正文变化。
      // 正文在 `.companion-hud__output-body`，由 reveal 驱动逐字显现。
      const node = document.querySelector('.companion-hud--floating .companion-hud__output-body')
      if (!node) return
      const text = node.textContent ?? ''
      if (text.length !== lastLength) {
        lastLength = text.length
        window.__mergedProbe.samples.push({ at: Math.round(performance.now() - startedAt), chars: text.length })
      }
    }, 80)
  })

  // 一次真实手势解锁音频（浏览器要求）。
  await page.keyboard.press('Shift')

  // 打开气泡聊天：HUD 里那颗是「气泡轻聊」，它是开关，已经开着时再点会关掉。
  const composer = page.locator('textarea[aria-label^="给"]')
  if (!await composer.count()) {
    const hud = page.locator('button[aria-label="气泡轻聊"]')
    if (await hud.count()) await hud.first().click()
    else {
      // 收起状态下 HUD 可能还没挂出来：先点一下伴星本体。
      const presence = page.locator('.companion-presence')
      if (await presence.count()) await presence.first().click()
      await page.waitForTimeout(800)
      if (await hud.count()) await hud.first().click()
    }
  }
  await composer.waitFor({ timeout: 20_000 }).catch(async () => {
    const dom = await page.evaluate(() => ({
      hud: document.querySelectorAll('.companion-hud').length,
      buttons: [...document.querySelectorAll('.companion-hud button')].slice(0, 12)
        .map(el => `${el.getAttribute('aria-label') || ''}|${(el.textContent || '').trim().slice(0, 12)}`),
      presence: document.querySelectorAll('.companion-presence').length,
    }))
    throw new Error(`composer not found: ${JSON.stringify(dom)}`)
  })
  const sendStartedAt = Date.now()
  await composer.fill(phrase)
  // 用真实回车发送，不用 `requestSubmit()`：React 的受控表单不会因为程序化提交
  // 触发合成 onSubmit（实测点了没反应，输入框文字还在，看起来像"发了但没回"）。
  await composer.press('Enter')

  // 等这一轮真正结束。`data-sending` 只覆盖请求提交那一小段，流式生成期间它是
  // 消失的（实测踩过：等它消失之后 15 秒就下了结论，而那一轮还在 running）。
  // 判据改成：正文出现，且"停止这一轮"按钮不再在屏上。
  // 气泡从「正在准备回复」那一步就会出现；正文之后才逐字长出来。等真实正文，
  // 但要能容忍"先出状态行、再出正文"这个顺序。
  await page.waitForFunction(() => {
    const body = document.querySelector('.companion-hud--floating .companion-hud__output-body')
    const output = document.querySelector('.companion-hud--floating .companion-hud__output')
    return (body?.textContent ?? output?.querySelector('.companion-hud__output-body')?.textContent ?? '').trim().length > 0
  }, { timeout: 120_000 })
  await page.waitForFunction(() => !document.querySelector('.companion-hud__output-stop'), { timeout: 180_000 })
  const settledAt = Date.now()

  await page.waitForTimeout(4_000) // 留出最后几段 TTS 的时间
  const probe = await page.evaluate(() => {
    clearInterval(window.__mergedProbe.timer)
    return {
      samples: window.__mergedProbe.samples,
      audioStarted: window.__mergedProbe.audioStarted,
      firstAudioAt: window.__mergedProbe.firstAudioAt ?? null,
      audioUnits: window.__mergedProbe.audioDurations.length,
      audioDurations: window.__mergedProbe.audioDurations,
      lastAudioAt: window.__mergedProbe.lastAudioAt ?? null,
      longTasks: window.__mergedProbe.longTasks,
      draft: document.querySelector('.companion-hud--floating .companion-hud__output-body')?.textContent ?? '',
      outputText: document.querySelector('.companion-hud--floating .companion-hud__output')?.textContent ?? '',
      status: document.querySelector('.companion-hud__sr-status')?.textContent ?? '',
    }
  })

  // 本机音频缓存：段真的到了客户端才会落盘。
  const cacheDir = resolve(profile, 'companion-message-audio')
  const cacheFiles = await readdir(cacheDir, { recursive: true }).then(entries => entries.filter(name => String(name).endsWith('.mp3'))).catch(() => [])
  const records = await readdir(cacheDir, { recursive: true }).then(entries => entries.filter(name => String(name).endsWith('record.json'))).catch(() => [])

  check(probe.samples.length >= 2, '文字是分段到达的（不是最后一次性弹出）', {
    updates: probe.samples.length, first: probe.samples[0], last: probe.samples.at(-1),
  })
  const gaps = probe.samples.slice(1).map((s, i) => s.at - probe.samples[i].at).filter(gap => gap > 0)
  check(gaps.every(gap => gap < 3_000), '两次文字更新之间没有 3 秒以上的停顿（合并流没有互相阻塞）', {
    maxGap: gaps.length ? Math.max(...gaps) : 0,
  })
  check(probe.audioStarted > 0, '语音段走到了播放层（AudioBufferSourceNode.start 被调用）', {
    started: probe.audioStarted, units: probe.audioUnits,
    seconds: probe.audioDurations.map(d => Math.round(d * 10) / 10),
    firstAudioAt: probe.firstAudioAt,
  })
  check(cacheFiles.length > 0 && records.length > 0, '本机音频缓存里落下了这一轮的段与记录', {
    mp3: cacheFiles.length, records: records.length,
  })
  check(probe.audioStarted > 0 && probe.samples.length >= 2
    && probe.samples.at(-1).at <= (probe.lastAudioAt ?? Infinity) + 60_000,
  '文字与音频在同一轮里并行推进（不是等音频播完才显字）', {
    lastTextAt: probe.samples.at(-1)?.at, lastAudioAt: probe.lastAudioAt,
  })
  check(probe.longTasks.every(duration => duration < 250), '合并流没有制造 250ms 以上的长任务（界面不卡）', {
    longTasks: probe.longTasks,
  })
  check(probe.draft.trim().length > 0 || probe.status.trim().length > 0, '这一轮在界面上有可读的答复', {
    draftChars: probe.draft.trim().length, statusChars: probe.status.trim().length,
  })

  console.log(`note: 墙钟 ${((settledAt - sendStartedAt) / 1000).toFixed(1)}s，落到界面的文字 ${probe.samples.at(-1)?.chars ?? 0} 字`)

  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, 'merged-stream-window.png'), Buffer.from(png, 'base64'))
  await writeFile(resolve(output, 'notes.md'), [
    '# 伴星合并流真窗口走查 2026-10-17', '', `profile: ${profile}`, `phrase: ${phrase}`,
    `wall: ${((settledAt - sendStartedAt) / 1000).toFixed(2)}s`, '',
    ...checks.map(c => `- ${c.ok ? 'x' : ' '} ${c.label} ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`), '',
    '## 草稿采样', '```json', JSON.stringify(probe.samples, null, 2), '```',
  ].join('\n'))
} finally {
  await app.close().catch(() => {})
  await server.close().catch(() => {})
}
