/*
 * 真窗口核验：笔记正文滚动时的「整屏闪一下」（2026-10-09）。
 *
 * 附着 `npm run dev` 起的客户端（CDP 9222），要求窗口里已经打开一篇会闪的笔记。
 * 它不靠肉眼判断闪烁，而是同时采三样互相独立的东西：
 *
 * 1. `Page.startScreencast` 的真实合成帧 —— 一帧内容大面积消失（整屏底色）时
 *    JPEG 会突然变得很小，用「帧字节数远低于中位数」判定闪光帧，并留下那几帧原图。
 * 2. `LayerTree` —— 谁被提升成独立合成层、层的尺寸，判断是不是一个盖住整窗的大层。
 * 3. 正文子树的 MutationObserver + longtask —— 区分「React 又渲染了一遍」和
 *    「主线程被强制布局卡住」和「纯合成侧丢帧」。
 *
 * 然后按条件重复同一趟滚动（遮掉伴星画布 / 去掉背景模糊 / 取消层的 will-change /
 * 藏掉表格），看闪光帧在哪个条件下归零，把根因夹到具体那一层。
 *
 * 用法：node scripts/probe-note-scroll-flicker.mjs
 *   ASTELLA_FLICKER_CONDITIONS=bare,live2d,blur,willchange,table 可选子集
 * 证据落在 outputs/note-scroll-flicker-20261009/。
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/note-scroll-flicker-20261009')
mkdirSync(outDir, { recursive: true })
const notesPath = join(outDir, 'notes.md')
const log = (line) => { console.log(line); appendFileSync(notesPath, `${line}\n`) }
writeFileSync(notesPath, `# 笔记滚动闪烁采集 ${new Date().toISOString()}\n\n`, 'utf8')

const endpoint = process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9222'
const SCROLL_SELECTOR = '.notebook-desk__scroll'
const PAGE_SELECTOR = '.notebook-desk__page'
const WHEEL_STEP = 260
const WHEEL_TICKS = Number(process.env.ASTELLA_FLICKER_TICKS ?? 46)
const CONDITIONS = (process.env.ASTELLA_FLICKER_CONDITIONS ?? 'text-only,with-table,no-blur,no-live2d,no-promotion,table-hidden').split(',').filter(Boolean)

/** 注入受控内容：长文本 +（可选）一张大表格。表格是被点名的嫌疑对象，所以它必须能单独摘掉。 */
const inject = async (rows) => page.evaluate(({ PAGE_SELECTOR, rows }) => {
  const paper = document.querySelector(PAGE_SELECTOR)
  paper.querySelectorAll('[data-flicker-probe]').forEach((node) => node.remove())
  const make = (tag, text) => {
    const node = document.createElement(tag)
    node.setAttribute('data-flicker-probe', 'true')
    node.textContent = text
    return node
  }
  for (let index = 0; index < 24; index += 1) {
    paper.append(make('h2', `小节 ${index + 1} · 滚动位置追踪`))
    paper.append(make('p', '这是一段用来撑高纸面的正文，用来复现滚动时的整屏闪动。'.repeat(6)))
  }
  if (rows > 0) {
    for (let block = 0; block < 3; block += 1) {
      const table = document.createElement('table')
      table.setAttribute('data-flicker-probe', 'true')
      table.style.width = '100%'
      table.style.borderCollapse = 'collapse'
      const head = table.insertRow()
      for (let column = 0; column < 6; column += 1) {
        const cell = head.insertCell()
        cell.textContent = `列 ${column + 1}`
      }
      for (let row = 0; row < rows; row += 1) {
        const line = table.insertRow()
        for (let column = 0; column < 6; column += 1) line.insertCell().textContent = `第 ${row + 1} 行 · 单元格 ${column + 1} · 内容`
      }
      paper.append(make('p', `表格 ${block + 1}`), table)
      for (let index = 0; index < 6; index += 1) paper.append(make('p', '表格之后的正文，滚动经过表格边界时最容易看到整屏重画。'.repeat(4)))
    }
  }
  const scroll = document.querySelector('.notebook-desk__scroll')
  scroll.scrollTop = 0
  return { scrollHeight: scroll.scrollHeight, tables: paper.querySelectorAll('table').length, cells: paper.querySelectorAll('td, th').length }
}, { PAGE_SELECTOR, rows })

const cssRules = {
  'text-only': null,
  'with-table': null,
  'no-blur': '*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
  'no-live2d': '.companion-live2d, .companion-live2d canvas, canvas.companion-live2d__canvas, .companion-presence { display: none !important; }',
  'no-promotion': '*, *::before, *::after { will-change: auto !important; }',
  'table-hidden': '.notebook-desk__page table { visibility: hidden !important; }',
}
const tableRows = { 'text-only': 0, 'with-table': 40, 'no-blur': 40, 'no-live2d': 40, 'no-promotion': 40, 'table-hidden': 40 }

