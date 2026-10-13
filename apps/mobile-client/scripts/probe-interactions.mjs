#!/usr/bin/env node
/**
 * 剩下两条交互 + 脑图的真机走查（390×844）。
 *
 * 1) 打断：发一条，等增量真的开始长，按「停下」，看这一轮是不是就地收住。
 * 2) guided 提案：让她改正文，等提案卡出来 → 看改动前后 → 应下 → 看回执，
 *    并回到阅读屏确认正文真的变了（这条同时也在验"人不能改、她能改"）。
 * 3) 脑图：点一个节点出说明卡，点卡上的原文引用跳回正文那一格。
 *
 * 跑法：本机 API 在 4000、`npm run dev` 在 5173。
 *   cd apps/mobile-client && node scripts/probe-interactions.mjs
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 路径按脚本自己的位置算，不按 cwd：从仓库根跑和从本目录跑必须是同一结果。
const appRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { chromium } = require(resolve(appRoot, '../desktop-client/node_modules/playwright'))

const OUT = resolve(appRoot, '../../outputs/mobile-client-shell-2026-10-12')
mkdirSync(OUT, { recursive: true })
const log = []
const errors = []

const browser = await chromium.launch({
  executablePath: `${homedir()}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 160)}`))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`http ${response.status()} ${response.url().replace('http://127.0.0.1:5173', '')}`)
})
const shot = async (name) => {
  await page.screenshot({ path: resolve(OUT, `${name}.png`) })
  log.push(`shot:${name}`)
}

await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' })
await page.waitForTimeout(2300)
if (await page.locator('.screen.auth').count()) {
  await page.fill('input[type=email]', process.env.PROBE_EMAIL ?? 'companion-probe@astella.local')
  await page.fill('input[type=password]', process.env.PROBE_PASSWORD ?? 'probe-c37bpcz4')
  await page.getByRole('button', { name: '进来' }).click()
  await page.waitForTimeout(5000)
}

try {
// ─── 1. 打断 ──────────────────────────────────────────────────────────────
await page.fill('#say', '详细讲讲安史之乱为什么会爆发，分点说，每点都要展开')
await page.press('#say', 'Enter')
await page.waitForSelector('.line.assistant.live', { timeout: 15000 }).catch(() => {})
const grew = await page
  .waitForFunction(() => (document.querySelector('.line.assistant.live .line-text')?.textContent ?? '').length > 12, undefined, { timeout: 200000 })
  .then(() => true)
  .catch(() => false)
const beforeStop = await page.evaluate(() => document.querySelector('.line.assistant.live .line-text')?.textContent?.length ?? 0)
log.push(`interrupt: streaming started=${grew} chars=${beforeStop}`)
await shot('40-streaming')
await page.getByRole('button', { name: '停下' }).click().catch(() => log.push('interrupt: 没找到停下按钮'))
await page.waitForTimeout(2500)
const afterStop = await page.evaluate(() => ({
  live: !!document.querySelector('.line.assistant.live'),
  chars: document.querySelector('.line.assistant.live .line-text')?.textContent?.length ?? 0,
  settled: [...document.querySelectorAll('.line.assistant:not(.live) .line-text')].at(-1)?.textContent?.length ?? 0,
  state: document.querySelector('.identity-state')?.textContent ?? null,
}))
log.push(`interrupt: after=${JSON.stringify(afterStop)}`)
await shot('41-after-stop')

// ─── 2. guided 提案：让她改正文 ───────────────────────────────────────────
await page.fill('#say', '在手记里找一篇正文只有一句话的笔记，在那句后面补一句说明它为什么这么短。改之前先给我看。')
await page.press('#say', 'Enter')
const card = await page
  .waitForSelector('.proposal', { timeout: 300000 })
  .then(() => true)
  .catch(() => false)
log.push(`proposal: card=${card}`)
if (card) {
  await shot('42-proposal')
  log.push(`proposal: title=${(await page.locator('.proposal h3').first().textContent())?.trim()} pending=${await page.locator('.proposal[data-status=pending]').count()}`)
  await page.locator('.proposal .review').first().click()
  await page.waitForTimeout(2500)
  const diff = await page.evaluate(() => ({
    sides: document.querySelectorAll('.proposal .diff-side').length,
    after: document.querySelector('.proposal .diff-side.is-after pre')?.textContent?.slice(0, 60) ?? null,
  }))
  log.push(`proposal diff: ${JSON.stringify(diff)}`)
  await shot('43-proposal-diff')
  const confirm = page.locator('.proposal .btn-primary').first()
  log.push(`proposal: confirm disabled=${await confirm.isDisabled()}`)
  await confirm.click().catch(() => {})
  await page.waitForTimeout(6000)
  log.push(`proposal: status=${await page.locator('.proposal').first().getAttribute('data-status')} stamp=${(await page.locator('.proposal .stamp').first().textContent().catch(() => ''))?.trim()}`)
  await shot('44-proposal-decided')
}

// ─── 3. 脑图 ──────────────────────────────────────────────────────────────
await page.getByRole('button', { name: /手记/ }).click()
await page.waitForSelector('.note-row', { timeout: 20000 }).catch(() => {})
const rows = await page.locator('.note-row').count()
let mapNote = -1
for (let index = 0; index < Math.min(rows, 6); index++) {
  await page.locator('.note-row').nth(index).click()
  await page.waitForSelector('.paper-body', { timeout: 12000 }).catch(() => {})
  const blocks = await page.locator('.paper-body .block').count()
  if (blocks < 3) {
    await page.locator('.back').click()
    await page.waitForTimeout(500)
    continue
  }
  await page.getByRole('button', { name: '思维导图', exact: true }).click()
  await page.waitForTimeout(1200)
  if (await page.locator('.pad.gate').count()) {
    await page.locator('.pad.gate button').first().click()
    const ready = await page
      .waitForSelector('.mindmap .node', { timeout: 200000 })
      .then(() => true)
      .catch(() => false)
    log.push(`mindmap: generated ready=${ready}`)
  }
  const nodes = await page.locator('.mindmap .node').count()
  log.push(`mindmap: row${index} blocks=${blocks} nodes=${nodes}`)
  if (nodes > 1) {
    mapNote = index
    break
  }
  await page.locator('.back').click()
  await page.waitForTimeout(500)
}

if (mapNote >= 0) {
  await shot('45-mindmap')
  const geo = await page.evaluate(() => {
    const box = (s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    return { canvas: box('.mindmap-canvas'), firstNode: box('.mindmap .node'), links: document.querySelectorAll('.mindmap .link').length, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  })
  log.push(`mindmap geo: ${JSON.stringify(geo)}`)
  // 点一个非主题的节点，看说明卡
  await page.locator('.mindmap .node').nth(1).click({ force: true })
  await page.waitForTimeout(900)
  const cardInfo = await page.evaluate(() => ({
    label: document.querySelector('.node-card h3')?.textContent ?? null,
    quotes: document.querySelectorAll('.node-card .quote').length,
    focused: document.querySelectorAll('.mindmap .node[data-focused="1"]').length,
  }))
  log.push(`mindmap card: ${JSON.stringify(cardInfo)}`)
  await shot('46-mindmap-node')
  if (cardInfo.quotes > 0) {
    await page.locator('.node-card .quote').first().click()
    await page.waitForTimeout(900)
    const jumped = await page.evaluate(() => ({
      surface: document.querySelector('.segmented .on')?.textContent ?? null,
      flash: !!document.querySelector('.block.flash'),
      ordinal: document.querySelector('.block.flash')?.dataset.ordinal ?? null,
    }))
    log.push(`mindmap jump: ${JSON.stringify(jumped)}`)
    await shot('47-mindmap-jump')
  }
}

} catch (error) {
  log.push(`fatal: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  await shot('49-fatal')
  log.push(`fatal dom=${await page.evaluate(() => JSON.stringify({ screens: [...document.querySelectorAll('.screen')].map((n) => n.className), buttons: document.querySelectorAll('button').length, body: document.body.textContent?.slice(0, 120) }))}`)
}
console.log(JSON.stringify({ log, errors: errors.slice(0, 16) }, null, 1))
await browser.close()
