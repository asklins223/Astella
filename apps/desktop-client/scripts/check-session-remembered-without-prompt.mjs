/*
 * 验收：登录态跨进程保持，且全程不需要任何系统授权交互（2026-10-09）。
 *
 * 这是把凭据从 Electron `safeStorage`（macOS 走钥匙串）换成 userData 下的 0600
 * 本地文件之后，用户要的那句话的直接检验：
 *
 * 1. 构建出来的主进程产物里不再有 safeStorage 调用（弹窗的唯一来源）。
 * 2. 全新 profile 登录一次 → 凭据文件出现、权限 0600、`credentialPersistence` 报 `local_file`。
 * 3. 关掉进程再用同一个 profile 启动 → 不再碰表单就回到已登录状态。
 *
 * 三步都跑在无人值守的脚本里：任何一次需要人点「允许」，第 3 步就回不到已登录。
 *
 * 用法：npm run build && node scripts/check-session-remembered-without-prompt.mjs
 *   ASTELLA_PROBE_EMAIL / ASTELLA_PROBE_PASSWORD 覆盖探测账号。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer, loadConfigFromFile } from 'vite'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(appRoot, 'outputs/session-remembered-20261009')
mkdirSync(outDir, { recursive: true })
const checks = []
const check = (condition, label, detail) => {
  checks.push({ ok: Boolean(condition), label, ...(detail === undefined ? {} : { detail }) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const credentialName = 'session-credential-local-v1.txt'
const email = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const password = process.env.ASTELLA_PROBE_PASSWORD ?? 'probe-c37bpcz4'

const mainBundle = readFileSync(resolve(appRoot, 'out/main/index.js'), 'utf8')
check(!mainBundle.includes('isEncryptionAvailable'), '主进程产物里没有 safeStorage 可用性探测')
check(!mainBundle.includes('encryptString') && !mainBundle.includes('decryptString'), '主进程产物里没有加解密调用')
check(mainBundle.includes(credentialName), '主进程产物按新文件名保存凭据', credentialName)

const profile = mkdtempSync(join(tmpdir(), 'astella-session-check-'))
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve(appRoot, 'electron.vite.config.ts'))
const rendererPort = process.env.ASTELLA_SESSION_CHECK_PORT ?? '5213'
const server = await createServer({ ...config.renderer, configFile: false, server: { ...config.renderer.server, port: Number(rendererPort), strictPort: true } })
await server.listen()

const launch = () => electron.launch({
  args: ['.', `--user-data-dir=${profile}`],
  cwd: appRoot,
  env: { ...process.env, ELECTRON_RENDERER_URL: `http://localhost:${rendererPort}` },
  executablePath: resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
})
const stateOf = async (page) => page.evaluate(async () => {
  const meta = {
    version: 1, contractVersion: 'desktop-ipc-v1',
    requestId: `chk-${crypto.randomUUID().slice(0, 8)}`, correlationId: `chk-${crypto.randomUUID().slice(0, 8)}`,
    clientStartedAt: new Date().toISOString(),
  }
  const response = await window.astella.auth.getState({ meta })
  return { status: response?.data?.status, persistence: response?.data?.credentialPersistence, email: response?.data?.user?.email ?? null }
})

let app = await launch()
try {
  let page = await app.firstWindow()
  await page.waitForFunction(
    () => Boolean(document.querySelector('.hud-rail')) || Boolean(document.querySelector('.desktop-access-gate input[type="email"]')),
    undefined, { timeout: 90_000 },
  )
  if (await page.locator('.desktop-access-gate').count()) {
    await page.locator('.desktop-access-gate input[type="email"]').fill(email)
    await page.locator('.desktop-access-gate input[type="password"]').first().fill(password)
    const keep = page.locator('.desktop-access-gate__keep-signed-in input')
    check(await keep.count() > 0, '登录页给出「保持登录」这一项', `命中 ${await keep.count()} 个复选框`)
    if (await keep.count()) check(await keep.isChecked(), '「保持登录」默认是勾上的')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForSelector('.hud-rail', { timeout: 90_000 })
  }
  await page.waitForTimeout(1500)

  const credentialPath = join(profile, credentialName)
  const afterSignIn = await stateOf(page)
  check(afterSignIn.status === 'authenticated', '登录成功', afterSignIn.email ?? afterSignIn.status)
  check(statSync(credentialPath).mode % 0o1000 === 0o600, '凭据文件是 0600', `权限 ${(statSync(credentialPath).mode % 0o1000).toString(8)}`)
  check(afterSignIn.persistence === 'local_file', '运行时把持久化报成 local_file', afterSignIn.persistence)
  const written = readFileSync(credentialPath, 'utf8')
  check(!written.includes(password), '落盘的凭据里没有密码本身', `长度 ${written.trim().length}`)
} finally {
  await app.close().catch(() => {})
}

// 换一个进程，只看它能不能自己回到已登录，不填任何东西。
app = await launch()
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.astella), undefined, { timeout: 60_000 })
  const restored = await page.evaluate(async () => {
    const wait = async () => {
      const meta = {
        version: 1, contractVersion: 'desktop-ipc-v1',
        requestId: `rst-${crypto.randomUUID().slice(0, 8)}`, correlationId: `rst-${crypto.randomUUID().slice(0, 8)}`,
        clientStartedAt: new Date().toISOString(),
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await window.astella.auth.getState({ meta })
        if (response?.data?.status !== 'restoring') return response?.data
        await new Promise((done) => setTimeout(done, 500))
      }
      return null
    }
    return wait()
  })
  check(restored?.status === 'authenticated', '换个进程不填表单就回到已登录', restored?.status ?? '超时')
  check(restored?.credentialPersistence === 'local_file', '恢复出来的会话仍报 local_file', restored?.credentialPersistence)
  await page.waitForSelector('.hud-rail', { timeout: 60_000 }).then(
    () => check(true, '恢复后直接进入书房（登录门没有出现）'),
    () => check(false, '恢复后没有出现书房'),
  )
} finally {
  await app.close().catch(() => {})
  await server.close().catch(() => {})
}

const failed = checks.filter((entry) => !entry.ok)
console.log(JSON.stringify({ total: checks.length, failed: failed.length }, null, 1))
rmSync(profile, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
