/** Manual Electron acceptance: fixture dialogue + reviewed MP3, real preload/main/cache/audio graph.
 * No model requests, consent changes, server dialogue writes or edits to the user's running window.
 * Run after npm run build; requires the existing OWNER_EMAIL / OWNER_PASSWORD capture credentials.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, '../../outputs/companion-message-audio')
const directory = await mkdtemp(resolve(tmpdir(), 'astella-message-audio-'))
await mkdir(output, { recursive: true })
assert(process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD, 'Capture credentials are required')
const mp3 = await readFile(resolve(appRoot, 'src/renderer/public/assets/companion/voice-preview-v1/longhua_v3.1.mp3'))
const runId = '11111111-1111-4111-8111-111111111111'
const conversationId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const now = new Date().toISOString()
const meta = epoch => ({ version: 1, contractVersion: 'desktop-ipc-v1', requestId: `audio-qa-${crypto.randomUUID()}`,
  correlationId: 'audio-window-qa', clientStartedAt: new Date().toISOString(), ...(epoch ? { workspaceEpoch: epoch } : {}) })
let app
const errors = []
const report = { fixture: 'Two original MP3 segments for one historical assistant message', checks: [], screenshots: [] }

async function launch() {
  app = await electron.launch({ args: ['.', `--user-data-dir=${directory}`], cwd: appRoot, env: process.env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1440, 810); window.focus() })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(document.querySelector('input[type="email"]'))
    || Boolean(document.querySelector('.nav-collapse')) || Boolean(document.querySelector('.desktop-access-gate__workspace-list button'))
    || [...document.querySelectorAll('button')].some(button => button.textContent === '再试一次'))
  if (await page.getByRole('button', { name: '再试一次', exact: true }).count()) {
    await page.getByRole('button', { name: '再试一次', exact: true }).click()
  }
  if (await page.locator('input[type="email"]').count()) {
    await page.locator('input[type="email"]').fill(process.env.OWNER_EMAIL)
    await page.locator('input[type="password"]').fill(process.env.OWNER_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  if (await page.locator('.desktop-access-gate__workspace-list button').count()) {
    const choices = page.locator('.desktop-access-gate__workspace-list button')
    const owned = choices.filter({ hasText: '所有者' })
    await (await owned.count() ? owned.first() : choices.first()).click()
  }
  await page.locator('.nav-collapse').waitFor()
  if (await page.getByRole('button', { name: '暂不签署', exact: true }).count()) await page.getByRole('button', { name: '暂不签署', exact: true }).click()
  const state = await page.evaluate(async request => {
    const result = await window.astella.auth.getState({ meta: request })
    if (!result.ok) throw new Error(result.error.code)
    return result.data
  }, meta())
  const message = { version: 1, id: messageId, workspaceId: state.workspace.workspaceId, conversationId, seq: 1,
    role: 'assistant', kind: 'text', blocks: [{ type: 'text', text: '窗口验收样本：这条历史消息保留当时生成的两段原声。点击播放可以顺序听完，也可以立即停止。' }],
    runId, clientMessageId: null, contentSha256: 'a'.repeat(64), createdAt: now, editedAt: null }
  await app.evaluate((_electron, fixture) => {
    const original = globalThis.fetch
    globalThis.__messageAudioQa = { syntheses: 0, offline: false }
    const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/voice/tts') {
        if (globalThis.__messageAudioQa.offline) throw new Error('TTS intentionally offline during replay')
        globalThis.__messageAudioQa.syntheses++
        return new Response(Buffer.from(fixture.audioBase64, 'base64'), { headers: { 'Content-Type': 'audio/mpeg', 'X-Astella-Tts-Voice': 'longhua_v3.1' } })
      }
      if (path === '/companion/history') {
        const { id, workspaceId, conversationId, seq, clientMessageId, contentSha256, ...item } = fixture.message
        return json({ version: 1, items: [{ ...item, messageId: id }], nextCursor: null })
      }
      if (path === '/companion/inbox/ensure') return json({ version: 1, id: fixture.message.conversationId,
        workspaceId: fixture.message.workspaceId, userId: fixture.userId, kind: 'inbox', title: '音频缓存验收', titleSource: 'system',
        status: 'active', createdAt: fixture.message.createdAt, updatedAt: fixture.message.createdAt, lastMessageAt: fixture.message.createdAt })
      if (path === `/companion/conversations/${fixture.message.conversationId}/messages`) return json({ version: 1, items: [fixture.message], hasMore: false, oldestSeq: 1 })
      return original(input, init)
    }
  }, { message, userId: state.user.userId, audioBase64: mp3.toString('base64') })
  return { page, state }
}
async function openCenter(page) {
  if (await page.getByLabel('展开目录', { exact: true }).count()) await page.getByLabel('展开目录', { exact: true }).click()
  await page.getByRole('button', { name: '伴星', exact: true }).click()
  await page.getByRole('tab', { name: '对话', exact: true }).click()
  await page.getByRole('button', { name: '播放这条消息的音频', exact: true }).waitFor()
}
async function screenshot(page, name) {
  // CDP page screenshots crop incorrectly after changing Electron's zoom on Retina displays.
  const bytes = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, name), Buffer.from(bytes, 'base64'))
  report.screenshots.push(name)
}
async function exercise(page) {
  const button = page.getByRole('button', { name: '播放这条消息的音频', exact: true })
  await button.click()
  await page.getByRole('button', { name: '停止播放这条消息的音频', exact: true }).waitFor()
  await page.waitForFunction(() => {
    const button = document.querySelector('.companion-message-audio__button')
    return button?.getAttribute('aria-pressed') === 'true' && !button.querySelector('.companion-hud__spin')
  })
  await page.getByRole('button', { name: '停止播放这条消息的音频', exact: true }).click()
  await button.waitFor()
  // Repeated reversal should take effect without waiting for the old local read or animation.
  await button.click()
  await page.getByRole('button', { name: '停止播放这条消息的音频', exact: true }).click()
  await button.waitFor()
}

try {
  let { page, state } = await launch()
  for (const ordinal of [2, 1]) {
    const result = await page.evaluate(async input => window.astella.companion.voice.speakSegment(input), {
      meta: meta(state.workspaceEpoch), request: { version: 2, conversationId, runId, generation: 1, ordinal,
        segmentId: ordinal.toString(16).padStart(64, '0') },
    })
    assert(result.ok, JSON.stringify(result.error))
    assert.equal(result.data.byteLength, mp3.length)
    assert.equal(result.data.voice, 'longhua_v3.1')
  }
  const availability = await page.evaluate(input => window.astella.companion.voice.cachedList(input), {
    meta: meta(state.workspaceEpoch), request: { runIds: [runId] },
  })
  assert.deepEqual(availability.data.items, [{ runId, ordinals: [1, 2] }])
  report.checks.push('Real IPC synthesis results persist as two ordered segments under one local message')
  await app.evaluate(() => { globalThis.__messageAudioQa.offline = true })
  await openCenter(page)
  await exercise(page)
  await screenshot(page, 'center-1440.png')
  for (const zoom of [1.25, 1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), zoom)
    await page.getByRole('button', { name: '播放这条消息的音频', exact: true }).waitFor()
    await page.getByRole('button', { name: '播放这条消息的音频', exact: true }).scrollIntoViewIfNeeded()
    const bounds = await page.locator('.companion-message-audio__button').evaluate(button => {
      const rect = button.getBoundingClientRect()
      return { right: rect.right, left: rect.left, bottom: rect.bottom, top: rect.top, viewport: innerWidth, height: innerHeight }
    })
    assert(bounds.left >= 0 && bounds.right <= bounds.viewport, `Button outside viewport at ${zoom}`)
    assert(bounds.top >= 0 && bounds.bottom <= bounds.height, `Button vertically outside viewport at ${zoom}: ${JSON.stringify(bounds)}`)
    await screenshot(page, `center-${zoom * 100}.png`)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await page.locator('button[aria-label="返回学习空间"]:not([inert])').click()
  await page.getByRole('button', { name: '对话手记', exact: true }).click()
  await page.getByRole('button', { name: '播放这条消息的音频', exact: true }).waitFor()
  await exercise(page)
  await screenshot(page, 'journal-1440.png')
  assert.equal(await app.evaluate(() => globalThis.__messageAudioQa.syntheses), 2)
  report.checks.push('Both history surfaces play and immediately stop original local audio with TTS offline; no replacement synthesis')
  report.checks.push('Center playback remains inside the viewport at 125%, 150% and 200% zoom')
  await app.close(); app = null

  // Same userData, fresh Electron process, empty in-memory cache and unavailable TTS.
  ;({ page, state } = await launch())
  await app.evaluate(() => { globalThis.__messageAudioQa.offline = true })
  await openCenter(page)
  await exercise(page)
  assert.equal(await app.evaluate(() => globalThis.__messageAudioQa.syntheses), 0)
  report.checks.push('Fresh Electron process reads and plays the retained MP3 without a TTS request')
  const accounts = await readdir(resolve(directory, 'companion-message-audio'))
  const messages = await readdir(resolve(directory, 'companion-message-audio', accounts[0]))
  assert.equal(messages.length, 1)
  const files = await readdir(resolve(directory, 'companion-message-audio', accounts[0], messages[0]))
  assert.deepEqual(files.sort(), ['1.mp3', '2.mp3', 'record.json'])
  report.checks.push('One message occupies one cache entry with two original MP3 files and a committed index')
  report.errors = errors
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2))
  await Promise.all(['failed-stage.png', 'failed-stage.txt'].map(name => rm(resolve(output, name), { force: true })))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  if (app) {
    const page = await app.firstWindow()
    await screenshot(page, 'failed-stage.png').catch(() => undefined)
    await writeFile(resolve(output, 'failed-stage.txt'), await page.locator('body').innerText()).catch(() => undefined)
  }
  throw error
} finally {
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}
