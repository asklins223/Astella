#!/usr/bin/env node
/**
 * 阅读屏与四个派生视图的真机走查（390×844、isMobile、3x）。
 *
 * 跑法：本机 API 在 4000、`npm run dev` 在 5173。
 *   cd apps/mobile-client && node scripts/probe-reader.mjs
 * 证据落 ../../outputs/mobile-client-shell-2026-10-12/。
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(resolve('../../apps/desktop-client/node_modules/playwright'))

const OUT = resolve('../../outputs/mobile-client-shell-2026-10-12')
mkdirSync(OUT, { recursive: true })

const log = []
const errors = []
const browser = await chromium.launch({
  executablePath: `${homedir()}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' })
const page = await context.newPage()
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`http ${response.status()} ${response.url().replace('http://127.0.0.1:5173', '')}`)
})

const shot = async (name) => {
  await page.screenshot({ path: resolve(OUT, `${name}.png`) })
  log.push(`shot:${name}`)
}
const geometry = async (name) => {
  const value = await page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
    }
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reader: rect('.screen.reader'),
      head: rect('.reader-head'),
      segmented: rect('.segmented'),
      line: rect('.segment-line'),
      surface: rect('.reader-surface'),
      paper: rect('.paper-body'),
      tabbar: rect('.tabbar'),
      blocks: document.querySelectorAll('.paper-body .block').length,
      marks: document.querySelectorAll('.mark').length,
    }
  })
  log.push(`geo:${name}=${JSON.stringify(value)}`)
  return value
}

await page.goto('http://127.0.0.1:5173', { waitUntil: 'load' })
await page.waitForTimeout(2300)
if (await page.locator('.screen.auth').count()) {
  await page.fill('input[type=email]', process.env.PROBE_EMAIL ?? 'companion-probe@astella.local')
  await page.fill('input[type=password]', process.env.PROBE_PASSWORD ?? 'probe-c37bpcz4')
  await page.getByRole('button', { name: '进来' }).click()
  await page.waitForTimeout(2500)
}
log.push(`chat=${await page.locator('.screen.chat').count()}`)
log.push(`companion runtime=${await page.evaluate(() => {
  const stage = document.querySelector('.stage')
  const layer = document.querySelector('.model-layer')
  const canvas = layer?.querySelector("canvas")
  return JSON.stringify({ runtime: stage?.dataset.runtime ?? null, flow: stage?.dataset.flow ?? null, layerHidden: layer?.hidden ?? null, canvas: canvas ? { w: canvas.width, h: canvas.height } : null })
})}`)
await shot('19-companion')

// 选段 → 锚点：在正文里横向拖一段，看浮条给不给得出三个动作
const selectBody = async () => {
  const box = await page.locator('.paper-body .block').first().boundingBox()
  if (!box) return false
  const y = box.y + Math.min(18, box.height / 2)
  await page.mouse.move(box.x + 6, y)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.min(box.width - 8, 150), y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  return (await page.locator('.select-bar').count()) > 0
}

// 挑一篇真有内容的：投影里 blocks 为 0 的空白页看不出排版
await page.getByRole('button', { name: /手记/ }).click()
await page.waitForSelector('.note-row, .notes-list .empty, .notes-list .error-note', { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(400)
const rows = await page.locator('.note-row').count()
log.push(`rows=${rows}`)
let opened = -1
for (let index = 0; index < Math.min(rows, 4) && opened < 0; index++) {
  await page.locator('.note-row').nth(index).click()
  try {
    await page.waitForSelector('.paper-body', { timeout: 9000 })
  } catch {
    log.push(`row${index}: 纸面没出来 text=${(await page.locator('.screen.reader').textContent().catch(() => '') || '').slice(0, 90)}`)
    await page.locator('.back').click().catch(() => {})
    await page.waitForTimeout(600)
    continue
  }
  const blocks = await page.locator('.paper-body .block').count()
  log.push(`row${index}: blocks=${blocks}`)
  if (blocks === 0) {
    await page.locator('.back').click()
    await page.waitForTimeout(600)
    continue
  }
  opened = index
}

if (opened >= 0) {
  await page.waitForTimeout(400)
  await shot('20-reader-body')
  await geometry('body')

  // 选段 → 锚点 → 让她解释（这一步以前从没在浏览器里点过）
  const selected = await selectBody()
  log.push(`selection bar=${selected} text=${(await page.locator('.select-bar .quoted').textContent().catch(() => '') || '').slice(0, 30)}`)
  await shot('24-selection')
  if (selected) {
    const disabled = await page.locator('.select-bar button', { hasText: '让她解释' }).isDisabled().catch(() => true)
    log.push(`selection anchor ok=${!disabled}`)
    if (!disabled) {
      await page.locator('.select-bar button', { hasText: '让她解释' }).click()
      await page.waitForTimeout(45000)
      await shot('25-annotation-result')
      log.push(`annotation: marks=${await page.locator('.mark').count()} explain=${(await page.locator('.mark-open .explain').textContent().catch(() => '') || '').slice(0, 40)}`)
    }
  }
  await page.locator('.select-bar .icon-btn').click().catch(() => {})

  for (const label of ['速看', '思维导图', '讲解', '标注']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(650)
    const name = label === '思维导图' ? 'map' : label === '讲解' ? 'explain' : label === '速看' ? 'quick' : 'marks'
    await geometry(name)
    await shot(`21-${name}`)
    const gate = await page.locator('.pad.gate').count()
    if (!gate) continue
    const action = (await page.locator('.pad.gate button').first().textContent())?.trim()
    log.push(`${name}:gate action=${action}`)
    await page.locator('.pad.gate button').first().click()
    await page.waitForTimeout(400)
    await shot(`22-${name}-pending`)
    // 等成品：不固定睡多久，按屏上的真实状态判
    const ready = await page.waitForFunction(() => {
      const surface = document.querySelector('.reader-surface')
      const text = surface?.textContent ?? ''
      if (text.includes('再试一次') || text.includes('没成功')) return 'failed'
      if (document.querySelector('.quick-points') || document.querySelector('.mindmap')?.querySelector('.node') || document.querySelector('.artifact') || document.querySelector('.outline')) return 'ready'
      return false
    }, undefined, { timeout: 210000 }).then((handle) => handle.jsonValue()).catch(() => 'timeout')
    log.push(`${name}:state=${ready}`)
    await shot(`23-${name}-after`)
    // 讲解是"注入后由它自己的脚本画出来"的：多留一会儿再拍一张，免得把还没落位的框当成空的。
    await page.waitForTimeout(4000)
    await shot(`26-${name}-settled`)
    log.push(`${name}:outcome=${(await page.locator('.reader-surface').textContent().catch(() => '') || '').replace(/\s+/g, ' ').slice(0, 110)}`)
  }
}

console.log(JSON.stringify({ log, errors: errors.slice(0, 20) }, null, 1))
await browser.close()