const browser = await chromium.connectOverCDP(endpoint)
const context = browser.contexts()[0]
let page = context.pages().find((candidate) => /index\.html|localhost/.test(candidate.url())) ?? context.pages()[0]

const fail = async (message, code = 1) => { log(`✗ ${message}`); await browser.close(); process.exit(code) }
await page.waitForSelector(SCROLL_SELECTOR, { timeout: 30_000 }).catch(() => fail(`没找到 ${SCROLL_SELECTOR}——窗口要停在笔记正文，先登录并打开那篇会闪的笔记`))

const cdp = await context.newCDPSession(page)
await cdp.send('Page.enable')

const structure = await page.evaluate((selector) => {
  const scroll = document.querySelector(selector)
  const paper = document.querySelector('.notebook-desk__page')
  const tables = paper ? paper.querySelectorAll('table').length : 0
  const cells = paper ? paper.querySelectorAll('td, th').length : 0
  const canvases = [...document.querySelectorAll('canvas')].map((canvas) => {
    const box = canvas.getBoundingClientRect()
    return { cls: canvas.className || canvas.parentElement?.className || '', w: Math.round(box.width), h: Math.round(box.height), fixed: getComputedStyle(canvas).position }
  })
  const scrollBox = scroll.getBoundingClientRect()
  return {
    scroll: { w: Math.round(scrollBox.width), h: Math.round(scrollBox.height), scrollHeight: scroll.scrollHeight },
    scrollOverflow: getComputedStyle(scroll).overflowY,
    tables, cells,
    scrollAncestorsWithPromotion: (() => {
      const hits = []
      for (let node = scroll; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.willChange !== 'auto' || style.transform !== 'none' || style.backdropFilter !== 'none'
          || style.filter !== 'none' || style.contain !== 'none' || style.position === 'fixed') {
          hits.push({ cls: node.className?.toString().slice(0, 60), willChange: style.willChange, transform: style.transform.slice(0, 24), backdrop: style.backdropFilter, contain: style.contain, position: style.position })
        }
      }
      return hits
    })(),
    live2dVisible: Boolean(document.querySelector('canvas.companion-live2d__canvas, .companion-live2d canvas')),
    canvases,
  }
}, SCROLL_SELECTOR)
log(`· 结构：正文框 ${structure.scroll.w}x${structure.scroll.h}（内容高 ${structure.scroll.scrollHeight}），表格 ${structure.tables} 个 / 单元格 ${structure.cells} 个，画布 ${structure.canvases.length} 个`)
if (structure.scrollAncestorsWithPromotion.length) {
  log(`· 滚动容器祖先里被提升/特殊化的层：\n${JSON.stringify(structure.scrollAncestorsWithPromotion, null, 1)}`)
}

// 合成层：谁有多大、为什么独立成层。
await cdp.send('LayerTree.enable')
let layerSnapshot = null
cdp.on('LayerTree.layerTreeDidChange', (event) => { if (event.layers) layerSnapshot = event.layers })
await new Promise((r) => setTimeout(r, 600))
const bigLayers = (layerSnapshot ?? []).filter((layer) => layer.width * layer.height > 800 * 600)
  .map((layer) => ({ id: layer.layerId, w: layer.width, h: layer.height, drawsContent: layer.drawsContent }))
log(`· 合成层总数 ${(layerSnapshot ?? []).length}，其中大于 800x600 的 ${bigLayers.length} 个：${JSON.stringify(bigLayers).slice(0, 400)}`)
const reasons = []
for (const layer of bigLayers.slice(0, 8)) {
  try {
    const answer = await cdp.send('LayerTree.compositingReasons', { layerId: layer.id })
    reasons.push({ layer: `${layer.w}x${layer.h}`, raw: JSON.stringify(answer).slice(0, 220) })
  } catch { /* 层可能已经重建 */ }
}
if (reasons.length) log(`· 提升原因：\n${JSON.stringify(reasons, null, 1)}`)

