import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**笔记页那张轻量定向表单**（39d W4-3 第三刀，§16.16 的实机读数）。
 *
 * 为什么必须真窗口：jsdom 那 6 条用例喂的是**我自己拼的轮次替身**（`roundRow()`），
 * 于是"屏上那句话来自服务端存下来的那一条"这件事在单测里**结构上不可能被证伪**——
 * 替身返回什么屏上就有什么。这里走真 IPC → 真网关 → 真 dev API → 真库：
 * 屏幕上出现的 `这一轮：…`、`这一句话已经改过 N 次。` 只能是服务端读回来的那一条。
 *
 * 只挑**没有活动目标、也没有进行中轮次**的那一篇（表单的渲染条件正是这个），
 * 且不伪造任何失败。收尾必须把这一轮按「先到这里」关掉；那只是把 phase 推到终态，
 * **行本身留在库里**（轮次是历史，这是产品合同），所以共享 dev 库要清干净得手动删
 * ——读数与删除方式记在 `39d` §19 那几行的"收尾"里。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_NOTE_HINT="<书库里唯一的那句标题>" PROBE_NOTE_ID=<uuid> \
 *     node --experimental-strip-types scripts/probe-note-round-form.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

/** 屏上那一行的原文（`这一轮：…` / `这一句话已经改过 N 次。`），读不到返回 null。 */
const roundLines = async (root: import('@playwright/test').Locator): Promise<string[]> =>
  (await root.locator('p.notebook-note').allTextContents()).map((text) => text.trim())

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w43-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  const gateVisible = await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)
  if (gateVisible) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  readings.gateWasVisible = gateVisible

  await dismissBlockingDialogs(page)

  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  // 起点必须是一篇"没有目标、也没有进行中轮次"的笔记：否则这一轮验的不是 §16.16
  // 那半句（无目标时才摆表单），而且会撞上"一句话被两扇门共用"的另一种屏幕。
  const noteHint = process.env.PROBE_NOTE_HINT?.trim() ?? ''
  if (noteHint.length === 0) {
    check('拿到目标笔记的标题提示词', false, '必须给 PROBE_NOTE_HINT（书库里唯一的那句标题）')
    throw new Error('PROBE_NOTE_HINT is required')
  }
  const hintRows = page.locator('.note-row', { hasText: noteHint })
  const hintCount = await hintRows.count()
  readings.noteHint = noteHint
  readings.noteHintMatches = hintCount
  if (hintCount !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${hintCount} 行——歧义时什么都不碰`)
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  const noteTitle = ((await hintRows.first().locator('strong').textContent()) ?? '').trim()
  readings.noteTitle = noteTitle
  await hintRows.first().click()
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })

  const roundBlock = page.locator('.notebook-round').first()
  const objectiveBlock = page.locator('.notebook-objective:not(.notebook-round)')
  // 先等投影**落定**再判"有没有"：这一块是笔记读回来之后另外两发（目标／那一轮）才画的，
  // 一次 `count()` 读到 0 可能是"没赶上"而不是"没有"——那正是我在这条判据上写下的同形陷阱。
  await page.locator('.notebook-objective').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  const noObjective = (await objectiveBlock.count()) === 0
  const blockPresent = (await roundBlock.count()) > 0
  const preLines = blockPresent ? await roundLines(roundBlock) : []
  readings.preexistingRoundLines = preLines
  check('这一篇没有活动目标（所以摆的是那张表单）', noObjective, noObjective ? '' : '读到了主要动作那一行')
  check('笔记页摆了轻量定向这一块', blockPresent, '读不到 .notebook-round')
  check('起点没有进行中的轮次（不接着别人的那一轮改）', preLines.every((line) => !line.startsWith('这一轮：')), preLines)
  if (!noObjective || !blockPresent || preLines.some((line) => line.startsWith('这一轮：'))) {
    report()
    throw new Error('target note is not a clean no-objective, no-round note')
  }

  // 1) 点预设 → 起步句必须带上这篇的标题（不是一句通用口号）
  await page.getByRole('button', { name: '我完全不熟', exact: true }).click({ timeout: 20_000 })
  const input = page.locator('#notebook-round-question')
  const starter = (await input.inputValue()).trim()
  readings.starter = starter
  check('点预设放进输入框的那句话带着标题', starter.includes(noteTitle), starter)

  // 2) 空句子开不出一轮：把输入框清空，按钮应当禁用（这一条在 jsdom 里测过，
  //    这里是证明真窗口里也是同一颗 disabled，不是测试替身的形状）
  await input.fill('')
  const startButton = page.getByRole('button', { name: '开始这一轮', exact: true })
  const disabledWhenEmpty = await startButton.isDisabled()
  check('句子为空时「开始这一轮」是禁用的', disabledWhenEmpty)
  await input.fill(starter)

  // 1b) 「从这篇的结构里另选一句」（§16.16 第二半）：颗上的字必须真是纸上某一节的标题，
  //     点它 = 把带这节名字的问话放进输入框。这一篇有 9 处小节（DB 里数过），所以这一组必须在。
  const choicesGroups = roundBlock.locator('.notebook-objective__choices')
  const structureGroup = choicesGroups.nth(1)
  const chipCount = await structureGroup.locator('button').count()
  readings.structureChipCount = chipCount
  readings.structureLineShown = ((await roundBlock.locator('p.notebook-note').nth(1).textContent().catch(() => '')) ?? '').trim()
  check('有小节的这篇摆出了"从小节里另选"那一组', chipCount > 0, chipCount)
  const chipLabel = chipCount > 0 ? (((await structureGroup.locator('button').first().textContent()) ?? '').trim()) : ''
  const paperHeadings = (await page.locator('.reading-body h3').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim())
  // 那颗上写的必须是**纸上某一节显示出来的字**（超 24 字截断，与判据同一条规则）。
  const shorten = (text: string): string => (text.length > 24 ? `${text.slice(0, 24)}…` : text)
  check(
    '那颗上写的字就是纸上某一节的标题（不是另拼的一份）',
    paperHeadings.some((heading) => shorten(heading) === chipLabel),
    { chipLabel, paperHeadings },
  )
  check('那颗上没有 markdown 标记', !/[*_[\]]/.test(chipLabel), chipLabel)

  await structureGroup.locator('button').first().click({ timeout: 20_000 })
  const questionSent = (await input.inputValue()).trim()
  readings.questionSent = questionSent
  check(
    '点一颗放进来的就是"带这节名字"的那句问话',
    questionSent.startsWith('先弄懂「') && questionSent.includes(chipLabel.replace(/…$/, '')),
    questionSent,
  )

  const noteVersionBefore = await readNoteVersionLabel(page)
  readings.noteVersionBefore = noteVersionBefore

  // 2) 开一轮
  await startButton.click({ timeout: 20_000 })
  const started = await page
    .locator('.notebook-round', { hasText: '这一轮：' })
    .first()
    .waitFor({ timeout: 25_000 })
    .then(() => true, () => false)
  readings.started = started
  check('按「开始这一轮」之后屏上出现服务端那一条', started, await roundLines(roundBlock))
  if (!started) throw new Error('round was not opened; refusing the rest')

  const afterCreate = await roundLines(roundBlock)
  readings.linesAfterCreate = afterCreate
  check(
    '屏上那句就是送上去的那句（不是本机草稿的另一版）',
    afterCreate.includes(`这一轮：${questionSent}`),
    afterCreate,
  )
  check('新开的一轮应当"没改过"', afterCreate.includes('这一句话已经改过 0 次。'), afterCreate)

  // 4) 换一个问题：进编辑态 → 改半句 → 交上去
  await page.getByRole('button', { name: '换一个问题', exact: true }).click({ timeout: 20_000 })
  const editInput = page.locator('#notebook-round-question')
  await editInput.waitFor({ timeout: 20_000 })
  const prefilled = (await editInput.inputValue()).trim()
  readings.prefilledOnRevise = prefilled
  check('进编辑态时输入框里是服务端那一条', prefilled === questionSent, prefilled)

  // 「空闲时那颗按钮写的是什么」——这一条测的是文案本身：正在进行中才许写"正在…"。
  const idleSubmitLabel = ((await page
    .locator('.notebook-round button.primary')
    .first()
    .textContent()) ?? '').trim()
  readings.idleSubmitLabelWhileRevising = idleSubmitLabel
  check('空闲时那颗提交按钮不许写"正在…"', !idleSubmitLabel.startsWith('正在'), idleSubmitLabel)

  const rewritten = `${questionSent.slice(0, 12)}，以及它为什么值得记`
  await editInput.fill(rewritten)
  await page.locator('.notebook-round button.primary').first().click({ timeout: 20_000 })
  const revisedShown = await page
    .locator('.notebook-round', { hasText: `这一轮：${rewritten}` })
    .first()
    .waitFor({ timeout: 25_000 })
    .then(() => true, () => false)
  const afterRevise = await roundLines(roundBlock)
  readings.linesAfterRevise = afterRevise
  readings.revisedQuestion = rewritten
  check('改写之后屏上换成新的那一条', revisedShown, afterRevise)
  check('改过一次之后应当报"改过 1 次"', afterRevise.includes('这一句话已经改过 1 次。'), afterRevise)

  // 5) 收尾：终态只读，屏上那一行撤掉、表单回到空句子
  await page.getByRole('button', { name: '先到这里', exact: true }).click({ timeout: 20_000 })
  const closed = await page
    .locator('.notebook-round', { hasText: '这一轮：' })
    .first()
    .waitFor({ state: 'detached', timeout: 25_000 })
    .then(() => true, () => false)
  check('「先到这里」之后那一行撤掉（回到空表单）', closed, await roundLines(roundBlock))
  const backToForm = (await page.locator('#notebook-round-question').count()) > 0
  check('收尾后表单自己回来了（这一篇可以马上再开一轮）', backToForm)

  // 6) 开轮次不该动笔记本身：笔记版本号必须一个字都不变（轮次引用快照，不是编辑）
  const noteVersionAfter = await readNoteVersionLabel(page)
  readings.noteVersionAfter = noteVersionAfter
  check(
    '开一轮没有产生新的笔记版本',
    noteVersionBefore !== null && noteVersionBefore === noteVersionAfter,
    `${String(noteVersionBefore)} → ${String(noteVersionAfter)}`,
  )

  // 7) §10.3 那一块：刚收尾的那一轮要出现在**这一篇的记录**里，
  //    而且"开过 N 轮"那个 N 必须等于屏上行数（报一个屏上没有的数就是假总数）。
  const history = page.locator('.notebook-round-history').first()
  const historyShown = (await history.count()) > 0
  const rows = historyShown
    ? await history.locator('.notebook-round-history__list > li').allTextContents()
    : []
  readings.historyRowCount = rows.length
  readings.historyLead = historyShown ? (((await history.locator('p').first().textContent()) ?? '').trim()) : ''
  check('收尾之后那一块出现在这一篇的笔记页上', historyShown, readings.historyLead)
  const closedRow = rows.find((row) => row.includes(rewritten)) ?? ''
  check('记录里有刚收尾的那一轮，且带着终态那一格', closedRow.includes('先到这里'), { rows, closedRow })
  const leadCount = Number((readings.historyLead.match(/开过 (\d+) 轮/) ?? [])[1] ?? '-1')
  check('那句「开过 N 轮」的 N 就是屏上的行数', leadCount === rows.length, { lead: readings.historyLead, rows: rows.length })
  // 三格（日期 / 状态 / 问题）在**同一行**上：这一条只有真窗口量得出来（jsdom 没有布局）。
  const sameLine = await history.evaluate((block) => {
    const spans = Array.from(block.querySelectorAll('.notebook-round-history__list li:first-child > span'))
    const tops = spans.map((span) => Math.round(span.getBoundingClientRect().top))
    return { spans: spans.length, distinctTops: [...new Set(tops)].length }
  })
  readings.rowSpansOnOneLine = sameLine
  check('那一行的三格排在同一行（样式真接上了）',
    sameLine.spans === 3 && sameLine.distinctTops === 1,
    sameLine)
} finally {
  await app.close().catch(() => undefined)
}

/** 纸上那枚「版本 vN」；读不到返回 null（只记读数，不当判据）。 */
async function readNoteVersionLabel(page: import('@playwright/test').Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const match = (document.body.textContent ?? '').match(/版本 v(\d+)/)
      return match ? Number(match[1]) : null
    })
    .catch(() => null)
}

function report(): void {
  const failed = results.filter((entry) => !entry.ok)
  for (const entry of results) {
  process.stdout.write(`${entry.ok ? 'ok  ' : 'RED '} ${entry.name}  ${entry.ok ? '' : JSON.stringify(entry.detail)}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
process.stdout.write(`\n实测读数：\n${JSON.stringify(readings, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
}
report()
