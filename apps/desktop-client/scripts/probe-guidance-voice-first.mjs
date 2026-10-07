/**
 * 真窗口：带路第一站就是「先让伴星能出声」，没开不放行，开完回来还站在这一站。
 *
 * 2026-10-07 用户新口径：第一步就让用户去设置里开启，开了才进入下一步的预览，
 * 不开就不往下走。这条同时把上一轮追不动的"签署后接回同一站"变成了不需要接回——
 * 因为压根没离开第一站。
 */
import { chromium } from 'playwright'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/companion-guidance-voice-first-20261007')
mkdirSync(outDir, { recursive: true })
const logPath = join(outDir, 'notes.md')
writeFileSync(logPath, '', 'utf8')
const push = (l) => { console.log(l); appendFileSync(logPath, `${l}\n`, 'utf8') }
const ok = (m) => push(`✓ ${m}`), info = (m) => push(`· ${m}`), bad = (m) => push(`✗ ${m}`)

const email = `voice-first-${Math.random().toString(36).slice(2, 7)}@astella.local`
const password = `probe-${Math.random().toString(36).slice(2, 10)}`
const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => !p.url().includes('devtools'))
await page.bringToFront()
page.on('console', (m) => { if (m.type() === 'error' || m.text().startsWith('[companion-guide]')) push(`· 控制台 ${m.text().slice(0, 160)}`) })
const shot = async (n) => page.screenshot({ path: join(outDir, `${n}.png`) }).catch(() => info(`截图失败 ${n}`))
const step = () => page.getAttribute('.guidance-stage', 'data-step')

if (!(await page.locator('.desktop-access-gate').count())) {
  bad('窗口不是登出态，先由你退出登录再跑')
  await browser.close(); process.exit(1)
}
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
if (!(await page.getByRole('button', { name: /创建账号/ }).count())) {
  // 上一轮删账号把会话留在了"再输一次密码"那张纸上，先退回登录页。
  const back = page.getByRole('button', { name: /退出并重新登录/ })
  if (await back.count()) { await back.click(); await page.waitForTimeout(1500) }
  if (!(await page.getByRole('button', { name: /创建账号/ }).count())) {
    await page.getByRole('button', { name: /还没有账号？注册/ }).click(); await page.waitForTimeout(400)
  }
}
await page.locator('.desktop-access-gate input[type="email"]').fill(email)
const fields = page.locator('.desktop-access-gate input[type="password"]')
await fields.nth(0).fill(password)
if (await fields.count() > 1) await fields.nth(1).fill(password)
info(`注册 @ ${new Date().toISOString()} 账号 ${email}`)
await page.getByRole('button', { name: /创建账号/ }).click()

try {
  await page.waitForSelector('.guidance-stage[data-step="voice"]', { timeout: 25_000 })
  ok('新账号第一站就是「先让伴星能出声」，不是先讲书房')
} catch {
  bad(`没停在 voice（当前 ${await step()}）`)
}
await page.waitForTimeout(1500)
await shot('01-voice-station')
const title = (await page.locator('#guidance-stage-title').textContent())?.trim()
info(`标题：${title}｜路线：${(await page.locator('.guidance-stage__journey').innerText()).replace(/\s+/g, ' ')}`)

const nextButton = page.locator('.guidance-stage__next')
const blocked = await nextButton.isDisabled()
blocked ? ok('没开声音时「接着」按不动') : bad('没开声音时居然能直接往下走')
const cue = (await page.locator('.guidance-stage__next-cue small').textContent())?.trim()
cue?.includes('开了声音') ? ok(`下一站那行写的是"${cue}"`) : info(`下一站那行："${cue}"`)
const pointer = page.getByRole('button', { name: /去设置开启/ })
if (await pointer.count()) { ok('指路那颗就是「去设置开启」') } else { info('这一屏没解析出锚点，指路那颗没画（不影响放行判定）') }

const tBefore = new Date().toISOString()
await (await pointer.count() ? pointer : page.getByRole('button', { name: '去设置同意' })).click()
await page.waitForSelector('.settings-hud', { timeout: 20_000 })
await page.waitForTimeout(1500)
if (await page.locator('[data-attention="ai-consent"]').count()) ok('落到 AI 同意卡并高亮')
else bad('没落到同意卡')
await shot('02-consent-card')
await page.getByRole('button', { name: '签署', exact: true }).click()
await page.waitForTimeout(2500)
ok('已签署')

await page.keyboard.press('Escape')
await page.waitForTimeout(2000)
const back = await step()
back === 'voice' ? ok('回到书房：还站在第一站（不需要"接回"，它本来就该在这）')
  : back ? bad(`回来站不对：${back}`) : bad('回来之后带路整个不见了')
let spoke = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 35_000 })
} catch { spoke = false }
const foot = (await page.locator('.guidance-narration__foot').innerText().catch(() => ''))?.replace(/\s+/g, ' ')
spoke ? ok('这一站的讲解出声了') : bad(`没出声，页脚="${foot}"`)
await shot('03-voice-speaking')

const blockedNow = await nextButton.isDisabled().catch(() => null)
blockedNow === false ? ok('开了声音后「接着」放行') : bad(`放行判定没翻过来（disabled=${blockedNow}）`)
await nextButton.click()
await page.waitForTimeout(2500)
const second = await step()
second === 'room' ? ok('进入下一步预览：第二站「认识书房」') : bad(`第二站不对：${second}`)
let spoke2 = true
try {
  await page.waitForFunction(() => document.querySelector('.guidance-narration')?.dataset.speaking === 'true', undefined, { timeout: 30_000 })
} catch { spoke2 = false }
const foot2 = (await page.locator('.guidance-narration__foot').innerText().catch(() => '')).replace(/\s+/g, ' ')
if (spoke2) ok('第二站出声了：说明回到书房那一下缺的只是一次新的用户手势')
else bad(`第二站也没出声，页脚="${foot2}"`)
await shot('04-second-station')
push(`· 服务端对齐：签署前 ${tBefore}，结束 ${new Date().toISOString()}`)
push(`· 账号：${email} / ${password}`)
await browser.close()
