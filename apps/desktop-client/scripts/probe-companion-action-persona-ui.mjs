// Production components in the running Electron renderer. Proposal scenarios
// are local fixtures; this probe never confirms actions or writes persona data.
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const endpoint = process.env.COMPANION_UI_CDP ?? 'http://127.0.0.1:9224'
const output = resolve('outputs/companion-action-persona-ui')
await mkdir(output, { recursive: true })
const browser = await chromium.connectOverCDP(endpoint)
const page = browser.contexts()[0].pages().find(item => item.url().includes('localhost:5173'))
if (!page) throw new Error('Open the desktop dev renderer first')
const cdp = await page.context().newCDPSession(page)
page.setDefaultTimeout(10000)
const report = []
const check = (passed, label, detail) => {
  report.push({ passed, label, detail })
  if (!passed) throw new Error(`${label}: ${JSON.stringify(detail)}`)
}
const shot = name => page.screenshot({ path: `${output}/${name}.png` })
const countPapers = () => page.locator('.companion-hud__paper:visible').count()
const closeHistory = page.locator('.companion-history__header').getByRole('button', { name: '关闭对话记录', exact: true })

try {
  if (await closeHistory.isVisible()) {
    await closeHistory.click()
    await page.waitForTimeout(350)
  }
  await page.getByRole('tab', { name: '人格', exact: true }).click()
  await page.locator('.cc-persona').waitFor()
  await page.locator('.cc-page--persona').evaluate(element => { element.scrollTop = 0 })
  await shot('01-persona-reading')
  check(await page.locator('.cc-persona textarea:visible').count() === 0, 'Default persona is readable prose')
  await page.getByRole('button', { name: '修改自我描述', exact: true }).click()
  const editor = page.getByRole('textbox', { name: '她怎么说自己', exact: true })
  check(await editor.evaluate(element => document.activeElement === element), 'Description editor receives focus immediately')
  await shot('02-persona-editing')
  await editor.press('Escape')
  check(await page.getByRole('button', { name: '修改自我描述', exact: true }).evaluate(element => document.activeElement === element), 'Escape restores the edit trigger')
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: '修改自我描述', exact: true }).click()
    await page.getByRole('textbox', { name: '她怎么说自己', exact: true }).press('Escape')
  }
  await page.getByRole('button', { name: '对话手记', exact: true }).click()
  await page.locator('.companion-history').waitFor()
  await page.waitForTimeout(1500)
  await closeHistory.click()
  await page.waitForTimeout(500)
  check(await countPapers() === 0, 'Opening and closing actual history does not replay old action results')

  await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map(entry => entry.name)
    const reactUrl = urls.find(url => /\/react\.js\?/.test(url))
    const domUrl = urls.find(url => /\/react-dom_client\.js\?/.test(url))
    const reactModule = await import(reactUrl)
    const React = reactModule.default ?? reactModule
    const domModule = await import(domUrl)
    const createRoot = domModule.createRoot ?? domModule.default.createRoot
    const { CompanionReplyPapers } = await import(`/src/components/companion/CompanionReplyPapers.tsx?t=${Date.now()}`)
    const floating = document.querySelector('.companion-hud--floating')
    const node = document.createElement('div')
    node.dataset.companionUiProbe = 'local-fixtures'
    floating.append(node)
    const root = createRoot(node)
    const proposal = status => ({ phase: 'ready', proposal: {
      status, expiresAt: null, title: '记住一条偏好', targetSummary: '打招呼时只回应招呼本身，不回顾之前的对话，也不顺手追问今天的安排。',
      impactSummary: '在相同情境下采用这条偏好，可在记忆页纠正或停用。',
    } })
    const probe = { node, root, motion: floating.dataset.motion, floating, proposal, clicks: [],
      chat: { companionName: '伴星', mode: 'closed', liveReply: null, proposalStates: { one: { phase: 'loading' }, two: { phase: 'loading' }, three: { phase: 'loading' } },
        decideProposal: async (id, decision) => { probe.clicks.push({ id, decision }) }, retryProposal: async () => {}, setMode: mode => { probe.mode = mode } },
      render: () => root.render(React.createElement(CompanionReplyPapers, { chat: probe.chat, paused: false })),
    }
    window.__companionUiProbe = probe
    probe.render()
  })
  await page.waitForTimeout(150)
  check(await countPapers() === 0, 'Historical loading fixtures produce no floating cards')
  await page.evaluate(() => {
    const probe = window.__companionUiProbe
    probe.chat = { ...probe.chat, proposalStates: { one: probe.proposal('expired'), two: probe.proposal('succeeded'), three: { phase: 'error', message: '历史读取失败' } } }
    probe.render()
  })
  await page.waitForTimeout(150)
  check(await countPapers() === 0, 'Historical terminal/error fixtures stay quiet after hydration')
  await page.evaluate(() => {
    const probe = window.__companionUiProbe
    probe.chat = { ...probe.chat, liveReply: { messageId: 'probe-round', text: '模拟待确认', proposalIds: ['one', 'two', 'three'], hasActionBlocks: true },
      proposalStates: { one: probe.proposal('pending'), two: probe.proposal('pending'), three: probe.proposal('pending') } }
    probe.render()
  })
  await page.waitForTimeout(650)
  check(await countPapers() === 1, 'Three live proposals share one decision paper')
  await page.getByRole('button', { name: '下一项待处理动作', exact: true }).click()
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  check((await page.evaluate(() => window.__companionUiProbe.clicks))[0]?.id === 'two', 'Pager dispatches to the selected proposal')
  await shot('03-pending-batch')
  await page.evaluate(() => {
    const probe = window.__companionUiProbe
    probe.chat = { ...probe.chat, proposalStates: { one: probe.proposal('expired'), two: probe.proposal('succeeded'), three: probe.proposal('rejected') } }
    probe.render()
  })
  await page.waitForTimeout(650)
  check(await countPapers() === 1, 'Mixed terminal outcomes share one receipt')
  check(await page.locator('[data-kind="proposal-results"] dl').count() === 0, 'Receipt omits repeated target and impact paragraphs')
  const bounds = await page.locator('[data-kind="proposal-results"]').boundingBox()
  check(bounds.height < 210, 'Receipt remains compact at the normal viewport', bounds)
  await shot('04-short-receipt')

  for (const viewport of [{ width: 1280, height: 720 }, { width: 720, height: 405 }]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 2, mobile: false })
    await page.waitForTimeout(350)
    await page.locator('.cc-page--persona').evaluate(element => { element.scrollTop = 0 })
    const overflow = await page.locator('.cc-page--persona').evaluate(element => element.scrollWidth > element.clientWidth + 1)
    check(!overflow, `Persona has no horizontal overflow at ${viewport.width} CSS pixels`)
    await shot(`05-persona-receipt-${viewport.width}`)
    await page.getByRole('tab', { name: '记忆', exact: true }).click()
    await page.getByRole('button', { name: '我们的方法', exact: true }).click()
    await page.waitForTimeout(300)
    const method = page.locator('.cc-methods-index > button').first()
    if (await method.count()) {
      await method.click()
      await page.locator('.cc-method-detail').waitFor()
      const back = page.getByRole('button', { name: '← 返回方法清单', exact: true })
      if (await back.isVisible()) {
        check(await page.locator('.cc-methods-index').isVisible() === false, 'Narrow method reading replaces its index')
        const readingBounds = await page.locator('.cc-page--memory').boundingBox()
        const titleBounds = await page.locator('.cc-method-detail > h3').boundingBox()
        check(titleBounds.y >= readingBounds.y && titleBounds.y < readingBounds.y + readingBounds.height, 'Method title enters the first reading viewport', { readingBounds, titleBounds })
        await shot(`06-method-reading-${viewport.width}`)
        await back.click()
        check(await page.locator('.cc-methods-index').isVisible(), 'Return reveals the same method index')
      }
    }
    await page.getByRole('tab', { name: '人格', exact: true }).click()
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await page.evaluate(() => {
    const probe = window.__companionUiProbe
    probe.floating.dataset.motion = 'off'
    probe.chat = { ...probe.chat, liveReply: { ...probe.chat.liveReply, messageId: 'probe-failure', proposalIds: ['one'] }, proposalStates: { one: probe.proposal('failed') } }
    probe.render()
  })
  await page.waitForTimeout(150)
  check((await page.locator('[data-kind="proposal-results"]').innerText()).includes('执行失败'), 'Failed action remains explicit')
  await page.getByRole('button', { name: '收起动作结果', exact: true }).click()
  check(await countPapers() === 0, 'Motion Off dismisses the receipt immediately')
  await page.waitForTimeout(350)
  await page.evaluate(() => window.__companionUiProbe.render())
  check(await countPapers() === 0, 'Rerender does not revive a dismissed receipt')
} finally {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await page.evaluate(() => {
    const probe = window.__companionUiProbe
    if (!probe) { document.querySelectorAll('[data-companion-ui-probe]').forEach(node => node.remove()); return }
    probe.root.unmount()
    probe.node.remove()
    probe.floating.dataset.motion = probe.motion
    delete window.__companionUiProbe
    document.querySelectorAll('[data-companion-ui-probe]').forEach(node => node.remove())
  }).catch(() => {})
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
