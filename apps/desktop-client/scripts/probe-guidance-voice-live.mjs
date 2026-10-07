/**
 * 真窗口：伴星带路到底有没有声音，以及这段讲解有没有落成可复用的本地录音。
 *
 * 用窗口里当前登着的账号（已签 AI 同意），从右上角岛里开「跟我完整走一遍」：
 * 看讲解是否真的进入 speaking（嘴型通道在播）、走两站是否连贯，
 * 再核对 `<userData>/companion-guidance-audio` 里有没有落下这段 MP3。
 */
import { chromium } from 'playwright'
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-guidance-first-run-20261007')
mkdirSync(outDir, { recursive: true })
const logPath = join(outDir, 'voice-live.md')
writeFileSync(logPath, '', 'utf8')
const push = (line) => { console.log(line); appendFileSync(logPath, `${line}\n`, 'utf8') }
const ok = (m) => push(`✓ ${m}`), info = (m) => push(`· ${m}`), bad = (m) => push(`✗ ${m}`)

const cacheRoot = join(homedir(), 'Library', 'Application Support', 'astella-desktop-client', 'companion-guidance-audio')
const clips = () => existsSync(cacheRoot)
  ? readdirSync(cacheRoot).flatMap(dir => readdirSync(join(cacheRoot, dir)).filter(f => f.endsWith('.mp3'))
    .map(f => ({ file: `${dir.slice(0, 8)}/${f.slice(0, 12)}.mp3`, bytes: statSync(join(cacheRoot, dir, f)).size, at: statSync(join(cacheRoot, dir, f)).mtime.toISOString() })))
  : []
const clipsBefore = clips()
info(`开跑前本地讲解录音 ${clipsBefore.length} 段`)

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => !p.url().includes('devtools'))
await page.bringToFront()
const shot = async (name) => page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => info(`截图失败 ${name}`))
const dom = () => page.evaluate(() => ({
  step: document.querySelector('.guidance-stage')?.dataset.step ?? null,
  speaking: document.querySelector('.guidance-narration')?.dataset.speaking ?? null,
  foot: (document.querySelector('.guidance-narration__foot')?.innerText ?? '').replace(/\s+/g, ' '),
  chapter: (document.querySelector('.guidance-narration__label span')?.textContent ?? '').trim(),
}))

const account = await page.locator('.room-control-account').getAttribute('aria-label').catch(() => null)
info(`账号：${account ?? '（读不到）'}`)

// ── 从岛里开完整带路 ───────────────────────────────────────────────────
await page.locator('.room-control-trigger').click({ force: true })
await page.waitForTimeout(700)
await page.locator('.room-control-guide').click({ force: true })
await page.waitForTimeout(900)
await page.getByRole('button', { name: /跟我完整走一遍/ }).click()
await page.waitForSelector('.guidance-stage', { timeout: 20_000 })
await page.waitForTimeout(1200)
let now = await dom()
info(`带路已开：站=${now.step} ${now.chapter} 页脚="${now.foot}"`)
await shot('20-guide-open')

// ── 出声：preparing → speaking ─────────────────────────────────────────
const sawPreparing = /正在准备讲解/.test(now.foot)
sawPreparing ? info('先进入「正在准备讲解…」') : info(`开场页脚没写准备中："${now.foot}"`)
let spoke = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 35_000 })
} catch { spoke = false }
now = await dom()
spoke ? ok(`第一段真的出声了（${now.chapter}，页脚="${now.foot}"）`)
  : bad(`35 秒内没有进入 speaking：页脚="${now.foot}"`)
await shot('21-speaking')

// ── 走两站：每段都该跟着念 ─────────────────────────────────────────────
for (const expect of ['notes', 'reading']) {
  await page.locator('.guidance-stage__next').click()
  await page.waitForTimeout(1200)
  let each = true
  try {
    await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 30_000 })
  } catch { each = false }
  const after = await dom();
  if (after.step === expect && each) ok(`接到「${expect}」站并出声（${after.chapter}）`)
  else bad(`「${expect}」站不对或没声：实际=${after.step} speaking=${after.speaking} 页脚="${after.foot}"`)
  await shot(`22-step-${expect}`)
}

// ── 本地录音缓存 ───────────────────────────────────────────────────────
const clipsAfter = clips()
const added = clipsAfter.filter(c => !clipsBefore.some(b => b.file === c.file))
added.length ? ok(`新落本地录音 ${added.length} 段：${added.map(c => `${c.file} ${c.bytes}B`).join('、')}`)
  : clipsAfter.length ? info(`录音总数 ${clipsAfter.length} 段，本轮没有新增（可能命中了已有缓存：${clipsAfter.map(c => `${c.file} ${c.bytes}B`).join('、')}）`)
    : bad(`一段录音都没有（查过 ${cacheRoot}）`)
await page.getByRole('button', { name: '结束带看' }).click()
await page.waitForTimeout(800)
  if ((await page.locator(".guidance-stage").count()) === 0) ok("结束带看收得干净"); else bad("结束带看后舞台还在")
await browser.close()
