/**
 * 真窗口核验：新账号直接进伴星带路，出声前先过 AI 同意门（2026-10-07）。
 *
 * 附着 `npm run dev` 起的客户端（CDP 9222），走完整一条路：
 * 注册一个**只用于探测的新账号**（不签同意）→ 看它是否**自动**展开完整带路，
 * 还是又落成一个要人点的通知 → 缺同意时讲解纸页有没有把话说清、有没有可点的入口 →
 * 点「去设置同意」是否真的落到同意卡 → 签署并离开设置后，同一站有没有自动接着播 →
 * 走两站看连贯，并确认这段讲解落到本地录音缓存。
 *
 * 每一步都记 UTC 时刻，便于与 `docker logs astella-dev-api-1` 里的 /voice/tts 对齐：
 * 「缺同意时一段都不该出门」只能靠服务端日志证明，页面上看不出来。
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

/** userData 目录跟着产品名走；这里按当前 Electron 实例实际使用的那个找。 */
const appDataDir = [
  join(homedir(), 'Library', 'Application Support', 'astella-desktop-client'),
  join(homedir(), 'Library', 'Application Support', 'ailearn-desktop-client'),
].find(dir => existsSync(dir)) ?? join(homedir(), 'Library', 'Application Support', 'astella-desktop-client')

const outDir = resolve(import.meta.dirname, '../outputs/companion-guidance-first-run-20261007')
mkdirSync(outDir, { recursive: true })
const notesPath = join(outDir, 'notes.md')
writeFileSync(notesPath, '', 'utf8')
const notes = { push(line) { console.log(line); appendFileSync(notesPath, `${line}\n`, 'utf8') } }
const ok = (m) => notes.push(`✓ ${m}`)
const info = (m) => notes.push(`· ${m}`)
const bad = (m) => notes.push(`✗ ${m}`)
const stamp = (label) => { const at = new Date().toISOString(); notes.push(`· ${label} @ ${at}`); return at }

const probeEmail = process.env.ASTELLA_PROBE_EMAIL ?? `guide-first-${Math.random().toString(36).slice(2, 8)}@astella.local`
const probePassword = process.env.ASTELLA_PROBE_PASSWORD ?? `probe-${Math.random().toString(36).slice(2, 10)}`

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const context = browser.contexts()[0]
const page = context.pages().find(p => !p.url().includes('devtools')) ?? (await context.newPage())
await page.bringToFront()
/** 带路这几处改动是这轮刚落的；先重载一次，确保窗口跑的是新代码而不是 HMR 拼起来的旧模块。 */
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(String(e)))
const shot = async (name) => page.screenshot({ path: join(outDir, `${name}.png`) })
  .catch((e) => info(`截图失败 ${name}：${String(e).slice(0, 80)}`))
const finish = async (code = 0) => {
  writeFileSync(join(outDir, 'console-errors.txt'), consoleErrors.join('\n'), 'utf8')
  await browser.close()
  process.exit(code)
}

// ── 1. 注册一个全新账号（故意先不签 AI 同意）───────────────────────────
if (!(await page.locator('.desktop-access-gate').count())) {
  bad('这个窗口当前不是登出态；为了不碰别人的会话，本次探测中止')
  await finish(1)
}
if (!(await page.getByRole('button', { name: /创建账号/ }).count())) {
  await page.getByRole('button', { name: /还没有账号？注册/ }).click()
  await page.waitForTimeout(400)
}
await page.locator('.desktop-access-gate input[type="email"]').fill(probeEmail)
const fields = page.locator('.desktop-access-gate input[type="password"]')
await fields.nth(0).fill(probePassword)
if (await fields.count() > 1) await fields.nth(1).fill(probePassword)
const tRegister = stamp('提交注册')
await page.getByRole('button', { name: /创建账号/ }).click()

await page.waitForSelector('.hud-rail, .first-space', { timeout: 90_000 })
if (await page.locator('.first-space').count()) {
  info('出现首次选空间那张纸；装饰岛不应该消耗这次初次认识')
  await shot('00-first-space')
  const enter = page.getByRole('button', { name: /进入这个空间/ })
  if (await enter.count() && await enter.isEnabled()) { await enter.click(); await page.waitForTimeout(1500) }
}
ok(`新账号已进入：${probeEmail}（口令 ${probePassword}）`)

// ── 2. 自动进带路？还是又在等一次点击？────────────────────────────────
let autoEntered = true
try {
  await page.waitForSelector('.guidance-stage', { timeout: 20_000 })
} catch {
  autoEntered = false
  bad('20 秒内没有自动展开带路')
}
await page.waitForTimeout(1200)
await shot('01-auto-guidance')

const inviteBubble = await page.locator('.companion-notification-paper, .companion-notifications')
  .filter({ hasText: /欢迎来到书房|带我看看/ }).count()
inviteBubble ? bad(`还是落成了通知气泡（${inviteBubble} 张，文案含「欢迎来到书房 / 带我看看」）`)
  : ok('没有邀请通知气泡：带路自己开始，不再等人点')

const stageView = await page.getAttribute('.guidance-stage', 'data-view')
const chapters = await page.locator('.guidance-stage__journey li').count()
const heading = (await page.locator('#guidance-stage-title').textContent()) ?? ''
autoEntered ? ok(`自动进入完整带路：第一站「${heading.trim()}」，路线共 ${chapters} 站，画面 ${stageView}`)
  : info(`当前舞台状态：${heading.trim() || '无'} / ${chapters} 站 / ${stageView}`)