/** 一趟脚本滚轮 + 真实合成帧采集。 */
async function runCondition(name) {
  const cssId = `flicker-override-${name}`
  const content = await inject(tableRows[name] ?? 40)
  log(`  注入：${name} → 内容高 ${content.scrollHeight}px，表格 ${content.tables} 个 / 单元格 ${content.cells} 个`)
  await page.evaluate(({ cssId, rule }) => {
    document.getElementById(cssId)?.remove()
    if (rule) {
      const style = document.createElement('style')
      style.id = cssId
      style.textContent = rule
      document.head.append(style)
    }
  }, { cssId, rule: cssRules[name] ?? null })

  const sizes = []
  const frames = []
  let pendingAck = null
  const onFrame = (event) => {
    const bytes = Math.round(event.data.length * 0.75)
    sizes.push(bytes)
    frames.push(event)
    pendingAck = event.sessionId
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  }
  cdp.on('Page.screencastFrame', onFrame)
  await page.evaluate(() => {
    window.__probe = { mutations: 0, mutationTargets: [], longTasks: [], frames: [], dropped: 0 }
    const paper = document.querySelector('.notebook-desk__page')
    window.__probeStop?.()
    const observer = new MutationObserver((records) => {
      window.__probe.mutations += records.length
      for (const record of records.slice(0, 6)) {
        const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        window.__probe.mutationTargets.push(`${target?.tagName ?? '?'}.${(target?.className ?? '').toString().slice(0, 40)}:${record.type}`)
      }
    })
    if (paper) observer.observe(paper, { childList: true, subtree: true, attributes: true, characterData: true })
    const longTask = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__probe.longTasks.push(Math.round(entry.duration))
    })
    longTask.observe({ entryTypes: ['longtask'] })
    let last = performance.now()
    let raf = 0
    const tick = (now) => {
      const delta = now - last
      last = now
      if (delta > 0) window.__probe.frames.push(Math.round(delta * 10) / 10)
      if (delta > 34) window.__probe.dropped += 1
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.__probeStop = () => { observer.disconnect(); longTask.disconnect(); cancelAnimationFrame(raf) }
  })

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1600 })
  const box = await page.locator(SCROLL_SELECTOR).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.evaluate(() => { document.querySelector('.notebook-desk__scroll').scrollTop = 0 })
  await page.waitForTimeout(400)
  const started = Date.now()
  for (let index = 0; index < WHEEL_TICKS; index += 1) {
    await page.mouse.wheel(0, WHEEL_STEP)
    await page.waitForTimeout(33)
  }
  const elapsed = Date.now() - started
  await page.waitForTimeout(300)
  await cdp.send('Page.stopScreencast')
  cdp.off('Page.screencastFrame', onFrame)

  const probe = await page.evaluate(() => {
    const result = { ...window.__probe, scrollHeight: document.querySelector('.notebook-desk__scroll').scrollHeight }
    window.__probeStop?.()
    return result
  })
  await page.evaluate((cssId) => { document.getElementById(cssId)?.remove() }, cssId)

  const sorted = [...sizes].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  // 内容大面积消失的帧：字节数掉到中位数的一半以下。
  const flashes = frames.filter((_, index) => sizes[index] < median * 0.5)
  const worst = [...sizes].map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size).slice(0, 3)
  for (const entry of worst.slice(0, 2)) {
    const file = join(outDir, `flash-${name}-${entry.index}.jpg`)
    writeFileSync(file, Buffer.from(frames[entry.index].data, 'base64'))
  }
  const frameStats = (() => {
    const frameDeltas = probe.frames.filter((value) => value > 0)
    const ascending = [...frameDeltas].sort((a, b) => a - b)
    return {
      medianMs: ascending[Math.floor(ascending.length / 2)] ?? 0,
      p95Ms: ascending[Math.floor(ascending.length * 0.95)] ?? 0,
      worstMs: ascending.at(-1) ?? 0,
    }
  })()

  const summary = {
    condition: name,
    screencastFrames: sizes.length,
    medianFrameBytes: median,
    flashFrames: flashes.length,
    flashRatio: sizes.length ? Math.round((flashes.length / sizes.length) * 1000) / 10 : 0,
    smallestFrames: worst.map((entry) => entry.size),
    ...frameStats,
    over34ms: probe.dropped,
    longTasks: probe.longTasks.slice(-8),
    mutations: probe.mutations,
    mutationSample: [...new Set(probe.mutationTargets)].slice(0, 5),
    scrollMs: elapsed,
  }
  log(`· ${name}: 闪光帧 ${summary.flashFrames}/${summary.screencastFrames}（${summary.flashRatio}%）· 帧间隔中位 ${summary.medianMs}ms / p95 ${summary.p95Ms}ms / 最差 ${summary.worstMs}ms · >34ms ${summary.over34ms} 次 · longtask 峰值 ${Math.max(0, ...probe.longTasks)}ms · 正文子树变更 ${summary.mutations} 次`)
  if (summary.mutationSample.length) log(`  变更样本：${summary.mutationSample.join(' | ')}`)
  return summary
}

