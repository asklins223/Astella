/** 收尾冒烟：输入即筛选、快捷键清单、采集格式提示、Esc 分层撤销。 */
import { chromium } from 'playwright'
import './load-capture-env.mjs'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost'))
const settle = (ms = 1200) => page.waitForTimeout(ms)
const clickRail = (name) => page.evaluate((n) => {
  const btn = Array.from(document.querySelectorAll('.hud-rail button')).find(b => (b.getAttribute('aria-label') ?? '').includes(n))
  btn?.click()
}, name)

await page.waitForSelector('.hud-rail', { timeout: 60_000 })

// 1. 来源库：输入即筛选
await clickRail('来源'); await settle(1600)
await page.locator('#source-library-query').fill('report')
await settle(900)
const cardsAfterType = await page.evaluate(() => document.querySelectorAll('.source-sheet').length)
await page.locator('#source-library-query').fill('reportzzz')
await settle(900)
const cardsNoMatch = await page.evaluate(() => document.querySelectorAll('.source-sheet').length)
const emptyShown = await page.evaluate(() => document.body.innerText.includes('没有找到'))
console.log(`SOURCE AS-YOU-TYPE typed=${cardsAfterType} nomatch=${cardsNoMatch} emptyShown=${emptyShown}`)
await page.locator('#source-library-query').fill('')
await settle(700)

// 2. 采集纸页格式提示
await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('采集新来源'))?.click())
await settle(1200)
console.log(`CAPTURE HINT ${JSON.stringify(await page.evaluate(() => document.querySelector('.capture-format-hint')?.textContent?.slice(0, 60) ?? null))}`)
await page.keyboard.press('Escape'); await settle(600)

// 3. 搜索页：Esc 清词 + 撤销
await clickRail('搜索'); await settle(1400)
await page.locator('[data-search-query]').fill('安史')
await settle(1400)
await page.keyboard.press('Escape')
await settle(900)
const undo = await page.evaluate(() => ({
  undoShown: Boolean(document.querySelector('.search-undo')),
  value: document.querySelector('[data-search-query]')?.value ?? null,
}))
if (undo.undoShown) {
  await page.evaluate(() => Array.from(document.querySelectorAll('.search-undo button')).find(b => b.textContent?.includes('撤销'))?.click())
  await settle(900)
}
const restored = await page.evaluate(() => document.querySelector('[data-search-query]')?.value ?? null)
console.log(`SEARCH ESC undo=${undo.undoShown} cleared=${JSON.stringify(undo.value)} restored=${JSON.stringify(restored)}`)

// 4. 设置：快捷键清单
await clickRail('设置'); await settle(1400)
await page.evaluate(() => Array.from(document.querySelectorAll('.settings-menu button')).find(b => b.textContent?.includes('主题与动效'))?.click())
await settle(1200)
console.log(`SHORTCUTS ${JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.settings-shortcut-list dt')).map(dt => dt.textContent?.trim())))}`)
await page.screenshot({ path: 'outputs/audit-20261011/70-settings-shortcuts.png' })

// 5. 目录 aria 与标签
console.log(`RAIL aria=${await page.evaluate(() => document.querySelector('.hud-rail')?.getAttribute('aria-label'))}`)
await browser.close()
