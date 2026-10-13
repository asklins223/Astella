#!/usr/bin/env node
/**
 * 按 prototype 基线的逐屏走查：真手机度量（390×844、isMobile、3x）下逐屏截图，
 * 并**量计算样式与盒子**（不是看类名在不在）。
 *
 * 跑法（本机 dev 栈的 API 要在 4000 上）：
 *   cd apps/mobile-client && node scripts/probe-baseline.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require(resolve('../../apps/desktop-client/node_modules/playwright'))

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:5173'
const OUT = resolve('../..', 'outputs/mobile-client-shell-2026-10-12')
const EMAIL = process.env.PROBE_EMAIL ?? 'companion-probe@astella.local'
const PASSWORD = process.env.PROBE_PASSWORD ?? 'probe-c37bpcz4'
mkdirSync(OUT, { recursive: true })

const log = []
const errors = []
const say = (line) => { log.push(line); console.log(line) }

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT, `${name}.png`) })
  say(`shot ${name}`)
}

/** 量一处盒子的计算样式；元素不存在就回 null，让断言自己说"没找到"。 */
function box(selector, extra = '[]') {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { box: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
      radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 46), bg: cs.backgroundColor.slice(0, 30),
      font: cs.fontSize, weight: cs.fontWeight, family: cs.fontFamily.split(',')[0],
      found: [...document.querySelectorAll(${JSON.stringify(selector)}).values()].map(e => e.textContent.trim().slice(0, 18)),
      extra: (() => { try { return ${extra} } catch (e) { return String(e) } })() }
  })()`
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
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) })
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`))

await page.goto(BASE, { waitUntil: 'load' })
await page.waitForTimeout(300)
await shot(page, 'b01-splash')
await page.waitForTimeout(1700)

// ── 登录屏（未登录时）
const isAuth = await page.locator('.auth-page').count()
if (isAuth) {
  say(JSON.stringify({
    loginCard: await page.evaluate(box('.login-card')),
    portrait: await page.evaluate(box('.login-scene .portrait')),
    primary: await page.evaluate(box('.login-card .primary')),
    field: await page.evaluate(box('.login-card .field-input')),
  }))
  await shot(page, 'b02-login')
  await page.fill('.login-card input[type=email]', EMAIL)
  await page.fill('.login-card input[type=password]', PASSWORD)
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForTimeout(2600)
}
await shot(page, 'b03-after-login')