/**
 * 被动模式：不注入内容、不代操作滚动，只录。用户在自己的窗口里按平时的方式滚
 * 那段会闪的正文，这边同时存真实合成帧、rAF 间隔、正文子树变更与 longtask。
 * 用法：ASTELLA_FLICKER_PASSIVE=1 ASTELLA_FLICKER_SECONDS=25 node scripts/probe-note-scroll-flicker.mjs
 */
async function runPassive() {
  const seconds = Number(process.env.ASTELLA_FLICKER_SECONDS ?? 25)
  const sizes = []
  const frames = []
  const onFrame = (event) => {
    sizes.push(Math.round(event.data.length * 0.75))
    frames.push(event)
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
  }
  await page.evaluate(() => {
    window.__passive = { mutations: 0, mutationTargets: [], longTasks: [], frames: [], over34: 0, scrolls: 0 }
    const paper = document.querySelector('.notebook-desk__page') ?? document.body
    const observer = new MutationObserver((records) => {
      window.__passive.mutations += records.length
      for (const record of records.slice(0, 8)) {
        const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement
        window.__passive.mutationTargets.push(`${target?.tagName ?? '?'}.${(target?.className ?? '').toString().slice(0, 40)}`)
      }
    })
    observer.observe(paper, { childList: true, subtree: true, attributes: true, characterData: true })
    const longTask = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__passive.longTasks.push(Math.round(e.duration)) })
    longTask.observe({ entryTypes: ['longtask'] })
    let last = performance.now()
    let stop = false
    const tick = (now) => {
      const delta = now - last
      last = now
      window.__passive.frames.push(Math.round(delta * 10) / 10)
      if (delta > 34) window.__passive.over34 += 1
      if (!stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const onScroll = () => { window.__passive.scrolls += 1 }
    document.addEventListener('scroll', onScroll, true)
    window.__passiveStop = () => { stop = true; observer.disconnect(); longTask.disconnect(); document.removeEventListener('scroll', onScroll, true) }
  })
  log(`· 被动采集 ${seconds}s：请在窗口里按平时的方式滚动那段会闪的正文`)
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1600 })
  await page.waitForTimeout(seconds * 1000)
  await cdp.send('Page.stopScreencast')
  cdp.off('Page.screencastFrame', onFrame)

  const recorded = await page.evaluate(() => {
    const value = { ...window.__passive, mutationTargets: window.__passive.mutationTargets.slice(0, 400) }
    window.__passiveStop?.()
    return value
  })
  const ascending = [...sizes].sort((a, b) => a - b)
  const median = ascending[Math.floor(ascending.length / 2)] ?? 0
  const flashIndexes = sizes.map((size, index) => ({ size, index })).filter((entry) => entry.size < median * 0.5)
  for (const entry of flashIndexes.slice(0, 6)) {
    writeFileSync(join(outDir, `passive-flash-${entry.index}.jpg`), Buffer.from(frames[entry.index].data, 'base64'))
  }
  const deltas = recorded.frames.filter((value) => value > 0 && value < 500).sort((a, b) => a - b)
  const summary = {
    condition: 'passive',
    frames: sizes.length,
    medianFrameBytes: median,
    flashFrames: flashIndexes.length,
    medianMs: deltas[Math.floor(deltas.length / 2)] ?? 0,
    p95Ms: deltas[Math.floor(deltas.length * 0.95)] ?? 0,
    worstMs: deltas.at(-1) ?? 0,
    over34ms: recorded.over34,
    scrollEvents: recorded.scrolls,
    longTaskPeak: Math.max(0, ...(recorded.longTasks ?? [0])),
    mutations: recorded.mutations,
    mutationSample: [...new Set(recorded.mutationTargets)].slice(0, 6),
    flashSizes: flashIndexes.slice(0, 6).map((entry) => entry.size),
  }
  log(`· 被动: 闪光帧 ${summary.flashFrames}/${summary.frames} · 帧间隔中位 ${summary.medianMs}ms p95 ${summary.p95Ms}ms 最差 ${summary.worstMs}ms · >34ms ${summary.over34ms} · 滚动事件 ${summary.scrollEvents} · longtask 峰值 ${summary.longTaskPeak}ms · 正文变更 ${summary.mutations}`)
  if (summary.flashFrames) log(`  闪光帧原图已存 passive-flash-*.jpg（字节数 ${summary.flashSizes.join(' / ')}，中位 ${median}）`)
  if (summary.mutationSample.length) log(`  变更样本：${summary.mutationSample.join(' | ')}`)
  return summary
}

const results = []
if (process.env.ASTELLA_FLICKER_PASSIVE) results.push(await runPassive())
else for (const condition of CONDITIONS) results.push(await runCondition(condition))
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ structure, reasons, results }, null, 1), 'utf8')
log(`✓ 采集完成，证据在 ${outDir}`)
await browser.close()
