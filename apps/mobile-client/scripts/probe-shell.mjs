#!/usr/bin/env node
/**
 * 手机端真浏览器走查：开屏 → 登录 → 对话流式 → 笔记四视图。
 *
 * 用 playwright 起一个 iPhone 尺寸的手机上下文（390×844、isMobile、3x），
 * 而不是在桌面窗口里缩一栏——很多结论（底线跟不跟着滑、纸面有没有横向溢出、
 * 她有没有被顶出屏）只在真的手机度量下才看得出来。
 *
 * 跑法（本机 dev 栈的 API 要在 4000 上）：
 *   cd apps/mobile-client && node --experimental-strip-types scripts/probe-shell.mjs
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
process.env.NODE_PATH ??= resolve('../../apps/desktop-client/node_modules')
const { chromium } = require(resolve('../../apps/desktop-client/node_modules/playwright'))

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:5173'
const OUT = resolve('../..', 'outputs/mobile-client-shell-2026-10-12')
const EMAIL = process.env.PROBE_EMAIL ?? 'companion-probe@astella.local'
const PASSWORD = process.env.PROBE_PASSWORD ?? 'probe-c37bpcz4'
mkdirSync(OUT, { recursive: true })

const log = []
const errors = []

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`) })
  log.push(`shot ${name}`)
}

const browser = await chromium.launch({
  executablePath: process.env.PROBE_CHROMIUM ?? `${homedir()}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
})
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
})
const page = await context.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`))

log.push(`goto ${BASE}`)
await page.goto(BASE, { waitUntil: 'load' })
await page.waitForTimeout(260)
await shot(page, '01-splash-mid')
const splashDuring = await page.locator('.splash').count()
await page.waitForTimeout(1800)
const splashAfter = await page.locator('.splash').count()
await shot(page, '02-auth-or-chat')

// 伴星：模型层是脚本建的常驻 canvas；许可闸门不过时这里就没得画
await page.waitForTimeout(3500)
const model = await page.evaluate(() => {
  const canvas = document.querySelector('.model-layer canvas')
  const layer = document.querySelector('.model-layer')
  if (!canvas || !layer) return { canvas: false }
  const rect = canvas.getBoundingClientRect()
  return { canvas: true, width: rect.width, height: rect.height, hidden: layer.hidden, mouth: layer.dataset.mouthLevel ?? null }
})
await shot(page, '03-companion')

const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
log.push(`overflowX=${overflowX} splashDuring=${splashDuring} splashAfter=${splashAfter} model=${JSON.stringify(model)}`)

// 登录
if (await page.locator('.screen.auth').count()) {
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.getByRole('button', { name: '进来' }).click()
  await page.waitForTimeout(2500)
}
const signedIn = await page.locator('.screen.chat').count()
log.push(`signedIn=${signedIn > 0}`)
await shot(page, '04-after-login')

// 对话：发一条，看增量是不是就地长出来的
if (signedIn) {
  await page.fill('#say', '用一句话说清什么是复利')
  await page.press('#say', 'Enter')
  const growth = []
  for (let i = 0; i < 22; i++) {
    await page.waitForTimeout(1500)
    const sample = await page.evaluate(() => {
      const live = document.querySelector('.line.assistant.live .line-text')
      const settled = [...document.querySelectorAll('.line.assistant:not(.live) .line-text')].at(-1)
      return { live: live?.textContent?.length ?? 0, settled: settled?.textContent?.length ?? 0, phase: document.querySelector('.line.assistant.live')?.dataset.phase ?? null }
    })
    growth.push(sample)
    if (!sample.live && sample.settled > 8 && i > 3) break
  }
  log.push(`turn growth=${JSON.stringify(growth.slice(-4))}`)
  await shot(page, '05-conversation')

  // 手记 → 阅读 → 四个面
  await page.getByRole('button', { name: /手记/ }).click()
  await page.waitForTimeout(1500)
  await shot(page, '06-notes-list')
  const rows = await page.locator('.note-row').count()
  log.push(`notes rows=${rows}`)
  if (rows > 0) {
    await page.locator('.note-row').first().click()
    await page.waitForSelector('.paper-body', { timeout: 15000 })
    await shot(page, '07-reader-body')
    const blocks = await page.locator('.paper-body .block').count()
    log.push(`blocks=${blocks}`)

    for (const label of ['速看', '思维导图', '讲解', '标注']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(700)
      await shot(page, `08-surface-${label}`)
      const gate = await page.locator('.pad.gate').count()
      if (gate) {
        const action = await page.locator('.pad.gate button').first().textContent()
        log.push(`${label}: gate, action="${action?.trim()}"`)
        if (label === '速看' && action) {
          await page.locator('.pad.gate button').first().click()
          await page.waitForTimeout(2000)
          await shot(page, '09-quick-pending')
          await page.waitForTimeout(25000)
          await shot(page, '10-quick-result')
          const phase = await page.evaluate(() => document.querySelector('.quick')?.textContent?.slice(0, 80) ?? document.querySelector('.error-note')?.textContent ?? 'none')
          log.push(`quick outcome: ${phase}`)
        }
      } else {
        log.push(`${label}: 已有内容`)
      }
    }
  }
}

// 动效关掉之后应当直接就位，不留过渡
await page.emulateMedia({ reducedMotion: 'reduce' })
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(700)
await shot(page, '11-reduced-motion')
const animations = await page.evaluate(() => document.getAnimations?.().length ?? -1)
log.push(`reducedMotion running animations=${animations}`)

console.log(JSON.stringify({ log, errors: errors.slice(0, 25), outDir: OUT }, null, 1))
await browser.close()
