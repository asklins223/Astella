/**
 * 真窗口核验：伴星对话的两档思考（2026-10-07）。
 *
 * 判据在 worker 侧（`companion-turn-thinking`），所以这里只看两件事：
 * 1. 闲聊与提问各自**多久**回第一版正文（延迟是这次改动的动机）；
 * 2. 提问轮的正文有多长（输出预算改成按模型档案声明之后，不该再看到半截话）。
 * worker 日志里的 `companion turn thinking mode decided` 给出这一轮到底开没开。
 */
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-thinking-20261007')
const { mkdirSync } = await import('node:fs')
mkdirSync(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
const since = new Date().toISOString()

// 这台 dev 上常有别的探针挂在同一个窗口：先确认挂的是**自己的**探测账号，
// 不是就把会话退掉、用 companion-probe 登进来（不去动别人的账号，也不往别人
// 的伴星身上写测试对话）。
const probeEmail = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const probePassword = process.env.ASTELLA_PROBE_PASSWORD ?? ''
const currentEmail = () => page.evaluate(async () => {
  const meta = {
    version: 1, contractVersion: 'desktop-ipc-v1',
    requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), clientStartedAt: new Date().toISOString(),
  }
  const response = await window.astella.auth.getState({ meta })
  const data = response?.ok ? response.data : null
  return data?.account?.email ?? data?.user?.email ?? null
}).catch(() => null)

if (await page.locator('.hud-rail').count()) {
  const signedIn = await currentEmail()
  if (signedIn && signedIn !== probeEmail) {
    log(`窗口挂着 ${signedIn}，退出后用自己的探测账号`)
    await page.evaluate(async () => {
      const meta = {
        version: 1, contractVersion: 'desktop-ipc-v1',
        requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), clientStartedAt: new Date().toISOString(),
      }
      await window.astella.auth.logout({ meta })
    }).catch(() => null)
  }
}
if (await page.locator('.desktop-access-gate').count()) {
  if (await page.getByRole('button', { name: /创建账号/ }).count() === 0) {
    await page.getByRole('button', { name: /已有账号？登录|还没有账号？注册/ }).first().click()
  }
  await page.locator('.desktop-access-gate input[type="email"]').fill(probeEmail)
  await page.locator('.desktop-access-gate input[type="password"]').first().fill(probePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
  log(`已用探测账号登录：${probeEmail}`)
}
await page.waitForTimeout(3000)

const sendTurn = async (text) => {
  // 时间线在「对话手记」抽屉里才有条目；气泡的纸面会收回，按它数会漏。
  await page.getByRole('button', { name: '对话手记' }).click({ force: true }).catch(() => {})
  await page.waitForSelector('.companion-history article[data-role="user"]', { timeout: 20_000 })
  const before = await page.evaluate(() => document.querySelectorAll('article[data-role="assistant"]').length)
  const started = Date.now()
  await page.locator('.companion-history textarea').fill(text)
  await page.keyboard.press('Enter')
  // 等这一轮真的落定：会话里出现一条新的 assistant 消息。
  await page.waitForFunction((seen) => document.querySelectorAll('article[data-role="assistant"]').length > seen,
    before, { timeout: 240_000 }).catch(() => null)
  const elapsedMs = Date.now() - started
  const reply = await page.evaluate(() => {
    const all = [...document.querySelectorAll('article[data-role="assistant"] .companion-record__body')]
    return all.length ? all[all.length - 1].textContent ?? '' : ''
  })
  return { elapsedMs, chars: reply.length, reply: reply.replace(/\s+/g, ' ').slice(0, 260) }
}

const casual = await sendTurn('在干嘛呢')
log(`闲聊轮：${(casual.elapsedMs / 1000).toFixed(1)}s，正文 ${casual.chars} 字 —— ${casual.reply}`)

const question = await sendTurn('帮我讲清楚什么是「熵」，用一个生活里的例子，再顺手给一个容易搞错的点。')
log(`提问轮：${(question.elapsedMs / 1000).toFixed(1)}s，正文 ${question.chars} 字 —— ${question.reply}`)

const decisions = await new Promise((r) => execFile('docker', ['logs', '--since', '6m', 'astella-dev-worker-1'],
  { maxBuffer: 40 << 20 }, (_e, stdout) => r(String(stdout))))
const decided = decisions.split('\n').filter((l) => /thinking mode decided|disableThinking|basis/.test(l)).slice(-12)
log('worker 侧判定：\n  ' + decided.join('\n  '))

await writeFile(join(outDir, 'notes.md'), notes.join('\n'), 'utf8')
await page.screenshot({ path: join(outDir, 'turns.png') })
await browser.close()
