/**
 * 启发式体验走查（2026-10-11）：交互态探测——编辑保存反馈、搜索输入、轻聊开合。
 * 附着 9223 隔离窗口。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]
const settle = (ms = 1200) => page.waitForTimeout(ms)
const shot = (file) => page.screenshot({ path: `${outDir}/${file}` })

await page.waitForSelector('.hud-rail', { timeout: 60_000 })

// ---- 1. 笔记列表 → 打开一篇 → 编辑态保存反馈 ----
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.hud-rail button'))
    .find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))
  btn?.click()
})
await settle(1500)
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label') ?? '').includes('打开笔记'))
  btn?.click()
})
await settle(2200)

// 切到编辑
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '编辑')
  btn?.click()
})
await settle(1500)
log(`EDIT toolbar=${JSON.stringify(await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('button'))
  .filter(b => b.getBoundingClientRect().width > 0)
  .map(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)))].slice(0, 60)))}`)
await shot('20-edit-mode.png')

// 在正文末尾敲字，观察保存状态变化
const statuses = []
const collectStatus = async (tag) => {
  const s = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('[class*="save"], [class*="sync"], [role="status"], [aria-live]'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80))
    return [...new Set(cands)].slice(0, 12)
  })
  statuses.push({ tag, s })
}
await collectStatus('before')
const editor = page.locator('.note-editor [contenteditable="true"], [contenteditable="true"]').first()
if (await editor.count()) {
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('（走查：保存反馈测试）')
  await collectStatus('t0')
  await settle(1500); await collectStatus('t1.5')
  await settle(3000); await collectStatus('t4.5')
} else {
  log('EDIT no contenteditable found')
}
log(`SAVE STATES ${JSON.stringify(statuses, null, 1)}`)
await shot('21-edit-typing.png')

// ---- 2. 全局搜索：输入与结果 ----
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.hud-rail button'))
    .find(b => (b.getAttribute('aria-label') ?? '').includes('查找'))
  btn?.click()
})
await settle(1500)
const searchInput = page.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="查找"]').first()
if (await searchInput.count()) {
  await searchInput.fill('安史')
  await settle(1800)
  const results = await page.evaluate(() => ({
    visible: [...new Set(Array.from(document.querySelectorAll('button, [role="option"], li'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)))].slice(0, 50),
    hasNoResultText: document.body.innerText.includes('没有') || document.body.innerText.includes('无结果'),
  }))
  log(`SEARCH RESULTS ${JSON.stringify(results)}`)
  await shot('22-search-results.png')
} else {
  log('SEARCH no input found')
}

// ---- 3. 气泡轻聊开合（不发送） ----
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.getAttribute('aria-label') ?? '').includes('气泡轻聊'))
  btn?.click()
})
await settle(1600)
const chat = await page.evaluate(() => {
  const area = Array.from(document.querySelectorAll('textarea')).find(t => t.getBoundingClientRect().width > 0)
  return {
    textarea: area ? { placeholder: area.getAttribute('placeholder'), rect: area.getBoundingClientRect().toJSON() } : null,
    visibleButtons: [...new Set(Array.from(document.querySelectorAll('button'))
      .filter(b => b.getBoundingClientRect().width > 0)
      .map(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)))].slice(0, 40),
  }
})
log(`LIGHT CHAT ${JSON.stringify(chat)}`)
await shot('23-light-chat.png')

await writeFile(`${outDir}/interactions.md`, '# 交互态探测 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log('DONE')
await browser.close()
