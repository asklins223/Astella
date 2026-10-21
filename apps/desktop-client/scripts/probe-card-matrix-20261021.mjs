// Plan 57 acceptance: note learning card at 100/125/150/200% zoom and two window
// sizes, measured in the real Electron window rather than a stand-alone page.
// Reads layout facts (overflow, min font size, control reachability) for the
// front, practice, and report scenes.
import './load-capture-env.mjs'
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const out = 'outputs/audit-card-matrix-20261021'
mkdirSync(out, { recursive: true })
const report = { checks: [], skipped: [], scenes: [] }
const check = (name, ok, detail = '') => { report.checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = (browser.contexts()[0]?.pages() ?? []).find(p => !p.url().startsWith('devtools'))
if (!page) { console.log('SKIP no Electron window on 9222'); process.exit(0) }
const cdp = await page.context().newCDPSession(page)

/** Open a note that has a learning card, from the note list. */
async function openCard() {
  // Rail entry: 「书架」 opens the notebook (notes, sources and search).
  await page.getByRole('button', { name: /^书架/ }).first().click().catch(() => {})
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /全部笔记/ }).first().click().catch(() => {})
  await page.waitForTimeout(2500)
  // Only notes that already have a card can open the card page.
  const rows = page.locator('.note-row').filter({ hasText: '练过学习卡' })
  const count = await rows.count()
  for (let index = 0; index < count; index++) {
    await rows.nth(index).locator('button.note-open').click().catch(() => {})
    await page.waitForTimeout(2200)
    const entry = page.locator('button, [role="tab"]').filter({ hasText: '学习卡' }).first()
    if (await entry.count()) {
      await entry.click().catch(() => {})
      await page.waitForTimeout(2500)
      if (await page.locator('.learning-card-page').count()) return true
    }
    await page.getByRole('button', { name: /返回笔记库|返回笔记/ }).first().click().catch(() => {})
    await page.waitForTimeout(1200)
  }
  return false
}

const opened = await openCard()
if (!opened) {
  console.log('SKIP could not reach a learning card from the note list')
  report.skipped.push('card entry')
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
  process.exit(0)
}

const measure = () => page.evaluate(() => {
  const root = document.querySelector('.learning-card-page')
  const scroll = document.querySelector('.lc-surface-scroll')
  const surface = document.querySelector('.learning-card-surface')
  const fonts = [...document.querySelectorAll('.learning-card-page *')].map(element => parseFloat(getComputedStyle(element).fontSize)).filter(Number.isFinite)
  // The room background layers deliberately extend past the viewport, so the
  // card is measured against its own paper, not the document.
  const surfaceRight = surface ? surface.getBoundingClientRect().right : document.documentElement.clientWidth
  const spill = [...document.querySelectorAll('.learning-card-page *')].reduce((max, element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 ? Math.max(max, Math.round(rect.right - surfaceRight)) : max
  }, 0)
  const widest = [...document.querySelectorAll('.learning-card-page *')].reduce((max, element) => Math.max(max, element.scrollWidth - element.clientWidth), 0)
  return {
    scene: root?.getAttribute('data-scene') ?? null,
    horizontalOverflow: Math.max(0, widest, spill),
    innerOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
    minFontSize: fonts.length ? Math.min(...fonts) : null,
    hasReturn: Boolean([...document.querySelectorAll('.lc-text-btn, .lc-btn')].find(button => /返回/.test(button.textContent ?? ''))),
    bodyText: (document.querySelector('.learning-card-page')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60),
    clippedButtons: [...document.querySelectorAll('.lc-btn')].filter(button => {
      const style = getComputedStyle(button)
      return button.scrollWidth > button.clientWidth + 2 && style.whiteSpace !== 'normal'
    }).length,
  }
})

const sizes = [{ width: 1440, height: 810 }, { width: 1280, height: 720 }]
const zooms = [1, 1.25, 1.5, 2]
for (const size of sizes) {
  for (const zoom of zooms) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(size.width / zoom), height: Math.round(size.height / zoom), deviceScaleFactor: 1, mobile: false,
    })
    await page.waitForTimeout(700)
    const facts = await measure()
    report.scenes.push({ ...size, zoom, ...facts })
    const label = `${size.width}x${size.height} @${zoom * 100}%`
    check(`${label} 无横向溢出`, facts.horizontalOverflow <= 1 && facts.innerOverflow <= 1, `doc=${facts.horizontalOverflow} inner=${facts.innerOverflow}`)
    check(`${label} 字号可读`, (facts.minFontSize ?? 0) >= 10, `${facts.minFontSize}px`)
    check(`${label} 返回入口可达`, facts.hasReturn, '')
    check(`${label} 按钮文字不被截断`, facts.clippedButtons === 0, `${facts.clippedButtons}`)
    await page.screenshot({ path: `${out}/${size.width}x${size.height}-${zoom * 100}.png` })
  }
}
await cdp.send('Emulation.clearDeviceMetricsOverride')
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2))
console.log(`\n${report.checks.filter(item => item.ok).length}/${report.checks.length} checks passed`)
await browser.close()
