import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find(p => p.url().includes('localhost:5173'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="email"]', 'companion-probe@astella.local')
  await page.fill('input[type="password"]', 'probe-c37bpcz4')
  await page.getByRole('button', { name: /登录/ }).click()
}
await page.waitForSelector('.room-control', { timeout: 60000 })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /^笔记$/ }).first().click()
await page.waitForTimeout(2500)
const open = page.getByRole('button', { name: /^打开笔记/ }).first()
if (await open.count()) await open.click()
await page.waitForTimeout(3500)

const out = await page.evaluate(() => {
  const island = document.querySelector('.room-control').getBoundingClientRect()
  const hits = []
  for (const el of document.querySelectorAll('button, a, [role="tab"], span')) {
    const t = (el.textContent || '').trim()
    if (t !== '记录' && t !== '往外学' && t !== '正文') continue
    const b = el.getBoundingClientRect()
    if (!b.width) continue
    hits.push({
      text: t, tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60),
      box: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
      airBelowIsland: Math.round(b.top - island.bottom),
      underIsland: b.left < island.right && b.right > island.left && b.top < island.bottom && b.bottom > island.top,
    })
  }
  return {
    platform: document.querySelector('.desktop-app').dataset.platform,
    viewport: [innerWidth, innerHeight],
    island: [Math.round(island.left), Math.round(island.top), Math.round(island.right), Math.round(island.bottom)],
    hits: hits.filter(h => h.tag === 'button'),
  }
})
console.log(JSON.stringify(out, null, 1))
await page.screenshot({ path: '/tmp/notebook-tabs-under-island.png' })

await page.evaluate(() => { document.querySelector('.desktop-app').dataset.platform = 'win32' })
await page.waitForTimeout(400)
console.log('--- forced win32 ---')
console.log(JSON.stringify(await out2(), null, 1))
await page.screenshot({ path: '/tmp/notebook-tabs-under-island-win32.png' })
await page.reload({ waitUntil: 'networkidle' })
await browser.close()
process.exit(0)

async function out2() { return page.evaluate(() => {
  const island = document.querySelector('.room-control').getBoundingClientRect()
  const tab = [...document.querySelectorAll('button.notebook-volume__bookmark')].find(e => (e.textContent || '').trim() === '记录')
  const b = tab.getBoundingClientRect()
  return {
    platform: document.querySelector('.desktop-app').dataset.platform,
    island: [Math.round(island.left), Math.round(island.top), Math.round(island.right), Math.round(island.bottom)],
    recordTab: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
    airBelowIsland: Math.round(b.top - island.bottom),
    overlaps: b.left < island.right && b.right > island.left && b.top < island.bottom && b.bottom > island.top,
  }
}) }
