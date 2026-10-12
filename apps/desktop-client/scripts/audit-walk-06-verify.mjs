/**
 * 真窗口复核代码走查的重点疑点（2026-10-11）。
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (l) => { notes.push(l); console.log(l) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]
const settle = (ms = 1200) => page.waitForTimeout(ms)
const txt = () => page.evaluate(() => document.body.innerText)

// 打开笔记（若不在）
if (!(await txt()).includes('返回笔记库')) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))
    btn?.click()
  })
  await settle(1600)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0)
      .find(b => (b.textContent ?? '').trim().startsWith('打开笔记：'))
    btn?.click()
  })
  await page.waitForFunction(() => document.body.innerText.includes('返回笔记库'), null, { timeout: 20000 })
  await settle(1500)
}

// 1. 制卡方案纸：先进编辑态制造 dirty，再点「生成学习卡」
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '编辑' && b.getBoundingClientRect().width > 0)
  btn?.click()
})
await settle(1200)
const editable = page.locator('[contenteditable="true"]').first()
await editable.click()
await page.keyboard.press('End')
await page.keyboard.type('走查')
await settle(800)
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('生成学习卡') && b.getBoundingClientRect().width > 0)
  btn?.click()
})
await settle(1800)
const setup = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]') ?? Array.from(document.querySelectorAll('div')).find(d => d.innerText?.includes('这次想怎么练') && d.getBoundingClientRect().width > 400)
  if (!dialog) return { found: false, body: document.body.innerText.slice(0, 400) }
  const btns = Array.from(dialog.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0)
    .map(b => ({ t: (b.textContent ?? '').trim().slice(0, 30), disabled: b.disabled, title: b.title || null }))
  return { found: true, title: dialog.innerText.slice(0, 120), buttons: btns, hasSaveHint: dialog.innerText.includes('保存') }
})
log(`SETUP DIALOG ${JSON.stringify(setup)}`)
await page.screenshot({ path: `${outDir}/40-generation-setup-dirty.png` })
// 关掉弹层
await page.keyboard.press('Escape')
await settle(800)

// 2. 速看页灰按钮
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '速看' && b.getBoundingClientRect().width > 0)
  btn?.click()
})
await settle(2200)
const overview = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .filter(b => b.getBoundingClientRect().width > 0 && b.disabled)
  .map(b => ({ t: (b.textContent ?? '').trim().slice(0, 30), title: b.title || null, aria: b.getAttribute('aria-describedby') })))
log(`OVERVIEW DISABLED ${JSON.stringify(overview)}`)
await page.screenshot({ path: `${outDir}/41-overview-disabled.png` })

// 3. 资料袋/来源资料/原始资料 三名同屏
const names = await page.evaluate(() => {
  const t = document.body.innerText
  return { 来源资料: t.includes('来源资料'), 资料袋: t.includes('资料袋'), 原始资料: t.includes('原始资料') }
})
log(`SOURCE BAG NAMES ${JSON.stringify(names)}`)

// 回正文页确认页眉/工具条同屏两词
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '正文' && b.getBoundingClientRect().width > 0)
  btn?.click()
})
await settle(1500)
const names2 = await page.evaluate(() => {
  const t = document.body.innerText
  return { 来源资料: t.includes('来源资料'), 资料袋: t.includes('资料袋') }
})
log(`BODY PAGE NAMES ${JSON.stringify(names2)}`)

// 4. 保存状态：阅读态 vs 编辑态词表（当前 dirty 未存）
const readStatus = await page.evaluate(() => {
  const m = document.body.innerText.match(/(已同步|等待同步|同步失败|已自动保存|已保存|草稿|离线暂存)/g)
  return [...new Set(m ?? [])]
})
log(`STATUS WORDS ON PAGE ${JSON.stringify(readStatus)}`)

// 5. 手记 Esc 行为
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') ?? '').includes('对话手记') || b.textContent?.includes('对话手记'))
  btn?.click()
})
await settle(1500)
const beforeEsc = await page.evaluate(() => ({
  drawer: document.body.innerText.includes('我们的对话手记'),
  chatOpen: Boolean(Array.from(document.querySelectorAll('textarea')).find(t => t.getBoundingClientRect().width > 0 && t.placeholder?.includes('想聊什么'))),
}))
await page.keyboard.press('Escape')
await settle(1200)
const afterEsc = await page.evaluate(() => ({
  drawer: document.body.innerText.includes('我们的对话手记'),
  chatOpen: Boolean(Array.from(document.querySelectorAll('textarea')).find(t => t.getBoundingClientRect().width > 0 && t.placeholder?.includes('想聊什么'))),
}))
log(`JOURNAL ESC ${JSON.stringify({ beforeEsc, afterEsc })}`)
await page.screenshot({ path: `${outDir}/42-after-journal-esc.png` })

// 6. 设置页退出登录（只看有没有确认，不真点）
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('设置'))
  btn?.click()
})
await settle(1500)
const signout = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '退出登录' && b.getBoundingClientRect().width > 0)
  if (!btn) return null
  return { title: btn.title || null, aria: btn.getAttribute('aria-label'), parentText: btn.parentElement?.innerText?.slice(0, 100) }
})
log(`SIGNOUT ENTRY ${JSON.stringify(signout)}`)

await writeFile(`${outDir}/verify.md`, '# 真窗口复核 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log('DONE')
await browser.close()
