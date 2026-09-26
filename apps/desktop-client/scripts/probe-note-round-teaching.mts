import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import './load-capture-env.mjs'
import { dismissBlockingDialogs } from './probe-support.mts'

/**
 * 真窗口剧本：**笔记页的教学面**（39d W4-6 刀二，判据是设计件 §3 的四步：
 * 问题 / 解释 / 引用 / 收尾）。
 *
 * 为什么必须真窗口：jsdom 里那句解释是我自己拼的替身，"屏上那句话就是库里存的那一条"
 * 结构上不可能被证伪（同 W4-3 那张表单的理由）；"依据点开真的把某一段带到眼前"
 * 更是只有布局与滚动才谈得上——jsdom 没有布局，`scrollIntoView` 根本不存在。
 *
 * 只挑**没有活动目标**的笔记（表单的渲染条件），起点必须没有进行中的轮次。
 * 收尾只把轮次推进终态，**行留在库里**（轮次与教学产物都是历史），所以共享 dev 库
 * 要清干净得显式删——见 finally 里那段（两张表都是只追加，得带 `app.allow_history_mutation`
 * 绕行口子才删得掉）。
 *
 * 跑法（先 `npm run build`）：
 *   PROBE_ALLOW_DB=1 PROBE_NOTE_HINT="<书库里唯一的那句标题>" \
 *     node --experimental-strip-types scripts/probe-note-round-teaching.mts
 */
