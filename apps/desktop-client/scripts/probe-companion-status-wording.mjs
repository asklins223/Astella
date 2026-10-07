/**
 * 真窗口核验：等待 ≠ 思考（2026-10-07）。
 *
 * 闲聊轮整程只该看到「在听…」，提问轮才出现「她在想…」。
 * 状态是一闪而过的，所以这里按 200ms 采样气泡/抽屉上的过程文案，把这一轮里
 * **出现过**的句子都记下来——判据是"有没有出现过 在想/思考"，不是某一帧。
 */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-thinking-20261007')
const probeEmail = process.env.ASTELLA_PROBE_EMAIL ?? 'companion-probe@astella.local'
const probePassword = process.env.ASTELLA_PROBE_PASSWORD ?? ''
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]

if (await page.locator('.desktop-access-gate').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill(probeEmail)
  await page.locator('.desktop-access-gate input[type="password"]').first().fill(probePassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
}
await page.waitForTimeout(2500)

const sample = () => page.evaluate(() => {
  // 整块抓：气泡、抽屉的时间线尾部、头顶轨道，任一处的过程文案都算。
  const bits = [
    document.querySelector('.companion-hud')?.textContent ?? '',
    document.querySelector('.companion-history')?.textContent?.slice(-160) ?? '',
  ]
  return bits.join(' ').replace(/\s+/g, ' ').trim().slice(-120)
})

const runTurn = async (text) => {
  await page.getByRole('button', { name: '气泡轻聊' }).click({ force: true }).catch(() => {})
  await page.waitForSelector('textarea[aria-label^="给"]', { timeout: 20_000 })
  const before = await page.evaluate(() => document.body.innerText.length)
  const seen = new Set()
  const started = Date.now()
  await page.locator('textarea[aria-label^="给"]').fill(text)
  await page.keyboard.press('Enter')
  let firstTextAt = null
  for (let i = 0; i < 400; i += 1) {
    const snapshot = await sample()
    if (snapshot) seen.add(snapshot)
    if (firstTextAt === null && await page.evaluate((size) => document.body.innerText.length > size + 8, before)) {
      firstTextAt = Date.now() - started
    }
    if (firstTextAt !== null && i > 12) break
    await page.waitForTimeout(200)
  }
  return { states: [...seen], firstTextAt }
}

const casual = await runTurn('在忙啥呢')
log(`闲聊轮 · 首字 ${casual.firstTextAt}ms`)
for (const state of casual.states) log(`   · 「${state}」`)
const casualClaimsThinking = casual.states.some((s) => /在想|思考/.test(s))
log(casualClaimsThinking ? '✗ 闲聊轮里出现了"在想/思考"字样' : '✓ 闲聊轮没有任何"在想"的宣称')

const question = await runTurn('讲讲什么是熵，给个生活里的例子')
log(`提问轮 · 首字 ${question.firstTextAt}ms`)
for (const state of question.states) log(`   · 「${state}」`)
log(question.states.some((s) => /她在想/.test(s))
  ? '✓ 提问轮出现了「她在想…」（真开了思考档）'
  : '✗ 提问轮没看到「她在想…」')

await page.screenshot({ path: join(outDir, 'status-wording.png') })
await writeFile(join(outDir, 'status-notes.md'), notes.join('\n'), 'utf8')
await browser.close()
