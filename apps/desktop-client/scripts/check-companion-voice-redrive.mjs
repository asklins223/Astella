/**
 * 真窗口走查：本机没留下录音的那一条，补听入口在不在、说的话实不实在（2026-10-16）。
 *
 * 为什么要在真窗口跑：jsdom 用例只证明组件逻辑，证明不了三件事——
 *   ① preload 有没有把 `listRunVoiceSegments` 这条通道真的挂上 `window.astella`；
 *   ② 真实会话列表里，没有本机缓存的那些条目现在渲染成什么（旧代码是留一格空白）；
 *   ③ 点下去之后走的是 IPC 还是网络错误，用户看到的到底哪句。
 * 用一个**全新临时 profile** 起隔离实例：音频缓存按 `hash(deployment+userId)` 落在
 * userData 里，空 profile 就等于"本机一个字都没存过"，正是这条改动针对的场景。
 *
 * 跑法（dev 栈要在起：api :4000）：
 *   cd apps/desktop-client
 *   ASTELLA_PROBE_EMAIL=… ASTELLA_PROBE_PASSWORD=… node scripts/check-companion-voice-redrive.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const output = resolve(appRoot, 'outputs/voice-redrive-20261016')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(resolve(tmpdir(), 'astella-redrive-'))
const email = process.env.ASTELLA_PROBE_EMAIL
const password = process.env.ASTELLA_PROBE_PASSWORD
if (!email || !password) throw new Error('ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD required')

const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: 5217, strictPort: true } })
await server.listen()
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`, '--remote-debugging-port=9241'],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5217' },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const page = await app.firstWindow()
const checks = []
const check = (ok, label, detail) => { checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`) }

try {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 810); w.show(); w.focus() })
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

  // ① 通道真的在窗上（改 preload 之后必须重启实例才带上，这里就是那道确认）。
  const channel = await page.evaluate(() => typeof window.astella?.companion?.chat?.listRunVoiceSegments)
  check(channel === 'function', 'window.astella.companion.chat.listRunVoiceSegments 是函数', { channel })

  // 打开对话手记：HUD 里那条是**只有图标的按钮**，可访问名在 title/aria-label 上，
  // 文本选择器命中不了（走查老坑），所以按 title 找再用 element.click()（导航条会被 svg 拦 pointer events）。
  const open = async (title) => page.evaluate(title => {
    const hit = [...document.querySelectorAll('button')]
      .find(el => (el.getAttribute('title') || el.getAttribute('aria-label') || '').startsWith(title) && el.getBoundingClientRect().width > 0)
    if (hit) { hit.click(); return true }
    return false
  }, title)
  const scan = () => page.evaluate(() => {
    const visible = selector => [...document.querySelectorAll(selector)].filter(el => el.getBoundingClientRect().width > 0)
    const named = name => visible('button').filter(el => (el.textContent || '').includes(name) || (el.getAttribute('aria-label') || '').includes(name))
    return {
      redrive: named('补听这段').length,
      cached: named('播放这条消息的音频').length,
      records: visible('.companion-record__author, .cc-thread article').length,
      thread: visible('.cc-thread').length,
    }
  })

  check(await open('对话手记'), '对话手记的入口点得动（图标按钮按 title 找）')
  await page.waitForTimeout(2_500)
  let counts = await scan()
  check(counts.records > 0, '手记里有可读的伴星条目', counts)
  // 空 profile = 本机没有音频缓存：旧代码在这里什么都不渲染（一格空白），新代码给补听入口。
  check(counts.cached === 0, '对照：本机确实没有音频缓存', counts)
  check(counts.redrive > 0, '手记里没有本机缓存的条目渲染出「补听这段」', counts)

  // 伴星中心的「连续对话」是同一颗按钮的另一个挂载点，而那一层**根本不暴露 conversation**：
  // 早先请求要求带 conversationId，于是这里的入口点了只会说"暂时取不回来"。这条就是钉那个洞。
  if (await open('伴星中心')) {
    await page.waitForTimeout(1_500)
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('button, [role="tab"]')]
        .find(el => (el.textContent || '').includes('连续对话') && el.getBoundingClientRect().width > 0)
      if (tab) tab.click()
    })
    await page.waitForTimeout(2_500)
    const centre = await scan()
    check(centre.thread > 0, '伴星中心的连续对话渲染出来了', centre)
    check(centre.redrive > 0, '连续对话里同样给补听入口（那一层没有 conversationId）', centre)
    counts = { ...counts, ...centre, redrive: counts.redrive + centre.redrive }
  }

  if (counts.redrive > 0) {
    // ③ 点下去：dev 库里没有留档的语音事件，所以诚实的答案是"没有留下语音记录"，
    // 而不是通用报错，也不是假装还能放。
    await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(el => (el.textContent || '').includes('补听这段') && el.getBoundingClientRect().width > 0)[0]?.click())
    await page.waitForTimeout(2_500)
    const status = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[role="status"]')].filter(el => el.getBoundingClientRect().width > 0)
      return nodes.map(el => (el.textContent || '').trim()).filter(Boolean)
    })
    const honest = status.some(text => text.includes('没有留下语音记录'))
    check(honest, '取不到留档时说实话，不给通用报错', { status })
    const spinning = await page.evaluate(() => document.querySelectorAll('.companion-hud__spin').length)
    check(spinning === 0, '失败后退回 idle，不卡在转圈', { spinning })
  }

  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(resolve(output, 'redrive-window.png'), Buffer.from(png, 'base64'))
  await writeFile(resolve(output, 'notes.md'), `# 补听入口真窗口走查 2026-10-16\n\nprofile: ${profile}\n\n${checks.map(c => `- ${c.ok ? 'x' : ' '} ${c.label} ${c.detail === undefined ? '' : JSON.stringify(c.detail)}`).join('\n')}\n`)
} finally {
  await app.close().catch(() => {})
  await server.close().catch(() => {})
}
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
