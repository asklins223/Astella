/**
 * 「她的记事」与人格文档的真窗口走查（2026-10-10，方案 50 自主性阶段）。
 *
 * 附着 `npx electron-vite dev --remoteDebuggingPort 9223 -- --user-data-dir=/tmp/astella-plan50-window`，
 * 量真 DOM：目录/详情/Markdown、停用与恢复的串行提交、纠正后的版本、搜索与空间切换、
 * 窄窗是否溢出。截图与量到的盒子一起落盘，测试不能替代交互。
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import './load-capture-env.mjs'

const outDir = resolve(import.meta.dirname, '../outputs/self-notes-window-20261010')
await mkdir(outDir, { recursive: true })
const notes = []
const log = (line) => { notes.push(line); console.log(line) }

const browser = await chromium.connectOverCDP(process.env.ASTELLA_CAPTURE_CDP ?? 'http://127.0.0.1:9223')
const context = browser.contexts()[0]
const page = context.pages().find(p => p.url().includes('localhost')) ?? context.pages()[0]

if (await page.locator('.desktop-access-gate input[type="email"]').count()) {
  await page.locator('.desktop-access-gate input[type="email"]').fill('companion-probe@astella.local')
  await page.locator('.desktop-access-gate input[type="password"]').first().fill('probe-c37bpcz4')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.waitForSelector('.hud-rail', { timeout: 90_000 })
}
await page.waitForSelector('.hud-rail', { timeout: 90_000 })
await page.waitForTimeout(1500)

// HUD 轨道会被 svg 与气泡拦住 pointer events，直接 click DOM 节点（见 dev-stack 走查笔记）。
// 中心已经在打开状态时再 invoke 一次会切换掉，所以先看现成的 tab。
if (await page.locator('#companion-tab-memory').count() === 0) {
  await page.evaluate(() => document.querySelector('.hud-rail button[aria-label="伴星"]')?.click())
  await page.waitForSelector('#companion-tab-memory', { timeout: 30_000 })
}
await page.evaluate(() => document.querySelector('#companion-tab-memory')?.click())
await page.waitForSelector('.cc-memory-views', { timeout: 30_000 })
await page.getByRole('button', { name: '她的记事', exact: true }).click()
await page.waitForSelector('section[aria-label="她的记事"] .cc-methods-index', { timeout: 30_000 })
await page.getByRole('button', { name: '全部记忆', exact: true }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '她的记事', exact: true }).click()
await page.waitForSelector('section[aria-label="她的记事"] .cc-methods-index', { timeout: 30_000 })
await page.waitForTimeout(900)

const readIndex = () => page.evaluate(() => Array.from(
  document.querySelectorAll('.cc-methods-index [data-note-key]')).map(button => ({
  key: button.getAttribute('data-note-key'),
  state: button.querySelector('small')?.textContent?.trim() ?? '',
  title: button.querySelector('strong')?.textContent?.trim() ?? '',
  wake: button.querySelector('span')?.textContent?.trim() ?? '',
})))
const overflow = () => page.evaluate(() => ({
  viewport: { w: window.innerWidth, h: window.innerHeight },
  docWidth: document.documentElement.scrollWidth,
  hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  detail: (() => { const el = document.querySelector('.cc-method-detail')
    return el ? { w: Math.round(el.getBoundingClientRect().width), scrollW: el.scrollWidth } : null })(),
}))
const box = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel)
  return el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null
}, selector)

log(`INDEX ${JSON.stringify(await readIndex(), null, 1)}`)
await page.screenshot({ path: `${outDir}/01-index-wide.png` })

// 1. 常驻那条：Markdown 真渲染、动作按钮、已排好的重评时间。
await page.evaluate(() => Array.from(document.querySelectorAll('[data-note-key="反例优先"]')).pop()?.click())
await page.waitForSelector('article[aria-label="自己的记事详情"] h3', { timeout: 15_000 })
await page.waitForTimeout(500)
const resident = await page.evaluate(() => {
  const detail = document.querySelector('article[aria-label="自己的记事详情"]')
  return {
    headings: Array.from(detail.querySelectorAll('[role="heading"]')).map(h => h.textContent?.trim()),
    quote: detail.querySelector('.companion-md__quote')?.textContent?.trim() ?? null,
    bullets: detail.querySelectorAll('li').length,
    strong: detail.querySelectorAll('strong').length,
    reason: detail.querySelector('p.cc-muted')?.textContent?.trim() ?? null,
    actions: Array.from(detail.querySelectorAll('.cc-actions button')).map(b => b.textContent?.trim()),
  }
})
log(`RESIDENT ${JSON.stringify(resident)}`)
await page.screenshot({ path: `${outDir}/02-resident-detail-wide.png` })

// 2. 停用 → 状态词、串行提交、列表刷新；再恢复。
await page.evaluate(() => Array.from(document.querySelectorAll('.cc-actions button'))
  .find(b => b.textContent?.includes('停用这条记事'))?.click())
await page.waitForFunction((want) => Array.from(document.querySelectorAll('section[aria-label="她的记事"] [role="status"]'))
  .some(node => node.textContent?.includes(want)), '已停用', { timeout: 15_000 })
log(`DISABLE notice=${JSON.stringify(await page.locator('section[aria-label="她的记事"] [role="status"]').last().textContent())}`)
await page.waitForTimeout(600)
const afterDisable = { index: await readIndex(), detail: await page.evaluate(() => ({
  button: Array.from(document.querySelectorAll('.cc-actions button')).map(b => b.textContent?.trim()),
  state: document.querySelector('.cc-methods-index [data-note-key="反例优先"] small')?.textContent?.trim() })) }
log(`DISABLE state=${JSON.stringify(afterDisable)}`)
await page.evaluate(() => Array.from(document.querySelectorAll('.cc-actions button'))
  .find(b => b.textContent?.includes('恢复这条记事'))?.click())
await page.waitForTimeout(900)
await page.waitForFunction(() => Array.from(document.querySelectorAll('section[aria-label="她的记事"] [role="status"]'))
  .some(node => node.textContent?.includes('已恢复')), null, { timeout: 15_000 })
log(`RESTORE notice=${JSON.stringify(await page.locator('section[aria-label="她的记事"] [role="status"]').last().textContent())} tier=${
  JSON.stringify((await readIndex()).find(n => n.key === '反例优先'))}`)

// 3. 纠正内容：改一个字，版本 +1，历史里能看到旧版本。
await page.evaluate(() => Array.from(document.querySelectorAll('.cc-actions button'))
  .find(b => b.textContent?.includes('纠正内容'))?.click())
await page.waitForSelector('form.cc-form textarea', { timeout: 15_000 })
const body = page.locator('form.cc-form textarea')
const before = await body.inputValue()
await body.fill(`${before}\n\n（走查补一行：这次先记着，等真实行为出现再改。）`)
await page.waitForTimeout(300)
await page.evaluate(() => Array.from(document.querySelectorAll('form.cc-form button'))
  .find(b => b.textContent?.includes('保存纠正'))?.click())
await page.waitForFunction(() => Array.from(document.querySelectorAll('section[aria-label="她的记事"] [role="status"]'))
  .some(node => node.textContent?.includes('纠正已保存')), null, { timeout: 15_000 })
const corrected = await page.evaluate(() => ({
  notice: document.querySelectorAll('section[aria-label="她的记事"] [role="status"]').length
    ? Array.from(document.querySelectorAll('section[aria-label="她的记事"] [role="status"]')).pop()?.textContent?.trim() : null,
  revision: document.querySelector('.cc-methods-index [data-note-key="反例优先"] small')?.textContent?.trim() ?? null,
  shown: document.querySelector('article[aria-label="自己的记事详情"] .cc-persona-prose')?.textContent?.includes('走查补一行') ?? false,
}))
log(`CORRECT ${JSON.stringify(corrected)} keptOriginal=${before.includes('还没想清楚的')}`)
await page.screenshot({ path: `${outDir}/03-corrected-detail-wide.png` })

// 4. 版本历史（新详情里展开）。
await page.evaluate(() => { const d = document.querySelector('details.cc-details'); if (d) d.open = true })
await page.waitForTimeout(700)
const history = await page.evaluate(() => Array.from(document.querySelectorAll('details.cc-details details'))
  .map(d => d.querySelector('summary')?.textContent?.trim()))
log(`HISTORY ${JSON.stringify(history)}`)

// 5. 已停用那条要能恢复；过期那条状态词要写「已过期」。
await page.evaluate(() => Array.from(document.querySelectorAll('[data-note-key="被停用的记事"]')).pop()?.click())
await page.waitForTimeout(600)
log(`DISABLED NOTE ${JSON.stringify({
  state: await page.evaluate(() => document.querySelector('.cc-methods-index [data-note-key="被停用的记事"] small')?.textContent?.trim()),
  actions: await page.evaluate(() => Array.from(document.querySelectorAll('.cc-actions button')).map(b => b.textContent?.trim())) })}`)
await page.evaluate(() => Array.from(document.querySelectorAll('.cc-actions button'))
  .find(b => b.textContent?.includes('恢复这条记事'))?.click())
await page.waitForTimeout(900)
log(`RESTORE disabled-note=${JSON.stringify((await readIndex()).find(n => n.key === '被停用的记事'))}`)

// 6. 筛选：输入关键词应收窄目录，清空还原。
await page.getByRole('searchbox', { name: '筛选她的记事' }).fill('反例')
await page.waitForTimeout(600)
const filtered = await readIndex()
await page.getByRole('searchbox', { name: '筛选她的记事' }).fill('')
await page.waitForTimeout(600)
log(`FILTER narrowed=${filtered.length} keys=${JSON.stringify(filtered.map(n => n.key))} restored=${(await readIndex()).length}`)

// 7. 常驻详情：重评时间在目录里怎么表达（等待新证据）。
log(`WAKE line=${JSON.stringify((await readIndex()).find(n => n.key === '等待新证据'))}`)

log(`WIDE boxes=${JSON.stringify({ index: await box('.cc-methods-index'), detail: await box('.cc-method-detail'), page: await box('section[aria-label="她的记事"]') })}`)
log(`WIDE layout=${JSON.stringify(await overflow())}`)

// 8. 窄窗：布局视口压到 900×700，验是否溢出/挤掉详情。
const session = await context.newCDPSession(page)
await session.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false })
await page.waitForTimeout(900)
await page.evaluate(() => Array.from(document.querySelectorAll('[data-note-key="等待新证据"]')).pop()?.click())
await page.waitForTimeout(700)
log(`NARROW layout=${JSON.stringify(await overflow())}`)
await page.screenshot({ path: `${outDir}/04-self-notes-narrow-900.png` })
await session.send('Emulation.clearDeviceMetricsOverride')
await page.waitForTimeout(700)

// 9. 人格页：她写给自己的文档（Markdown）与编辑区。
await page.evaluate(() => document.querySelector('#companion-tab-persona')?.click())
await page.waitForTimeout(1200)
const persona = await page.evaluate(() => {
  const root = document.querySelector('#companion-panel-persona')
  const label = Array.from(root?.querySelectorAll('h3, h4, label, span, p') ?? []).find(el => el.textContent?.trim() === '她写给自己的文档')
  const prose = root?.querySelector('.cc-persona-prose')
  const area = root?.querySelector('textarea')
  return {
    foundLabel: Boolean(label),
    prose: prose ? { html: prose.innerHTML.slice(0, 120), headings: prose.querySelectorAll('h1,h2,h3').length } : null,
    textareaRows: area?.rows ?? null,
    buttons: Array.from(root?.querySelectorAll('button') ?? []).map(b => b.textContent?.trim()).filter(Boolean).slice(0, 8),
  }
})
log(`PERSONA ${JSON.stringify(persona)}`)

// 10. 纠正文档：Markdown 自由篇章要真渲染（标题/列表），编辑区是 rows=12 的整块。
await page.evaluate(() => Array.from(document.querySelectorAll('#companion-panel-persona button'))
  .find(b => b.textContent?.includes('纠正文档'))?.click())
await page.waitForSelector('#companion-panel-persona textarea', { timeout: 15_000 })
await page.locator('#companion-panel-persona textarea').fill('## 我给自己写的\n\n解释一个说法时我先找反例，再回到正面证据；赶时间的场合算例外。\n\n- 来源：我自己整理的偏好\n- 状态：暂定，等真实分歧核对')
const draft = await page.evaluate(() => {
  const area = document.querySelector('#companion-panel-persona textarea')
  return { rows: area?.rows ?? null, placeholder: area?.getAttribute('placeholder') ?? null }
})
log(`PERSONA DRAFT ${JSON.stringify(draft)}`)
await page.evaluate(() => Array.from(document.querySelectorAll('#companion-panel-persona button'))
  .find(b => b.textContent?.includes('保存描述'))?.click())
await page.waitForFunction(() => {
  const prose = document.querySelector('#companion-panel-persona .cc-persona-prose')
  return Boolean(prose?.textContent?.includes('我给自己写的'))
}, null, { timeout: 20_000 })
const personaSaved = await page.evaluate(() => {
  const prose = document.querySelector('#companion-panel-persona .cc-persona-prose')
  return { headings: prose.querySelectorAll('[role="heading"]').length,
    bullets: prose.querySelectorAll('li').length, editStillOpen: Boolean(document.querySelector('#companion-panel-persona textarea')) }
})
log(`PERSONA SAVED ${JSON.stringify(personaSaved)}`)
await page.screenshot({ path: `${outDir}/06-persona-self-description-saved.png` })
await page.screenshot({ path: `${outDir}/05-persona-identity-wide.png` })

const kv = Object.fromEntries(notes.map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]))
await mkdir(outDir, { recursive: true })
const { writeFileSync } = await import('node:fs')
const header = '# 她的记事 / 人格文档 真窗口走查 2026-10-10\n\n账号 companion-probe@astella.local，dev 库 astella，CDP 9223 隔离 profile。\n\n```jsonc\n'
writeFileSync(`${outDir}/notes.md`, header + JSON.stringify(kv, null, 1) + '\n```\n')
log(`DONE screenshots=${outDir}`)
await browser.close()
