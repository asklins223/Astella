import { chromium } from 'playwright'
import { resolve } from 'node:path'
import './load-capture-env.mjs'
const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost'))
const settle = (ms = 1200) => page.waitForTimeout(ms)
const log = (l) => console.log(l)

// 回笔记列表
if (!(await page.evaluate(() => document.body.innerText.includes('全部笔记')))) {
  await page.evaluate(() => Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes('笔记'))?.click())
  await settle(1600)
}
// 新建笔记
await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '新建笔记' && b.getBoundingClientRect().width > 0)?.click())
await settle(2500)
log(`AFTER NEW body-has-return ${await page.evaluate(() => document.body.innerText.includes('返回笔记库'))}`)
// 打字
const ces = await page.evaluate(() => Array.from(document.querySelectorAll('[contenteditable="true"]')).map((e, i) => ({ i, w: Math.round(e.getBoundingClientRect().width) })))
log(`CE ${JSON.stringify(ces)}`)
const idx = ces.find(c => c.w > 0)?.i ?? 0
if (ces.length) {
  await page.evaluate((i) => {
    const el = document.querySelectorAll('[contenteditable="true"]')[i]
    el.focus()
    const sel = window.getSelection(); const r = document.createRange()
    r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r)
  }, idx)
  await page.keyboard.type('新建笔记的脏态测试正文')
}
await settle(500)
const status = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('[class*="save"], [class*="sync"]')).filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim()))].slice(0, 6))
log(`STATUS ${JSON.stringify(status)}`)
// 方案纸
await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('生成学习卡') && b.getBoundingClientRect().width > 0)?.click())
await settle(1800)
const footer = await page.evaluate(() => {
  const dialog = Array.from(document.querySelectorAll('div')).find(d => d.innerText?.includes('这次想怎么练') && d.getBoundingClientRect().width > 400)
  if (!dialog) return { open: false, body: document.body.innerText.slice(0, 200) }
  const gen = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.includes('开始生成'))
  return { open: true, footerText: dialog.innerText.split('\n').slice(-5).join(' | '), genDisabled: gen?.disabled ?? null }
})
log(`FOOTER ${JSON.stringify(footer)}`)
await page.screenshot({ path: `${outDir}/44-newnote-generation.png` })
await browser.close()
