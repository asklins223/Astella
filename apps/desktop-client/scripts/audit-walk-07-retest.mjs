import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'
const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (l) => { notes.push(l); console.log(l) }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost'))
const settle = (ms = 1200) => page.waitForTimeout(ms)

if (!(await page.evaluate(() => document.body.innerText.includes('返回笔记库')))) {
  log('stage: navigate notes')
  await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))?.click())
  await settle(1600)
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).find(b => (b.textContent ?? '').trim().startsWith('打开笔记：'))?.click())
  await page.waitForFunction(() => document.body.innerText.includes('返回笔记库'), null, { timeout: 20000 })
  await settle(1500)
}
log('stage: edit toggle')
await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '编辑' && b.getBoundingClientRect().width > 0)?.click())
await settle(1200)
const ces = await page.evaluate(() => Array.from(document.querySelectorAll('[contenteditable="true"]')).map((e, i) => ({ i, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), cls: e.className.slice(0, 40) })))
log(`CE ${JSON.stringify(ces)}`)
const marker = `走查脏态${Date.now() % 100000}`
const visibleIdx = ces.find(c => c.w > 0 && c.h > 0)?.i ?? 0
if (ces.length) {
  await page.evaluate((idx) => {
    const el = document.querySelectorAll('[contenteditable="true"]')[idx]
    el.focus()
    const sel = window.getSelection(); const range = document.createRange()
    range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range)
  }, visibleIdx)
  await page.keyboard.type(marker)
}
await settle(1600)
const landed = await page.evaluate((m) => document.body.innerText.includes(m), marker)
log(`LANDED ${landed}`)
await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('生成学习卡') && b.getBoundingClientRect().width > 0)?.click())
await settle(1800)
const footer = await page.evaluate(() => {
  const dialog = Array.from(document.querySelectorAll('div')).find(d => d.innerText?.includes('这次想怎么练') && d.getBoundingClientRect().width > 400)
  if (!dialog) return null
  const gen = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.includes('开始生成'))
  return { footerText: dialog.innerText.split('\n').slice(-4).join(' | '), genDisabled: gen?.disabled ?? null }
})
log(`FOOTER ${JSON.stringify(footer)}`)
await page.screenshot({ path: `${outDir}/43-generation-dirty-retest.png` })
await writeFile(`${outDir}/retest.md`, '# 方案纸脏态复测\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log('DONE')
await browser.close()
