/*
 * 验收：图形故障只换来一次询问，不再替用户换后端（2026-10-09）。
 *
 * 走真实链路：生产 preload 的受信主文档 → `desktop-rendering:report-failure` → 主进程
 * 写 userData → 状态推回设置页。检查四件事：
 * 1. 上报故障后 mode 仍是 default，建议落在 `suggestedFallbackReason` 上。
 * 2. 设置页出现「改用兼容渲染 / 不用了」这条询问，而不是一个已经被拨过去的开关。
 * 3. 点「改用兼容渲染」后建议被答案清掉，重启后后端真的变成 GaneshGL。
 * 4. 点「不用了」只清建议，不动 mode。
 *
 * 用法：npm run build && node scripts/check-rendering-suggestion-flow.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(appRoot, 'outputs/rendering-suggestion-flow-20261009')
mkdirSync(outDir, { recursive: true })
const notesPath = join(outDir, 'notes.md')
writeFileSync(notesPath, '# 渲染建议流程验收\n\n', 'utf8')
const checks = []
const check = (condition, label, detail) => {
  checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) })
  const line = `${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : ` — ${detail}`}`
  console.log(line); appendFileSync(notesPath, `${line}\n`, 'utf8')
}

const profile = mkdtempSync(join(tmpdir(), 'astella-rendering-flow-'))
writeFileSync(join(profile, 'desktop-rendering.json'), JSON.stringify({ version: 1, mode: 'default' }), { mode: 0o600 })
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const rendererPort = process.env.ASTELLA_FLOW_RENDERER_PORT ?? '5217'
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: Number(rendererPort), strictPort: true } })
await server.listen()

const launch = () => electron.launch({
  args: ['.', `--user-data-dir=${profile}`],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${rendererPort}` },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const preference = () => JSON.parse(readFileSync(join(profile, 'desktop-rendering.json'), 'utf8'))
const backend = () => (/\"backend\":\"([^\"]+)\"/.exec(
  readFileSync(join(profile, 'boot-trace.log'), 'utf8').split('\n').filter(line => line.includes('rendering-runtime')).at(-1) ?? '',
) ?? [])[1] ?? null

const email = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const password = process.env.ASTELLA_PROBE_PASSWORD ?? 'probe-c37bpcz4'

async function signIn(page) {
  await page.waitForFunction(
    () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate')),
    undefined, { timeout: 90_000 },
  )
  if (!(await page.locator('.desktop-access-gate input[type="email"]').count())) return
  await page.locator('.desktop-access-gate input[type="email"]').fill(email)
  await page.locator('.desktop-access-gate input[type="password"]').first().fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
}

/** 打开设置中心里的「画面与滚动」这一组。 */
async function openRenderingSettings(page) {
  const click = async (matcher, { exact = false } = {}) => page.evaluate(({ matcher, exact }) => {
    const nodes = [...document.querySelectorAll('button, a[href], [role="button"], summary')]
    const labeled = node => `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.trim()
    // 首页上「设置与快捷操作」也含"设置"二字，必须按精确标签挑轨道那一条。
    const found = nodes.find(node => exact ? (node.getAttribute('aria-label') ?? '').trim() === matcher : labeled(node).includes(matcher))
    if (!found) return false
    found.click()
    return true
  }, { matcher, exact })
  await click('设置', { exact: true })
  await page.waitForTimeout(1500)
  // 直接落到「数据与维护」这一册：点条目要先展开书本导航，脆且与本次要验的东西无关。
  await page.evaluate(async () => {
    const { useRoomStore } = await import('/src/app/room-store.ts')
    useRoomStore.getState().setSettingsSection('management')
  }).catch(() => {})
  await page.waitForTimeout(1200)
  return page.getByRole('switch', { name: '渲染兼容模式' }).count() > 0
}

let app = await launch()
try {
  const page = await app.firstWindow()
  await signIn(page)
  const reported = await page.evaluate(async () => window.astellaDesktop.rendering.reportGraphicsFailure('webgl-context-lost'))
  check(reported.configuredMode === 'default' && reported.activeMode === 'default',
    '上报图形故障后仍在默认后端，没有替用户切换', `${reported.configuredMode}/${reported.activeMode}`)
  check(reported.suggestedFallbackReason === 'webgl-context-lost', '故障被记成一条待答的建议', String(reported.suggestedFallbackReason))
  check(preference().mode === 'default' && preference().suggestedFallbackReason === 'webgl-context-lost',
    '落盘也只记建议，没写 compatible', JSON.stringify(preference()))

  const onSettings = await openRenderingSettings(page)
  check(onSettings, '设置页能看到「渲染兼容模式」这一组')
  if (onSettings) {
    check(await page.getByText(/伴星画布的 WebGL 上下文丢失过/).count() > 0, '设置页出现这条询问')
    check(await page.getByRole('switch', { name: '渲染兼容模式' }).getAttribute('aria-checked') === 'false',
      '开关没有被自动拨过去')
    await page.screenshot({ path: join(outDir, 'offer.png') }).catch(() => {})
    await page.getByRole('button', { name: '改用兼容渲染' }).click()
    await page.waitForTimeout(1200)
    check(preference().mode === 'compatible' && preference().suggestedFallbackReason === undefined,
      '用户答应后：写 compatible 并清掉建议', JSON.stringify(preference()))
    check(await page.getByText('已选择兼容渲染，下次启动生效').count() > 0, '答完之后给出「下次启动生效」的说明')
  }
  await page.evaluate(async () => window.astellaDesktop.rendering.reportGraphicsFailure('gpu-process-failed'))
  check(preference().suggestedFallbackReason === undefined, '已经选了兼容渲染后不再重复建议')
} finally {
  await app.close().catch(() => {})
}

app = await launch()
try {
  const page = await app.firstWindow()
  await signIn(page)
  check(backend() === 'GaneshGL', '重启后真实后端变成 GaneshGL', String(backend()))
  const state = await page.evaluate(async () => window.astellaDesktop.rendering.getState())
  check(state.activeMode === 'compatible' && state.restartRequired === false, '运行时状态与已保存选择一致', `${state.activeMode}/${state.restartRequired}`)
} finally {
  await app.close().catch(() => {})
}

// 撤回并验一次「不用了」只清建议。
writeFileSync(join(profile, 'desktop-rendering.json'), JSON.stringify({ version: 1, mode: 'default' }), { mode: 0o600 })
app = await launch()
try {
  const page = await app.firstWindow()
  await signIn(page)
  await page.evaluate(async () => window.astellaDesktop.rendering.reportGraphicsFailure('gpu-process-failed'))
  const onSettings = await openRenderingSettings(page)
  if (onSettings) {
    await page.getByRole('button', { name: '不用了' }).click()
    await page.waitForTimeout(900)
  }
  check(onSettings, '第二次询问也能进到设置页')
  check(preference().mode === 'default' && preference().suggestedFallbackReason === undefined,
    '点「不用了」只清建议，不动后端', JSON.stringify(preference()))
} finally {
  await app.close().catch(() => {})
  await server.close().catch(() => {})
  rmSync(profile, { recursive: true, force: true })
}

const failed = checks.filter(entry => !entry.ok)
console.log(JSON.stringify({ total: checks.length, failed: failed.length }))
process.exit(failed.length ? 1 : 0)