// ── 伴星那一屏
await page.waitForTimeout(3200)
const scene = await page.evaluate(() => {
  const seat = document.querySelector('.live2d-seat')
  const layer = document.querySelector('.scene-model-layer')
  const canvas = document.querySelector('.scene-model-layer canvas')
  const bubble = document.querySelector('.scene-speech')
  const rect = (el) => (el ? [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top)] : null)
  return {
    screen: document.querySelector('.phone')?.dataset.screen,
    dialogue: document.querySelector('.phone')?.dataset.dialogue,
    flow: document.querySelector('.phone')?.dataset.flow,
    live2d: document.querySelector('.phone')?.dataset.live2d,
    seat: rect(seat),
    layer: rect(layer),
    canvasHidden: layer?.hidden ?? null,
    canvasSize: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
    bubble: rect(bubble),
    modes: [...document.querySelectorAll('.dialogue-modes button')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})
say(`scene ${JSON.stringify(scene)}`)
await shot(page, 'b04-chat-scene')

// ── 记录那一屏：发一条，看增量
await page.locator('.dialogue-modes button', { hasText: '记录' }).click()
await page.waitForTimeout(700)
await shot(page, 'b05-chat-history')
await page.fill('#chat-input', '用一句话说清什么是复利，再说一个容易搞错的地方')
await page.getByRole('button', { name: '发送消息' }).click()
const growth = []
for (let i = 0; i < 26; i += 1) {
  await page.waitForTimeout(1500)
  const sample = await page.evaluate(() => {
    const live = document.querySelector('.message[data-phase] .assistant-text')
    const done = [...document.querySelectorAll('.message')].filter((m) => !m.dataset.phase).at(-1)
    return {
      live: live?.textContent?.length ?? 0,
      done: done?.textContent?.length ?? 0,
      phase: document.querySelector('.message[data-phase]')?.dataset.phase ?? null,
      status: document.querySelector('.status-inline')?.textContent?.slice(0, 24) ?? null,
    }
  })
  growth.push(sample)
  if (!sample.live && sample.done > 40 && i > 3) break
}
say(`growth ${JSON.stringify(growth.slice(-3))}`)
await shot(page, 'b06-reply')

// 打断：再发一条长一点的，中途按停下
await page.fill('#chat-input', '把刚才那一句再展开讲三行')
await page.getByRole('button', { name: '发送消息' }).click()
await page.waitForTimeout(1400)
const stop = page.getByRole('button', { name: '让她停下' })
const hadStop = await stop.count()
if (hadStop && await stop.isEnabled()) {
  await stop.click()
  await page.waitForTimeout(1800)
}
say(`interrupt button present=${hadStop > 0}`)
await shot(page, 'b07-interrupt')

// ── 手记
await page.locator('.tabbar button', { hasText: '手记' }).click()
await page.waitForTimeout(1600)
say(JSON.stringify({
  section: await page.evaluate(box('.section-title h1')),
  row: await page.evaluate(box('.note-row')),
  cover: await page.evaluate(box('.book-cover')),
  search: await page.evaluate(box('.search')),
  indicator: await page.evaluate(box('.tab-indicator')),
  count: await page.locator('.note-row').count(),
}))
await shot(page, 'b08-notes')

const rows = await page.locator('.note-row').count()
if (rows > 0) {
  // 挑一篇有正文的（空笔记没有速看要点、也没有可选中的段落）
  const target = page.locator('.note-row', { hasNotText: '无标题' }).first()
  await ((await target.count()) ? target : page.locator('.note-row').first()).click()
  await page.waitForTimeout(2600)
  say(JSON.stringify({
    paper: await page.evaluate(box('.paper')),
    meta: await page.evaluate(box('.paper-meta')),
    h1: await page.evaluate(box('.paper h1')),
    strip: await page.evaluate(box('.version-strip')),
    block: await page.evaluate(box('.note-block')),
    identity: await page.evaluate(box('.topbar .identity-copy')),
    portrait: await page.evaluate(box('.topbar .portrait')),
    dock: await page.evaluate(box('.detail-dock')),
    screen: await page.evaluate(() => document.querySelector('.phone')?.dataset.screen),
    detail: await page.evaluate(() => document.querySelector('.phone')?.dataset.detail),
  }))
  await shot(page, 'b09-reader')

  // 速看
  const quick = page.getByRole('button', { name: /让她速看|看要点|再试一次/ })
  if (await quick.count()) {
    await quick.first().click()
    for (let i = 0; i < 16; i += 1) {
      await page.waitForTimeout(1600)
      if (await page.locator('.quick-read').count()) break
    }
    const prompt = await page.locator('.quick-read .review-prompt').count()
    const state = await page.locator('.quick-read .state-note, .quick-read .review-prompt, .quick-read .quick-body').first().textContent().catch(() => null)
    say(`quick points=${prompt} state=${JSON.stringify(String(state ?? '').slice(0, 46))}`)
    await shot(page, 'b10-quick')
    const jump = page.locator('.quick-read .text-action').first()
    if (await jump.count()) {
      await jump.click()
      await page.waitForTimeout(900)
      say(`selected blocks=${await page.locator('.note-block.selected').count()}`)
      await shot(page, 'b11-quick-jump')
    }
  }

  // 选一句 → 让她解释
  const block = page.locator('.note-block p').first()
  await block.click({ clickCount: 1 })
  await page.evaluate(() => {
    const p = document.querySelector('.note-block p')
    const range = document.createRange()
    range.selectNodeContents(p)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.locator('.note-block .block-tool').first().click()
  await page.waitForTimeout(700)
  say(JSON.stringify({ sheet: await page.evaluate(box('.sheet')), reference: await page.evaluate(box('.ask-reference')) }))
  await shot(page, 'b12-selection-sheet')
  const explain = page.getByRole('button', { name: '让她解释这一句' })
  if (await explain.count()) {
    await explain.click()
    for (let i = 0; i < 14; i += 1) {
      await page.waitForTimeout(1600)
      if (await page.locator('.sheet').count() === 0) break
    }
    say(`marks after explain=${await page.locator('.mark').count()} sheet=${await page.locator('.sheet').count()}`)
    await shot(page, 'b13-after-explain')
  } else {
    await page.keyboard.press('Escape')
  }

  // 脑图
  await page.getByRole('button', { name: '思维导图' }).click()
  await page.waitForTimeout(1500)
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(2000)
    if (await page.locator('.mindmap .node').count()) break
  }
  const nodes = await page.locator('.mindmap .node').count()
  say(`map nodes=${nodes}`)
  await shot(page, 'b14-mindmap')
  if (nodes) {
    await page.locator('.mindmap .node').nth(Math.min(2, nodes - 1)).click()
    await page.waitForTimeout(900)
    say(JSON.stringify({ nodeSheet: await page.evaluate(box('.sheet')) }))
    await shot(page, 'b15-node-card')
    const ref = page.locator('.sheet .sheet-row').first()
    if (await ref.count()) {
      await ref.click()
      await page.waitForTimeout(1200)
      say(`after jump screen=${await page.evaluate(() => document.querySelector('.phone')?.dataset.screen)} selected=${await page.locator('.note-block.selected').count()}`)
      await shot(page, 'b16-jump-back')
    } else {
      await page.keyboard.press('Escape')
    }
  }

  // 讲解
  await page.getByRole('button', { name: '讲一段' }).first().click()
  await page.waitForTimeout(1500)
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(3000)
    if (await page.locator('.artifact').count()) break
  }
  const frame = await page.locator('.artifact').count()
  say(`artifact frame=${frame} task=${await page.locator('.task-card').count()} note=${await page.locator('.paper .state-note').first().textContent().catch(() => null)}`)
  await shot(page, 'b17-explain')

  // 详情屏里没有 tab 栏（demo 也是这样）：一层一层退回 tab 屏
  for (let i = 0; i < 4; i += 1) {
    const detail = await page.evaluate(() => document.querySelector('.phone')?.dataset.detail === 'true')
    if (!detail) break
    const back = page.locator('.topbar .top-left, .utility-header .top-left').first()
    if ((await back.count()) === 0) {
      say(`back missing at detail screen=${await page.evaluate(() => document.querySelector('.phone')?.dataset.screen ?? 'none')} root=${await page.evaluate(() => document.getElementById('root')?.children.length)}`)
      break
    }
    await back.click({ timeout: 5000 }).catch((cause) => say(`back click failed: ${String(cause).slice(0, 90)}`))
    await page.waitForTimeout(700)
  }
}

// ── 我的 + 设置
await page.locator('.tabbar button', { hasText: '我的' }).click()
await page.waitForTimeout(1600)
say(JSON.stringify({
  profileCard: await page.evaluate(box('.profile-card')),
  accountLink: await page.evaluate(box('.account-link')),
  sheetRow: await page.evaluate(box('.account-options .sheet-row')),
  utilityHeader: await page.evaluate(box('.topbar .icon-button')),
}))
await shot(page, 'b18-profile')
await page.getByRole('button', { name: '使用设置' }).click()
await page.waitForTimeout(900)
say(JSON.stringify({ settingField: await page.evaluate(box('.setting-field')), sample: await page.evaluate(box('.reading-sample')), dock: await page.locator('.detail-dock').count(), utilityHeader: await page.evaluate(box('.utility-header-title')) }))
await shot(page, 'b19-settings')
await page.locator('.setting-field select').first().selectOption('1.25')
await page.waitForTimeout(700)
say(`textScale=${await page.evaluate(() => getComputedStyle(document.querySelector('.phone')).getPropertyValue('--text-scale'))} h1=${await page.evaluate(() => getComputedStyle(document.querySelector('.utility-page h1')).fontSize)}`)
await shot(page, 'b20-settings-scale')
await page.locator('.utility-header .top-left').click()
await page.waitForTimeout(700)

const final = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
say(`overflowX=${final}`)
say(`errors=${JSON.stringify(errors.slice(0, 12))}`)

writeFileSync(resolve(OUT, 'baseline-log.txt'), `${log.join('\n')}\n\nERRORS:\n${errors.join('\n')}\n`)
await browser.close()
