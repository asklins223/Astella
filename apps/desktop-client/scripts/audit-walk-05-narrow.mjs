import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/audit-20261011')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (l) => { notes.push(l); console.log(l) }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]
const settle = (ms = 1200) => page.waitForTimeout(ms)
const overflow = () => page.evaluate(() => ({
  vw: window.innerWidth, vh: window.innerHeight,
  hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  scrollW: document.documentElement.scrollWidth,
  vOverflow: document.documentElement.scrollHeight > window.innerHeight + 1,
}))

const session = await context.newCDPSession(page)
const screens = [
  ['notes', '笔记'], ['today', '今日学习'], ['settings', '设置'], ['source', '来源'],
]
for (const [w, h] of [[1280, 720], [960, 540]]) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await settle(1000)
  for (const [key, label] of screens) {
    await page.evaluate((n) => {
      const btn = Array.from(document.querySelectorAll('.hud-rail button'))
        .find(b => (b.getAttribute('aria-label') ?? '').includes(n))
      btn?.click()
    }, label)
    await settle(1500)
    const o = await overflow()
    log(`${key}@${w}x${h} ${JSON.stringify(o)}`)
    await page.screenshot({ path: `${outDir}/30-${key}-${w}x${h}.png` })
  }
}
await session.send('Emulation.clearDeviceMetricsOverride')
await writeFile(`${outDir}/narrow.md`, '# 窄窗/缩放 2026-10-11\n\n```jsonc\n' + notes.join('\n') + '\n```\n')
log('DONE')
await browser.close()
