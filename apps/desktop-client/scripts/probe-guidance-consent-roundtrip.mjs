/**
 * 真窗口：缺同意 → 去设置同意 → 签署 → 离开设置，带路要接回**同一站**并出声。
 *
 * 这一段是首次进入里唯一还没在真窗口跑过的分支（2026-10-07 修掉「会话重核会抹掉交接」之后）。
 * 跑法：从岛里开完整带路 → 走到第二站 → 此时同意被清着，讲解页应说清缺什么而不是空撞合成 →
 * 点「去设置同意」看是否真的落在同意卡上（分区键那处修复）→ 在设置页签署 → 回书房 →
 * 看带路是不是停在第二站、并且这一段真的念出来。
 *
 * 账号用窗口里已登着的那个，不注册新账号：它的同意状态由调用方在跑之前清掉、跑完由设置页重新签署。
 */
import { chromium } from 'playwright'
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-guidance-first-run-20261007')
mkdirSync(outDir, { recursive: true })
const logPath = join(outDir, 'consent-roundtrip.md')
writeFileSync(logPath, '', 'utf8')
const push = (line) => { console.log(line); appendFileSync(logPath, `${line}\n`, 'utf8') }
const ok = (m) => push(`✓ ${m}`), info = (m) => push(`· ${m}`), bad = (m) => push(`✗ ${m}`)

const cacheRoot = join(homedir(), 'Library', 'Application Support', 'astella-desktop-client', 'companion-guidance-audio')
const clips = () => existsSync(cacheRoot)
  ? readdirSync(cacheRoot).flatMap(dir => readdirSync(join(cacheRoot, dir)).filter(f => f.endsWith('.mp3'))
    .map(f => ({ file: `${dir.slice(0, 8)}/${f.slice(0, 12)}.mp3`, bytes: statSync(join(cacheRoot, dir, f)).size })))
  : []

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => !p.url().includes('devtools'))
await page.bringToFront()
page.on('console', (m) => { if (m.text().startsWith("[gd]")) info(`控制台 ${m.text()}`) })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
const shot = async (name) => page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => info(`截图失败 ${name}`))
const dom = () => page.evaluate(() => ({
  step: document.querySelector('.guidance-stage')?.dataset.step ?? null,
  speaking: document.querySelector('.guidance-narration')?.dataset.speaking ?? null,
  foot: (document.querySelector('.guidance-narration__foot')?.innerText ?? '').replace(/\s+/g, ' '),
  chapter: (document.querySelector('.guidance-narration__label span')?.textContent ?? '').trim(),
}))

info(`账号：${await page.locator('.room-control-account').getAttribute('aria-label') ?? '（读不到）'}`)
const clipsBefore = clips();
info(`开跑前本地讲解录音 ${clipsBefore.length} 段`)

// ── 1. 从岛里开带路，走到第二站 ────────────────────────────────────────
await page.locator('.room-control-trigger').click({ force: true })
await page.waitForTimeout(700)
await page.locator('.room-control-guide').click({ force: true })
await page.waitForTimeout(900)
await page.getByRole('button', { name: /跟我完整走一遍/ }).click()
await page.waitForSelector('.guidance-stage', { timeout: 20_000 })
await page.locator('.guidance-stage__next').click()
await page.waitForTimeout(1500)
let now = await dom();
if (now.step !== 'notes') { bad(`没走到第二站（实际 ${now.step}），后面判不了「接回同一站」`); await browser.close(); process.exit(1) }
info(`已在第二站：${now.chapter}`)

// ── 2. 缺同意：说清楚、给入口，且这一段不出门 ──────────────────────────
const tBefore = new Date().toISOString()
if (/还差一步|签署 AI 使用同意/.test(now.foot)) ok('未签署时讲解页说清了缺哪一步')
else bad(`未签署时页脚不是同意说明："${now.foot}"`)
const button = page.getByRole('button', { name: '去设置同意' })
if (await button.count()) ok('第二站上有「去设置同意」入口')
else bad('没有同意入口')
await shot('30-consent-missing')

// ── 3. 点入口：要真的落在同意卡上并闪一下 ──────────────────────────────
await button.click()
await page.waitForSelector('.settings-hud', { timeout: 20_000 })
await page.waitForTimeout(1600)
if (await page.locator('[data-attention="ai-consent"]').count()) ok('设置页落到 AI 同意卡并高亮（分区键修复生效）')
else bad('设置页没有落在同意卡上（分区或高亮没接上）')
await shot('31-consent-card')

// ── 4. 在设置页签署 ────────────────────────────────────────────────────
const consentText = await page.locator('.settings-hud').innerText()
if (consentText.includes('已签署')) info('同意已是签署态')
else {
  await page.getByRole('button', { name: '签署', exact: true }).click()
  await page.waitForTimeout(2500)
  const after = await page.locator('.settings-hud').innerText()
  if (after.includes('已签署')) ok('已在设置页签署 AI 使用同意')
  else bad('签署后设置页仍没显示已签署')
}

// ── 5. 回书房：接回同一站，并且这一段真的念出来 ────────────────────────
await page.locator('.hud-rail button[data-label="首页"]').click({ force: true })
await page.waitForTimeout(1800)
now = await dom()
if (now.step === 'notes') ok('离开设置后带路停在原来那一站（第二站），没有从第一站重播')
else if (now.step) bad(`接回了但站不对：${now.step}`)
else bad('离开设置后带路没接回来')
let spoke = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 35_000 })
} catch { spoke = false }
now = await dom()
if (spoke) ok(`这一站真的出声了（${now.chapter}，页脚="${now.foot}"）`)
else bad(`35 秒内没进入 speaking：站=${now.step} 页脚="${now.foot}"`)
await shot('32-resumed-and-speaking')

// ── 6. 再往前一站，确认接回来之后路线仍然连贯 ───────────────────────────
await page.locator('.guidance-stage__next').click()
await page.waitForTimeout(1200)
let next = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 30_000 })
} catch { next = false }
now = await dom()
if (now.step === 'reading' && next) ok('接回后继续往下走正常（第三站并出声）')
else bad(`第三站不对或没声：实际=${now.step} speaking=${now.speaking} 页脚="${now.foot}"`)
await shot('33-step-reading')

const clipsAfter = clips()
const added = clipsAfter.filter(c => !clipsBefore.some(b => b.file === c.file))
if (added.length) ok(`本轮新落本地录音 ${added.length} 段：${added.map(c => `${c.file} ${c.bytes}B`).join('、')}`)
else if (clipsAfter.length) info(`录音总数 ${clipsAfter.length} 段，本轮没有新增（命中已有缓存）`)
else bad('本地没有录音缓存')

await page.getByRole('button', { name: '结束带看' }).click()
await page.waitForTimeout(900)
if ((await page.locator('.guidance-stage').count()) === 0) ok('结束带看收得干净')
else bad('结束带看后舞台还在')
push(`· 服务端对齐：签署之前 ${tBefore}，结束 ${new Date().toISOString()}`)
await browser.close()
