import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, '../../outputs/companion-notifications-20261004')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-notifications-'))
if (process.env.ASTELLA_QA_SESSION_PROFILE) await copyFile(resolve(process.env.ASTELLA_QA_SESSION_PROFILE, 'session-credential-v1.bin'), resolve(profile, 'session-credential-v1.bin'))
process.env.ASTELLA_VOICE_ASR_DIR = resolve(profile, 'voice-models')
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5199, strictPort: true } })
await server.listen()
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9238'], cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5199' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') })
const page = await app.firstWindow()
const errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))
const check = (condition, label, detail) => { checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) }); console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`) }
const shot = async name => {
  await page.waitForTimeout(300)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, `${name}.png`), Buffer.from(png, 'base64'))
}
const room = fn => page.evaluate(async source => {
  const { useRoomStore } = await import('/src/app/room-store.ts')
  return (new Function('room', source))(useRoomStore)
}, fn)
const publish = input => page.evaluate(async input => {
  const { notifyCompanion } = await import('/src/components/companion/companion-notifications.ts')
  notifyCompanion(input)
}, input)
const reset = () => page.evaluate(async () => {
  const { useCompanionNotifications } = await import('/src/components/companion/companion-notifications.ts')
  useCompanionNotifications.setState({ items: [] })
})
try {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 810); window.show(); window.focus() })
  await page.waitForFunction(() => document.querySelector('.companion-presence, .desktop-access-gate input[type="email"]'), { timeout: 30_000 })
  if (!await page.locator('.companion-presence').count()) {
  if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) throw new Error('Local QA owner credentials unavailable')
  await page.locator('.desktop-access-gate input[type="email"]').fill(process.env.OWNER_EMAIL)
  await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await page.locator('.companion-presence').count()) break
    const workspaces = page.locator('.desktop-access-gate__workspace-list button')
    if (await workspaces.count()) await workspaces.first().click()
    const error = page.locator('.desktop-access-gate__form-error')
    if (await error.count()) throw new Error(`Login failed: ${await error.innerText()}`)
    await page.waitForTimeout(250)
  }
  await room('room.getState().finishOnboarding(); room.setState({ masterMuted: false });')
  await page.waitForFunction(() => document.querySelector('.window-live2d')?.dataset.companionStatus === 'ready', { timeout: 30_000 })
  await reset()
  const state = await page.evaluate(async () => {
    const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
    return unwrapGatewayResult(await window.astella.companion.voice.asrModel.getState({ meta: createRequestMeta() }))
  })
  if (!state?.status || !state.expectedBytes) throw new Error('QA model snapshot unavailable')
  await app.evaluate(({ ipcMain }, state) => {
    globalThis.notificationQa = { state, cancelled: 0 }
    const reply = input => ({ version: 1, ok: true, requestId: input.meta.requestId, data: globalThis.notificationQa.state })
    for (const [suffix, action] of [['state', null], ['download', 'downloading'], ['cancel', 'absent']]) {
      const channel = `astella.v1.companion.voice.asrModel.${suffix}`
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_, input) => {
        if (action) { globalThis.notificationQa.state = { ...globalThis.notificationQa.state, status: action, receivedBytes: action === 'downloading' ? 80_000_000 : 0, activeSource: action === 'downloading' ? '魔搭社区' : null }; if (suffix === 'cancel') globalThis.notificationQa.cancelled++ }
        return reply(input)
      })
    }
  }, state)
  await page.locator('.window-live2d button').click()
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.locator('.settings-voice-model').waitFor()
  await page.getByRole('heading', { name: '先装好，我就能听你说了' }).waitFor()
  check(await page.locator('[data-settings-page="voice"][data-settings-active="true"]').count(), 'missing model automatically opens voice settings')
  check(await page.locator('.settings-voice-model').evaluate(node => node === document.activeElement), 'download card receives keyboard focus')
  check(await page.locator('.companion-hud__voice').count() === 0, 'missing-model path closes the recording bubble')
  await page.getByText('正在轻声提醒你', { exact: true }).waitFor({ timeout: 5_000 })
  check(true, 'missing-model guidance uses the actual shared audio host')
  await shot('01-model-needed')
  await page.getByRole('button', { name: '语音输入', exact: true }).click()
  await page.waitForTimeout(300)
  const repeated = await page.evaluate(async () => {
    const { useCompanionNotifications } = await import('/src/components/companion/companion-notifications.ts')
    return useCompanionNotifications.getState().items.filter(item => item.id === 'voice-model-needed').map(item => item.revision)
  })
  check(repeated.length === 1 && repeated[0] === 2, 'repeated missing-model clicks update one notice')
  check(await page.locator('.companion-hud__composer').count() === 0, 'an old character wake does not reopen the chat composer')
  await page.getByRole('button', { name: '下载到这台设备', exact: true }).click()
  await page.getByRole('heading', { name: '语音模型正在下载' }).waitFor({ timeout: 8_000 })
  await page.locator('.companion-notification-paper').getByRole('button', { name: '取消下载', exact: true }).click()
  check(await app.evaluate(() => globalThis.notificationQa.cancelled) === 1, 'cancel action reaches the device download controller')
  await page.getByRole('button', { name: '下载到这台设备', exact: true }).click()
  await page.getByRole('heading', { name: '语音模型正在下载' }).waitFor({ timeout: 8_000 })
  await app.evaluate(() => { globalThis.notificationQa.state = { ...globalThis.notificationQa.state, status: 'error', failure: 'network', activeSource: null } })
  await page.getByRole('heading', { name: '语音模型还没装好' }).waitFor({ timeout: 8_000 })
  check(true, 'a failed download arrives with an actionable retry notice')
  await page.getByRole('button', { name: '去设置重试', exact: true }).click()
  await page.getByRole('button', { name: '重试下载', exact: true }).click()
  await page.getByRole('heading', { name: '语音模型正在下载' }).waitFor({ timeout: 8_000 })
  await room('room.getState().invoke("home")')
  await app.evaluate(() => { globalThis.notificationQa.state = { ...globalThis.notificationQa.state, status: 'ready', receivedBytes: globalThis.notificationQa.state.expectedBytes, installedBytes: globalThis.notificationQa.state.expectedBytes, installedAt: '2026-10-04T06:00:00.000Z', activeSource: null } })
  await page.getByRole('heading', { name: '语音输入准备好了' }).waitFor({ timeout: 8_000 })
  check(true, 'completion delivered after leaving Settings')
  await shot('02-model-ready')
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  await reset()
  await page.evaluate(async () => {
    const { beginCompanionSpeechLine } = await import('/src/app/companion-voice-playback.ts')
    window.notificationQaReply = beginCompanionSpeechLine()
  })
  await publish({ id: 'qa-background', kind: 'task', scope: 'device', title: '后台任务准备好了', body: '这是一条通过通知入口投递的后台完成消息。', audio: { clip: 'task-ready', text: '后台任务完成了' } })
  await page.waitForTimeout(900)
  check(await page.getByRole('heading', { name: '后台任务准备好了' }).count() === 0, 'background delivery waits for an active reply')
  await publish({ id: 'qa-direct', kind: 'help', scope: 'device', delivery: 'immediate', title: '这条提示先安静送达', body: '当前伴星正在回复，系统帮助可以阅读，声音让给回复。', audio: { clip: 'voice-model-needed', text: '先下载模型' } })
  await page.getByRole('heading', { name: '这条提示先安静送达' }).waitFor()
  check(await page.getByText('伴星正在回复，本条安静送达').count(), 'direct guidance stays silent while reply channel is reserved')
  await shot('03-busy-silent')
  await page.getByRole('button', { name: '关闭这条通知', exact: true }).click()
  await page.evaluate(() => window.notificationQaReply.stop())
  await page.getByRole('heading', { name: '后台任务准备好了' }).waitFor({ timeout: 5_000 })
  check(true, 'waiting message appears after reply releases the channel')
  await reset()
  await publish({ id: 'qa-long', kind: 'review', scope: 'device', delivery: 'immediate', title: '今天的学习与复习提醒', body: '这是一条需要保留完整内容的学习提醒。'.repeat(22), snoozable: true, actions: [{ id: 'ok', kind: 'confirm', label: '知道了' }, { id: 'cancel', kind: 'cancel', label: '今天先不提醒' }] })
  await page.getByRole('heading', { name: '今天的学习与复习提醒' }).waitFor()
  for (const zoom of [1, 1.25, 1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
    await page.waitForTimeout(450)
    const geometry = await page.evaluate(() => {
      const node = document.querySelector('.companion-notifications'); const r = node.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, contentScrolls: document.querySelector('.companion-notification-paper__content').scrollHeight > document.querySelector('.companion-notification-paper__content').clientHeight }
    })
    check(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.width && geometry.bottom <= geometry.height, `long notification fits at ${zoom * 100}%`, geometry)
    await shot(`04-long-${zoom * 100}`)
  }
  await page.getByRole('button', { name: '10 分钟后', exact: true }).click()
  check(await page.getByRole('heading', { name: '今天的学习与复习提醒' }).count() === 0, 'snooze returns to a quiet inbox')
  await page.getByRole('button', { name: /查看伴星通知/ }).click()
  await page.getByRole('button', { name: /今天的学习与复习提醒/ }).click()
  await page.getByRole('button', { name: '今天先不提醒', exact: true }).click()
  check(true, 'notification can be revisited and cancelled through inbox')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720))
  await reset(); await publish({ id: 'qa-minimum', kind: 'help', scope: 'device', delivery: 'immediate', title: '小窗口里的通知', body: '通知留在窗口内，正文和伴星保留各自的位置。', actions: [{ id: 'ok', kind: 'confirm', label: '确认' }] })
  await page.getByRole('button', { name: '确认', exact: true }).waitFor()
  const fitsMinimum = await page.locator('.companion-notifications').evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })
  check(fitsMinimum, 'notification fits the native minimum 1280 × 720 window')
  await shot('05-minimum-window')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 810))
  await room('room.getState().setMotionMode("off")')
  await reset(); await publish({ id: 'qa-off', kind: 'help', scope: 'device', delivery: 'immediate', title: '动效关闭也能直接操作', body: '功能与焦点不等待动画。', actions: [{ id: 'ok', kind: 'confirm', label: '确认' }] })
  await page.getByRole('button', { name: '确认', exact: true }).click(); check(true, 'Off keeps confirmation available immediately')
  await room('room.getState().setMotionMode("full")')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await reset(); await publish({ id: 'qa-reduced', kind: 'help', scope: 'device', delivery: 'immediate', title: '系统减少动态', body: '系统偏好优先，通知与操作直接呈现。', actions: [{ id: 'ok', kind: 'confirm', label: '确认' }] })
  await page.getByRole('button', { name: '确认', exact: true }).waitFor()
  check(await page.locator('.companion-notification-paper').evaluate(node => getComputedStyle(node).transform === 'none'), 'system reduced motion overrides Full')
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const audio = await page.evaluate(async () => {
    const manifest = await (await fetch('/assets/companion-notifications/manifest.json')).json()
    const context = new AudioContext(), result = []
    for (const [id, clip] of Object.entries(manifest.clips)) { const bytes = await (await fetch(`/assets/companion-notifications/${clip.file}`)).arrayBuffer(); const byteLength = bytes.byteLength; const audio = await context.decodeAudioData(bytes); result.push({ id, duration: audio.duration, bytes: byteLength }) }
    await context.close(); return result
  })
  check(audio.length === 6 && audio.every(clip => clip.duration > 1), 'all six Edge TTS clips decode in Electron', audio)
  const dynamicAudio = await page.evaluate(async () => {
    const { createRequestMeta, unwrapGatewayResult } = await import('/src/app/desktop-client.ts')
    const response = unwrapGatewayResult(await window.astella.companion.voice.speak({ meta: createRequestMeta(), request: { version: 1, text: '这是一条通知语音，方便的时候可以打开看看。', purpose: 'notification' } }))
    const context = new AudioContext()
    const bytes = Uint8Array.from(atob(response.audioBase64), letter => letter.charCodeAt(0))
    const decoded = await context.decodeAudioData(bytes.buffer)
    await context.close()
    return { mimeType: response.mimeType, bytes: response.byteLength, duration: decoded.duration }
  })
  check(dynamicAudio.mimeType === 'audio/mpeg' && dynamicAudio.duration > 1, 'dynamic notification TTS works through the real renderer/preload/main/API chain', dynamicAudio)
  check(errors.length === 0, 'no renderer errors', errors)
} catch (error) { checks.push({ ok: false, label: 'window interaction stopped', detail: error.message }); console.error(error.message); await shot('failure').catch(() => {}) }
finally {
  await writeFile(resolve(output, 'window-checks.json'), `${JSON.stringify({ date: '2026-10-04', mode: 'Electron with Vite renderer; simulated model states in an isolated profile', checks, errors }, null, 2)}\n`)
  await app.close(); await server.close()
}
if (checks.some(check => !check.ok)) process.exitCode = 1
