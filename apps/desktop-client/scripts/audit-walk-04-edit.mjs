/**
 * 启发式体验走查（2026-10-11）：笔记编辑态与保存反馈（重试，带显式等待）。
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

await page.waitForSelector('.hud-rail', { timeout: 60_000 })

// 确保在笔记列表
const onList = await page.evaluate(() => document.body.innerText.includes('全部笔记'))
if (!onList) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.hud-rail button'))
      .find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))
    btn?.click()
  })
  await settle(1800)
}
log(`ON LIST ${await page.evaluate(() => document.body.innerText.includes('全部笔记'))}`)

// 打开第一篇
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .filter(b => b.getBoundingClientRect().width > 0)
    .find(b => (b.textContent ?? '').trim().startsWith('打开笔记：'))
    ?? Array.from(document.querySelectorAll('button'))
      .filter(b => b.getBoundingClientRect().width > 0)
      .find(b => (b.textContent ?? '').trim() === '打开笔记')
  btn?.click()
})
await page.waitForFunction(() => document.body.innerText.includes('返回笔记库'), null, { timeout: 20_000 })
await settle(1500)
log('NOTE OPENED')

// 切编辑
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '编辑')
  btn?.click()
})
await settle(1500)
const editState = await page.evaluate(() => ({
  editActive: Boolean(Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent?.trim() === '编辑' && (b.getAttribute('aria-pressed') === 'true' || b.className.includes('active')))),
  contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
  saveTexts: [...new Set(Array.from(document.querySelectorAll('[class*="save"], [class*="sync"], [class*="status"], [aria-live]'))
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => (el.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 10),
}))
log(`EDIT STATE ${JSON.stringify(editState)}`)
await page.screenshot({ path: `${outDir}/20-edit-mode.png` })

// 敲字并轮询保存状态
const samples = []
const editable = page.locator('[contenteditable="true"]').first()
if (await editable.count()) {
  await editable.click()
  await page.keyboard.press('End')
  await page.keyboard.type('（走查：保存反馈）')
  for (const t of [0, 1000, 2500, 5000, 8000]) {
    if (t) await settle(t - (samples.at(-1)?.at ?? 0))
    const s = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('[class*="save"], [class*="sync"], [aria-live], [role="status"]'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => (el.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 10))
    samples.push({ at: t, s })
  }
  log(`SAVE POLL ${JSON.stringify(samples)}`)
  await page.screenshot({ path: `${outDir}/21-edit-typing.png` })
} else {
  log('NO contenteditable — 编辑态未进入')
}

// 回阅读态，看正文是否已有新文本 + 顶部状态
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '阅读')
  btn?.click()
})
await settle(1200)
const after = await page.evaluate(() => ({
  hasNewText: document.body.innerText.includes('走查：保存反馈'),
  status: [...new Set(Array.from(document.querySelectorAll('[class*="save"], [class*="sync"], [class*="status"]'))
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => (el.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 8),
}))
log(`AFTER READ ${JSON.stringify(after)}`)

await writeFile(`${outDir}/edit-probe.md`, '# 编辑保存反馈 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log('DONE')
await browser.close()
