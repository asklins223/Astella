import { chromium } from 'playwright'
import './load-capture-env.mjs'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)
const probe = () => page.evaluate(() => {
  const tools = document.querySelector('.notebook-desk__tool-island .editor-tools') ?? document.querySelector('.notebook-volume__tools .editor-tools')
  if (!tools) return { error: 'no toolbar' }
  const r = tools.getBoundingClientRect()
  return { where: tools.closest('.notebook-desk__tool-island') ? 'island' : 'book', width: Math.round(r.width), height: Math.round(r.height), clientWidth: tools.clientWidth, scrollWidth: tools.scrollWidth, overflow: tools.scrollWidth - tools.clientWidth, fullscreen: Boolean(document.querySelector('.notebook-desk')?.hasAttribute('data-fullscreen')) }
})
if (!(await page.locator('.notebook-desk').count())) { await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click().catch(() => undefined); await page.waitForTimeout(1200); await page.locator('.note-open').first().click().catch(() => undefined); await page.waitForTimeout(1800) }
if (await page.getByRole('button', { name: '退出全屏笔记' }).count()) { await page.getByRole('button', { name: '退出全屏笔记' }).first().click().catch(() => undefined); await page.waitForTimeout(700) }
if (!(await page.getByRole('button', { name: '保存版本' }).count())) { const e = page.getByRole('button', { name: /^编辑$/ }); if (await e.count()) { await e.first().click().catch(() => undefined); await page.waitForTimeout(900) } }
console.log('普通 编辑：', JSON.stringify(await probe()))
await page.screenshot({ path: 'outputs/notebook-tool-island-20261008/11-ordinary-toolbar.png' })
await page.getByRole('button', { name: '全屏笔记' }).first().click().catch(() => undefined); await page.waitForTimeout(900)
console.log('全屏 编辑：', JSON.stringify(await probe()))
await page.screenshot({ path: 'outputs/notebook-tool-island-20261008/12-fullscreen-toolbar.png' })

// 「插入」菜单：图片/表格/代码块/分隔线/链接都收在这条菜单里（2026-10-08 用户要求）
await page.getByRole('button', { name: '插入' }).first().click().catch(() => undefined)
await page.waitForTimeout(600)
const menu = await page.evaluate(() => {
  const panel = [...document.querySelectorAll('.note-format-popup')].find(p => getComputedStyle(p).display !== 'none')
  return panel ? [...panel.querySelectorAll('.editor-tools-insert button')].map(b => b.textContent.trim()) : null
})
console.log('插入菜单：', JSON.stringify(menu))
await page.screenshot({ path: 'outputs/notebook-tool-island-20261008/13-insert-menu.png' })
await page.keyboard.press('Escape')
await browser.close()