const journey = await page.locator('.guidance-stage__journey').innerText()
notes.push(`· 路线：${journey.replace(/\s+/g, ' ').trim()}`)

// ── 2b. 先走到第二站：接回来必须站在这一站，而不是第一站 ───────────────
await page.locator('.guidance-stage__next').click()
await page.waitForTimeout(1800)
const station = await page.getAttribute('.guidance-stage', 'data-step')
station === 'notes' ? ok('已走到第二站（找到笔记）') : bad(`第二站没到（实际 ${station}）`)

// ── 3. 没签同意：话说清楚了没有，有没有按得到的入口 ────────────────────
const foot = (await page.locator('.guidance-narration__foot').innerText()).replace(/\s+/g, ' ')
notes.push(`· 讲解页脚：${foot}`)
const explained = /还差一步|签署 AI 使用同意/.test(foot)
explained ? ok('缺同意时不是静默：讲清了还差哪一步') : bad(`缺同意时没有说明（页脚：${foot}）`)
const consentButton = page.getByRole('button', { name: '去设置同意' })
await consentButton.count() ? ok('给了「去设置同意」的入口') : bad('没有可点的同意入口')
const preparing = await page.locator('.guidance-narration').getByText('正在准备讲解…').count()
preparing ? bad('未签署时仍然去打合成（会换一记 403）') : ok('未签署时没有发起合成请求（预读挡住了；服务端日志核对见 tRegister 之后）')
const tBeforeConsent = stamp('签署前观察结束')

// ── 4. 点入口 → 落到同意卡 → 签署 → 离开设置 ──────────────────────────
await consentButton.click()
await page.waitForSelector('.settings-hud', { timeout: 20_000 })
await page.waitForTimeout(1200)
const attention = await page.locator('[data-attention="ai-consent"]').count()
attention ? ok('设置页落到了 AI 同意卡并高亮') : info('没看到 data-attention 高亮（可能该卡已签署或选择器换了）')
await shot('02-consent-card')
const signed = (await page.locator('.settings-hud').innerText()).includes('已签署')
if (!signed) {
  await page.getByRole('button', { name: '签署', exact: true }).click()
  await page.waitForTimeout(2200)
  ok('已签署 AI 使用同意')
} else info('同意已是签署态')

await page.locator('.hud-rail button[data-label="首页"]').click({ force: true })
await page.waitForTimeout(1500)

// ── 5. 同一站自动接着播：真的出声（嘴型通道在 speaking）────────────────
let spoken = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 30_000 })
} catch {
  spoken = false
  bad('签署后没有出现 speaking 状态：这一段仍然没声音')
}
const footAfter = (await page.locator('.guidance-narration__foot').innerText()).replace(/\s+/g, ' ')
notes.push(`· 签署后页脚：${footAfter}`)
spoken ? ok('签署后自动接着播，伴星出声了') : info(`页脚仍写着：${footAfter}`)
await shot('03-speaking-after-consent')

// ── 6. 走两站：连贯，不重复播报，不丢位置 ─────────────────────────────
for (const [step, expectHeading] of [[2, '带着一个问题，展开一页'], [3, '接着，读懂这一句']] ) {
  await page.locator('.guidance-stage__next').click()
  await page.waitForTimeout(2500)
  const title = (await page.locator('#guidance-stage-title').textContent())?.trim() ?? ''
  const chapterText = (await page.locator('.guidance-narration__label span').first().textContent())?.trim() ?? ''
  const speaking = await page.getAttribute('.guidance-narration', 'data-speaking')
  (title.includes(expectHeading) || chapterText.includes('3 /') || chapterText.includes('2 /'))
    ? ok(`第 ${step} 步接续正常：「${title}」· ${chapterText} · speaking=${spoken ? speaking : 'n/a'}`)
    : bad(`第 ${step} 步不对：「${title}」· ${chapterText}`)
  await shot(`04-step-${step}`)
}

// ── 7. 这段讲解有没有落成可复用的本地录音 ──────────────────────────────
const cacheRoot = join(appDataDir, 'companion-guidance-audio')
const clips = existsSync(cacheRoot)
  ? readdirSync(cacheRoot).flatMap(accountDir => readdirSync(join(cacheRoot, accountDir))
    .filter(file => file.endsWith('.mp3')).map(file => `${accountDir.slice(0, 8)}/${file.slice(0, 8)}.mp3`))
  : []
clips.length ? ok(`本地讲解录音 ${clips.length} 段：${clips.join('、')}`) : bad(`没有落到本地录音缓存（查过 ${cacheRoot}）`)

// ── 8. 稍后继续 → 带路交还 ─────────────────────────────────────────────
await page.getByRole('button', { name: '稍后继续' }).click()
await page.waitForTimeout(1200)
(await page.locator('.guidance-stage').count()) === 0 ? ok('「稍后继续」把带路交还了') : bad('稍后继续没能收起带路')
const tEnd = stamp('带路走查结束')
notes.push(`· 服务端日志对齐区间：${tBeforeConsent} → ${tEnd}（签署前 ${tRegister} → ${tBeforeConsent} 内不应出现 purpose=guidance 的 /voice/tts）`)
notes.push(`· 账号：${probeEmail}`)
consoleErrors.length ? info(`控制台报错 ${consoleErrors.length} 条，见 console-errors.txt`) : ok('没有控制台报错')
await finish(0)