const appRoot = resolve(import.meta.dirname, '..')
const installedElectron = resolve(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const workspaceElectron = resolve(appRoot, '../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const executablePath = existsSync(installedElectron) ? installedElectron : workspaceElectron
const NOTE_HINT = process.env.PROBE_NOTE_HINT ?? ''

if (!process.env.OWNER_EMAIL?.trim() || !process.env.OWNER_PASSWORD) {
  throw new Error('本剧本要真账号：请在仓库根 .env 里给 OWNER_EMAIL / OWNER_PASSWORD')
}
if (process.env.PROBE_ALLOW_DB !== '1' || NOTE_HINT.length === 0) {
  throw new Error('本剧本会直接改 dev 库：必须同时给 PROBE_ALLOW_DB=1 与 PROBE_NOTE_HINT')
}
if (/['";]/.test(NOTE_HINT)) {
  throw new Error('PROBE_NOTE_HINT 里不许有引号、分号或注释符')
}

const sql = (statement: string): string => execFileSync(
  'docker', ['exec', 'ailearn-dev-postgres-1', 'psql', '-U', 'ailearn', '-d', 'ailearn', '-tAc', statement],
  { encoding: 'utf8' },
).trim()

const results: Array<{ name: string; ok: boolean; detail: unknown }> = []
const readings: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail: unknown = ''): void => {
  results.push({ name, ok, detail })
}

const userDataDir = await mkdtemp(resolve(tmpdir(), 'ailearn-w46-probe-'))
const app = await electron.launch({
  args: ['.', '--lang=zh-CN', `--user-data-dir=${userDataDir}`],
  cwd: appRoot,
  executablePath,
})

let noteId = ''
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const emailInput = page.locator('.desktop-access-gate input[type="email"]')
  if (await emailInput.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await emailInput.fill(process.env.OWNER_EMAIL ?? '')
    await page.locator('.desktop-access-gate input[type="password"]').fill(process.env.OWNER_PASSWORD ?? '')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.waitForTimeout(2_500)
  await dismissBlockingDialogs(page)

  const expandRail = page.getByRole('button', { name: '展开目录' })
  if ((await expandRail.count()) > 0) {
    await expandRail.first().click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  await page.locator('.hud-rail .nav-chip[aria-label="笔记"]').first().click({ timeout: 20_000 })
  await page.locator('.note-shelf-all').first().click({ timeout: 20_000 })

  // 起点：唯一命中一篇笔记、而且它现在没有进行中的轮次（有残留就拒跑，不接着别人的轮次演）。
  const hintRows = page.locator('.note-row', { hasText: NOTE_HINT })
  if ((await hintRows.count()) !== 1) {
    check('提示词只命中一篇笔记', false, `命中 ${await hintRows.count()} 行——歧义时什么都不碰`)
    report()
    throw new Error('probe note hint is ambiguous; refusing to write anything')
  }
  noteId = sql(`select id from notes where deleted_at is null and title = '${NOTE_HINT}'`)
  if (!/^[0-9a-f-]{36}$/.test(noteId)) {
    check('这句标题在库里只对应一篇', false, noteId)
    report()
    throw new Error('exact-title lookup did not resolve to exactly one note')
  }
  readings.noteId = noteId
  const rowsBefore = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
  readings.rowsBefore = rowsBefore
  if (rowsBefore !== 0) {
    check('起点这篇没有残留的轮次', false, `库里有 ${rowsBefore} 行——先清掉再跑（别的剧本留下的也算）`)
    report()
    throw new Error('residual rounds on the target note')
  }

  await hintRows.first().click()
  await page.locator('.notebook').first().waitFor({ timeout: 20_000 })
  const roundBlock = page.locator('.notebook-round').first()
  await page.locator('.notebook-objective').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  const objectiveBlock = page.locator('.notebook-objective:not(.notebook-round)')
  const noObjective = (await objectiveBlock.count()) === 0
  check('这一篇没有活动目标（所以摆的是那张表单）', noObjective, noObjective ? '' : '读到了主要动作那一行')
  if (!noObjective) {
    report()
    throw new Error('target note has an active objective; the light form is not rendered')
  }

  // ── 起步：点「从这篇的小节里另选一句」的第一颗（问句里点名一节，解释才有确定的目标）──
  const structureGroup = roundBlock.locator('.notebook-objective__choices').nth(1)
  const chipCount = await structureGroup.locator('button').count()
  readings.structureChipCount = chipCount
  if (chipCount > 0) {
    await structureGroup.locator('button').first().click({ timeout: 20_000 })
  } else {
    await page.getByRole('button', { name: '我完全不熟', exact: true }).click({ timeout: 20_000 })
  }
  const questionSent = (await page.locator('#notebook-round-question').inputValue()).trim()
  readings.questionSent = questionSent

  // ── 第一步「问题」：开一轮，屏上那一句必须来自服务端存下来的那一条 ──
  await page.getByRole('button', { name: '开始这一轮', exact: true }).click({ timeout: 20_000 })
  const started = await page
    .locator('.notebook-round', { hasText: '这一轮：' })
    .first()
    .waitFor({ timeout: 25_000 })
    .then(() => true, () => false)
  check('按「开始这一轮」之后屏上出现服务端那一条', started, await roundBlock.locator('p.notebook-note').allTextContents())
  if (!started) throw new Error('round was not opened; refusing the rest')
  const questionOnScreen = ((await roundBlock.locator('p.notebook-note').first().textContent()) ?? '').trim()
  const drivingQuestionInDb = sql(`select driving_question from note_learning_rounds where note_id = '${noteId}' and phase <> 'closed' order by created_at desc limit 1`)
  readings.questionOnScreen = questionOnScreen
  readings.drivingQuestionInDb = drivingQuestionInDb
  check('屏上那句问题与库里那一句是同一句', questionOnScreen === `这一轮：${drivingQuestionInDb}`, { questionOnScreen, drivingQuestionInDb })

  // ── 第二步「解释」：点「先讲讲这一节」→ 屏上那句必须等于库里那一条 ──
  await page.getByRole('button', { name: '先讲讲这一节', exact: true }).click({ timeout: 20_000 })
  const teachingText = page.locator('.notebook-round-teaching__text').first()
  const shown = await teachingText.waitFor({ timeout: 25_000 }).then(() => true, () => false)
  check('点「先讲讲这一节」之后屏上出现解释', shown, await roundBlock.textContent().catch(() => null))
  if (!shown) throw new Error('teaching was not generated; refusing the rest')
  const explanationOnScreen = ((await teachingText.textContent()) ?? '').trim()
  readings.explanationOnScreen = explanationOnScreen
  const explanationInDb = sql(`select content->>'explanation' from note_learning_round_teachings t join note_learning_rounds r on r.id = t.round_id where r.note_id = '${noteId}' order by t.ordinal desc limit 1`)
  readings.explanationInDb = explanationInDb
  check('屏上那句解释就是库里存的那一条（不是本机拼的）', explanationOnScreen === explanationInDb, { explanationOnScreen, explanationInDb })
  check('解释里没有 markdown 标记漏出来', !/[*#`_]/.test(explanationOnScreen), explanationOnScreen)
  // 解释是按**这一轮点名的那一节**讲的：问句里「」里的那一段必须出现在解释开头。
  const namedSection = (questionSent.match(/「(.+?)」/) ?? [])[1] ?? ''
  readings.namedSection = namedSection
  check('解释的取材来自问句点名的那一节', namedSection.length === 0 || explanationOnScreen.includes(`「${namedSection}」`), explanationOnScreen)
  const ordinalsInDb = sql(`select t.source_block_ordinals::text from note_learning_round_teachings t join note_learning_rounds r on r.id = t.round_id where r.note_id = '${noteId}' order by t.ordinal desc limit 1`)
  readings.sourceBlockOrdinalsInDb = ordinalsInDb
  // 依据那几颗与库里那个数组必须一一对得上（多一颗就是屏上多了一个库里没有的依据）。
  const chipLabels = await roundBlock.locator('.notebook-round-teaching__references button').allTextContents()
  readings.referenceChipLabels = chipLabels
  const ordinalCount = ordinalsInDb.replace(/^\{|\}$/g, '').split(',').filter((value) => value.trim().length > 0).length
  check('依据那几颗的条数与库里那个数组一致', chipLabels.length === ordinalCount, { chipLabels, ordinalsInDb })

  // ── 第三步「引用」：点一颗依据 → 那一段真的被带到眼前（真布局 + 真滚动）──
  if (chipLabels.length > 0) {
    const targetOrdinal = Number(ordinalsInDb.replace(/^\{|\}$/g, '').split(',')[0]?.trim() ?? '0')
    readings.targetOrdinal = targetOrdinal
    // 先把正文滚到底再点：不这么做，目标那一段本来就可能在视口里，
    // "它在那儿"与"点一下把它带过来了"就分不开（这条判据要的是后者）。
    const scrollState = await page.evaluate(() => {
      let node: HTMLElement | null = document.querySelector('.reading-body')
      while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement
      if (!node) return { scrolled: false, scrollTop: 0 }
      node.scrollTop = node.scrollHeight
      return { scrolled: true, scrollTop: Math.round(node.scrollTop) }
    })
    readings.scrollBeforeClick = scrollState
    await page.waitForTimeout(300)
    const rectOf = (ordinal: number) => page.evaluate((value) => {
      const node = document.querySelector(`[data-block-ordinal="${value}"]`)
      if (!node) return { found: false, visible: false, top: 0, bottom: 0, viewportHeight: window.innerHeight }
      const rect = node.getBoundingClientRect()
      return {
        found: true,
        focused: node.getAttribute('data-block-focused') === 'true',
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        viewportHeight: window.innerHeight,
      }
    }, ordinal)
    const before = await rectOf(targetOrdinal)
    readings.targetBeforeClick = before
    await roundBlock.locator('.notebook-round-teaching__references button').first().click({ timeout: 20_000 })
    await page.waitForTimeout(400)
    const after = await rectOf(targetOrdinal)
    readings.targetAfterClick = after
    check('点一颗依据之后那一段被标了出来', after.found === true && after.focused === true, after)
    check('那一段真的被带到视口里（真滚动，不是只在 DOM 里翻到）', after.visible === true, { before, after })
    check(
      '移动这件事是这一点造成的（点之前它不在视口里）',
      before.visible === false || (before.focused !== true && after.focused === true),
      { before, after },
    )
    // 高亮只是"我在这儿"：过期就撤。
    await page.waitForTimeout(2_600)
    const stillFocused = await page.evaluate((ordinal) => {
      const node = document.querySelector(`[data-block-ordinal="${ordinal}"]`)
      return node?.getAttribute('data-block-focused') ?? null
    }, targetOrdinal)
    readings.focusAfterExpiry = stillFocused
    check('高亮自己过期（不留"上次点到哪"）', stillFocused === null, stillFocused)
  } else {
    check('这一轮有依据可点（那一篇的小节里有可讲的正文）', false, 'chipLabels 为空')
  }

  // ── 第四步「收尾」：先到这里 → 那一行与教学面一起撤掉，库里那一轮是终态 ──
  await page.getByRole('button', { name: '先到这里', exact: true }).click({ timeout: 20_000 })
  const closed = await page
    .locator('.notebook-round', { hasText: '这一轮：' })
    .first()
    .waitFor({ state: 'detached', timeout: 25_000 })
    .then(() => true, () => false)
  check('「先到这里」之后那一行撤掉', closed, await roundBlock.textContent().catch(() => null))
  const teachingGone = (await page.locator('.notebook-round-teaching__text').count()) === 0
  check('教学面跟着那一轮一起撤掉（终态只读）', teachingGone)
  const closedInDb = sql(`select phase || '/' || coalesce(outcome, '-') from note_learning_rounds where note_id = '${noteId}' order by created_at desc limit 1`)
  readings.roundAfterClose = closedInDb
  check('库里那一轮是终态（closed/partial）', closedInDb === 'closed/partial', closedInDb)
  const teachingRows = sql(`select count(*) from note_learning_round_teachings t join note_learning_rounds r on r.id = t.round_id where r.note_id = '${noteId}'`)
  readings.teachingRowsAfterClose = teachingRows
  check('收尾不删教学产物（那是历史，只追加）', Number(teachingRows) === 1, teachingRows)
} finally {
  await app.close().catch(() => undefined)
  if (process.env.PROBE_ALLOW_DB === '1' && noteId.length > 0) {
    // 两张都是只追加的表：带绕行口子删这一篇的行（轮的级联会撞触发器，所以先删产物）。
    sql(`BEGIN; SELECT set_config('app.allow_history_mutation','on',true); DELETE FROM note_learning_round_teachings WHERE round_id IN (SELECT id FROM note_learning_rounds WHERE note_id = '${noteId}'); DELETE FROM note_learning_rounds WHERE note_id = '${noteId}'; COMMIT;`)
    readings.roundsLeftForNote = Number(sql(`select count(*) from note_learning_rounds where note_id = '${noteId}'`))
    readings.roundsLeftInDev = Number(sql('select count(*) from note_learning_rounds'))
  }
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
